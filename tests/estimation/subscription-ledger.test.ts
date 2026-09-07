import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openSubscriptionLedger } from "../../src/estimation/subscription-ledger.js";
const paths: string[] = [];
const owners: { close(): Promise<void> }[] = [];
const limits = { maxStarts: 2, maxKnownTokens: 100 };
async function directory() { const p = await mkdtemp(join(tmpdir(), "hud-sub-ledger-")); paths.push(p); return p; }
async function open(p: string) { const l = await openSubscriptionLedger(p, limits); owners.push(l); return l; }
afterEach(async () => { for (const l of owners.splice(0)) await l.close(); for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true }); });
const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 5 };
it('durably cancels a live unlaunched reservation without inventing provider usage or refunding starts',async()=>{
  const path=await directory(),ledger=await open(path),id=(await ledger.reserve())!;
  await ledger.cancelBeforeDispatch(id);
  expect(ledger.snapshot()).toEqual({starts:1,knownTokens:0,unresolved:0,unknown:0});
  await expect(ledger.cancelBeforeDispatch(id)).rejects.toThrow();await ledger.close();
  const rows=(await readFile(join(path,'subscription-usage.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.at(-1)).toEqual({type:'not_dispatched',id});
  const reopened=await open(path);expect(reopened.snapshot()).toEqual({starts:1,knownTokens:0,unresolved:0,unknown:0});
  const second=(await reopened.reserve())!;await reopened.cancelBeforeDispatch(second);
  expect(await reopened.reserve()).toBeNull();
});
it('cannot classify a recovered unresolved reservation as unlaunched',async()=>{
  const path=await directory(),ledger=await open(path),id=(await ledger.reserve())!;await ledger.close();
  const reopened=await open(path);await expect(reopened.cancelBeforeDispatch(id)).rejects.toThrow();
  expect(reopened.snapshot()).toMatchObject({starts:1,unresolved:1,unknown:0});
  expect(await reopened.reserve()).toBeNull();
});
it("serializes admission and does not count cached input twice", async () => {
  const l = await open(await directory()); const [a,b] = await Promise.all([l.reserve(), l.reserve()]);
  expect(a).toMatch(/^[0-9a-f-]{36}$/); expect(b).toBeNull();
  await l.settle(a!, usage); expect(l.snapshot()).toEqual({ starts:1, knownTokens:12, unresolved:0, unknown:0 });
});
it("retains request limits across reopen", async () => {
  const p=await directory(); const l=await open(p); await l.settle((await l.reserve())!,usage); await l.close();
  const r=await open(p); await r.settle((await r.reserve())!,usage); expect(await r.reserve()).toBeNull();
});
it("retains unresolved reservations and unknown usage", async () => {
  const p=await directory(); const l=await open(p); const id=(await l.reserve())!; await l.close();
  const r=await open(p); expect(await r.reserve()).toBeNull(); await r.settle(id,null);
  expect(await r.reserve()).toBeNull(); expect(r.snapshot().unknown).toBe(1);
  await r.close(); const again=await open(p); expect(await again.reserve()).toBeNull();
});
it("rejects invalid and duplicate settlement without corrupting totals", async () => {
  const l=await open(await directory()); const id=(await l.reserve())!;
  await expect(l.settle(id,{...usage,inputTokens:-1})).rejects.toThrow();
  await expect(l.settle(id,{...usage,cachedInputTokens:11})).rejects.toThrow();
  await l.settle(id,usage); await expect(l.settle(id,usage)).rejects.toThrow();
  expect(l.snapshot().knownTokens).toBe(12);
});
it("blocks new starts after token threshold while preserving the actual excess", async () => {
  const l=await open(await directory()); await l.settle((await l.reserve())!,{inputTokens:100,outputTokens:8,cachedInputTokens:null});
  expect(await l.reserve()).toBeNull(); expect(l.snapshot().knownTokens).toBe(108);
});
it("excludes another owner and refuses changed limits", async () => {
  const p=await directory(); const l=await open(p); await expect(open(p)).rejects.toThrow(); await l.close();
  await expect(openSubscriptionLedger(p,{...limits,maxStarts:3})).rejects.toThrow();
});
it("rejects partial journal without overwriting evidence", async () => {
  const p=await directory(); const l=await open(p); await l.reserve(); await l.close();
  const file=join(p,"subscription-usage.jsonl"); await appendFile(file,'{"partial');
  const before=await readFile(file,"utf8"); await expect(open(p)).rejects.toThrow();
  expect(await readFile(file,"utf8")).toBe(before);
});
it("does not reserve or settle after close", async () => {
  const l=await open(await directory()); const id=(await l.reserve())!; await l.close();
  expect(await l.reserve()).toBeNull(); await expect(l.settle(id,usage)).rejects.toThrow();
});
it("drains a settlement submitted before close", async () => {
  const p=await directory(); const l=await open(p); const id=(await l.reserve())!;
  const settled=l.settle(id,usage); const closed=l.close();
  await expect(settled).resolves.toBeUndefined(); await closed;
  const r=await open(p); expect(r.snapshot()).toEqual({starts:1,knownTokens:12,unresolved:0,unknown:0});
});
it("allows correct reopening after a read-only limits mismatch", async () => {
  const p=await directory(); const l=await open(p); await l.close();
  await expect(openSubscriptionLedger(p,{...limits,maxStarts:3})).rejects.toThrow();
  const r=await open(p); expect(r.snapshot().starts).toBe(0);
});
