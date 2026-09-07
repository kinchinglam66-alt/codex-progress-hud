import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExperimentLedger } from "../../src/evaluation/experiment-ledger.js";
const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const config={budgetTokens:1000,reservationTokens:400,maxStarts:10,protocolHash:"a".repeat(64)};
async function setup(configuration=config) {
  const directory=await mkdtemp(join(tmpdir(),"hud-experiment-ledger-"));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const ledger=await openExperimentLedger(directory,configuration);
  cleanups.push(()=>ledger.close());
  return {ledger,directory};
}
it("reserves headroom across both lanes and counts cached tokens only once",async()=>{
  const {ledger}=await setup();
  const a=await ledger.reserve("sample_a","workload"), b=await ledger.reserve("sample_a","estimator");
  expect(a).not.toBeNull();expect(b).not.toBeNull();
  expect(await ledger.reserve("sample_b","workload")).toBeNull();
  await ledger.settle(a!,{inputTokens:250,outputTokens:100,cachedInputTokens:200});
  expect(await ledger.reserve("sample_b","workload")).toBeNull();
  await ledger.settle(b!,{inputTokens:10,outputTokens:10,cachedInputTokens:0});
  expect(ledger.snapshot()).toMatchObject({knownTokens:370,pending:0});
  expect(await ledger.reserve("sample_b","workload")).not.toBeNull();
});
it("preserves the same aggregate budget and unresolved admissions on reopening",async()=>{
  const {ledger,directory}=await setup();
  const id=await ledger.reserve("sample_a","workload");
  await ledger.close();
  const again=await openExperimentLedger(directory,config);cleanups.push(()=>again.close());
  expect(await again.reserve("sample_b","workload")).toBeNull();
  await again.settle(id!,null);
  expect(again.snapshot()).toMatchObject({unknown:1,pending:0});
  expect(await again.reserve("sample_b","workload")).toBeNull();
});
it("excludes concurrent owners and refuses duplicate settlement",async()=>{
  const {ledger,directory}=await setup();
  await expect(openExperimentLedger(directory,config)).rejects.toThrow();
  const id=await ledger.reserve("sample_a","workload");
  await ledger.settle(id!,{inputTokens:1,outputTokens:1,cachedInputTokens:null});
  await expect(ledger.settle(id!,{inputTokens:1,outputTokens:1,cachedInputTokens:null})).rejects.toThrow();
  expect(ledger.snapshot().knownTokens).toBe(2);
});
it("records reservation overruns honestly and stops further admission",async()=>{
  const {ledger}=await setup();const id=await ledger.reserve("sample_a","workload");
  await ledger.settle(id!,{inputTokens:401,outputTokens:0,cachedInputTokens:null});
  expect(ledger.snapshot()).toMatchObject({knownTokens:401,overrun:true});
  expect(await ledger.reserve("sample_b","workload")).toBeNull();
});
it("can conservatively charge an unknown reservation without inventing known usage or resetting budget",async()=>{
  const {ledger,directory}=await setup();
  const id=await ledger.reserve("sample_a","workload");await ledger.settle(id!,null);
  expect(await ledger.reserve("sample_b","workload")).toBeNull();
  await ledger.chargeUnknownReservation(id!);
  expect(ledger.snapshot()).toMatchObject({knownTokens:0,unknown:1,unreconciledUnknown:0,assumedTokens:400});
  await expect(ledger.chargeUnknownReservation(id!)).rejects.toThrow();
  await ledger.close();const reopened=await openExperimentLedger(directory,config);cleanups.push(()=>reopened.close());
  expect(reopened.snapshot()).toMatchObject({knownTokens:0,unknown:1,assumedTokens:400});
  expect(await reopened.reserve("sample_b","workload")).not.toBeNull();
  expect(await reopened.reserve("sample_c","estimator")).toBeNull();
});
it("appends the authorized budget amendment and replays it without resetting usage",async()=>{
  const {ledger,directory}=await setup();const id=await ledger.reserve("sample_a","workload");
  await ledger.settle(id!,{inputTokens:10,outputTokens:5,cachedInputTokens:0});
  await ledger.amendBudget(1500000,"user_20260906_1500000");
  await ledger.close();const again=await openExperimentLedger(directory,config);cleanups.push(()=>again.close());
  expect(again.snapshot()).toMatchObject({budgetTokens:1500000,knownTokens:15,starts:1});
});
it("changes future short-call headroom without discounting old unknown exposure",async()=>{
  const {ledger}=await setup({...config,budgetTokens:1000000,reservationTokens:160000});
  const old=await ledger.reserve("sample_old","estimator");await ledger.settle(old!,null);
  await ledger.amendReservation(16000);
  await ledger.chargeUnknownReservation(old!);
  const next=await ledger.reserve("sample_next","workload");await ledger.settle(next!,null);await ledger.chargeUnknownReservation(next!);
  expect(ledger.snapshot()).toMatchObject({assumedTokens:176000,reservationTokens:16000,knownTokens:0});
});
