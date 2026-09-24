import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openSubscriptionLedger } from "../../src/estimation/subscription-ledger.js";
import { createOwnedProcessRunner } from "../../src/estimation/owned-process.js";
import {ObserverPreDispatchTransient} from '../../src/estimation/observer-call-failure.js';
import { createSubscriptionSession, createObserverSubscriptionSession } from "../../src/estimation/subscription-session.js";
import {randomUUID} from 'node:crypto';
import type {Invocation} from '../../src/estimation/owned-process.js';
import type {InvocationRecord, InvocationRecordPatch} from '../../src/estimation/invocation-ownership.js';

const metrics={activeSeconds:20,progress:0.5,toolCount:2,validationFailures:0};
const observerInput = {goalSummary: null, activeSeconds: 20, runtime: 'running',
  messages: [{kind: 'user', text: 'Build a report password=private', truncated: false}], truncated: false};
const interpretation = {relation: 'replace', status: 'running', summary: 'Build a report',
  estimate: {remainingSeconds: 7200, errorPercent: 40}};
const paths:string[]=[], closers:Array<()=>Promise<void>>=[];
const signal=()=>new AbortController().signal;
const stream=(prediction:unknown={lowSeconds:5,highSeconds:10},includeUsage=true)=>[
  {type:"turn.started"}, {type:"item.completed",item:{id:"item_1",type:"agent_message",text:JSON.stringify(prediction)}},
  {type:"turn.completed",...(includeUsage?{usage:{input_tokens:20,output_tokens:3,cached_input_tokens:5}}:{})}
].map(e=>JSON.stringify(e)).join("\n")+"\n";
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
async function setup(code=`process.stdout.write(${JSON.stringify(stream())})`) {
  const path=await mkdtemp(join(tmpdir(),"hud-sub-session-")); paths.push(path);
  const ledger=await openSubscriptionLedger(path,{maxStarts:6,maxKnownTokens:50000});
  const runner=createOwnedProcessRunner({timeoutMs:1000});
  const prepare=()=>({executable:process.execPath,cwd:path,args:["-e",code],env:process.env,input:""});
  closers.push(()=>ledger.close());
  return {path,ledger,runner,prepare};
}
function session(deps:Parameters<typeof createSubscriptionSession>[0]) {
  const value=createSubscriptionSession(deps); closers.push(()=>value.close()); return value;
}
afterEach(async()=>{
  for(const close of closers.splice(0).reverse()) await close().catch(()=>undefined);
  for(const path of paths.splice(0)) await rm(path,{recursive:true,force:true});
});

it('settles known observer usage even when its answer is semantically invalid',async()=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream({invalid:true}))})`);
  const s=createObserverSubscriptionSession({...d,authorize:()=>true});closers.push(()=>s.close());
  const result=await s.observe(observerInput,signal());
  expect(result).toMatchObject({status:'process_error',interpretation:null,usage:{inputTokens:20,outputTokens:3},
    outcomes:{prediction:'invalid',call:'success',usage:'known',framingValid:true,closureConfirmed:true}});
  expect(d.ledger.snapshot()).toMatchObject({starts:1,knownTokens:23,unknown:0});
});

it('reports preparation failure without exposing the exception or implying dispatch',async()=>{
  const d=await setup();
  const s=createObserverSubscriptionSession({...d,authorize:()=>true,prepare:()=>{throw Error('SECRET configuration');}});
  closers.push(()=>s.close());
  const result=await s.observe(observerInput,signal());
  expect(result.outcomes).toMatchObject({preparationFailed:true,dispatch:'not_started'});
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(d.ledger.snapshot().starts).toBe(0);
});

it('preserves timeout reason without retaining process output',async()=>{
  const d=await setup('setInterval(()=>{},1000)');
  const s=createObserverSubscriptionSession({...d,authorize:()=>true});closers.push(()=>s.close());
  const result=await s.observe(observerInput,signal());
  expect(result.outcomes).toMatchObject({processReason:'timeout',call:'timeout',closureConfirmed:true});
});

it.each([true,false])('only trusted pre-dispatch transient failures authorize retry (trusted=%s)',async trusted=>{
  const d=await setup();
  const s=createObserverSubscriptionSession({...d,authorize:()=>true,prepare:()=>{
    throw trusted?new ObserverPreDispatchTransient():new Error('OBSERVER_PRE_DISPATCH_TRANSIENT');
  }});closers.push(()=>s.close());
  const value=await s.observe(observerInput,signal());
  expect(value.status).toBe('process_error');expect(d.ledger.snapshot().starts).toBe(0);
  expect(value.outcomes?.retryable).toBe(trusted?'pre_dispatch_transient':undefined);
  if(trusted)expect(value.outcomes).toMatchObject({dispatch:'not_started',closureConfirmed:true});
});

it('records nonnegative monotonic preparation, provider and settlement durations without prompt data',async()=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream(interpretation))})`);
  const s=createObserverSubscriptionSession({...d,authorize:()=>true});closers.push(()=>s.close());
  const result=await s.observe(observerInput,signal());
  expect(result.timings).toEqual({preparationMs:expect.any(Number),providerMs:expect.any(Number),settlementMs:expect.any(Number),deliveryMs:0,totalMs:expect.any(Number)});
  const t=result.timings!;
  expect(Object.values(t).every(value=>Number.isSafeInteger(value)&&value>=0)).toBe(true);
  expect(t.totalMs).toBeGreaterThanOrEqual(t.preparationMs);
  expect(t.totalMs).toBeGreaterThanOrEqual(t.providerMs);
  expect(t.totalMs).toBeGreaterThanOrEqual(t.settlementMs);
});

it('retains a safely framed observer estimate with unknown usage but blocks another start',async()=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream(interpretation,false))})`);
  const s=createObserverSubscriptionSession({...d,authorize:()=>true});closers.push(()=>s.close());
  expect(await s.observe(observerInput,signal())).toMatchObject({status:'interpreted',interpretation,usage:null,
    outcomes:{prediction:'numeric',call:'success',usage:'unknown',framingValid:true,closureConfirmed:true}});
  expect(d.ledger.snapshot()).toMatchObject({starts:1,knownTokens:0,unknown:1});
  expect(await s.observe(observerInput,signal())).toMatchObject({status:'disabled',interpretation:null});
  expect(d.ledger.snapshot().starts).toBe(1);
});

it.each(['disable','revoke','abort'])('discards unknown-usage estimates after %s during settlement',async action=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream(interpretation,false))})`);
  const entered=deferred<void>(),gate=deferred<void>(),controller=new AbortController();let authorized=true;
  const s=createObserverSubscriptionSession({...d,authorize:()=>authorized,
    ledger:{...d.ledger,settle:async(id,usage)=>{entered.resolve();await gate.promise;await d.ledger.settle(id,usage);}}});
  closers.push(()=>s.close());
  const pending=s.observe(observerInput,controller.signal);await entered.promise;
  if(action==='disable')s.disable();else if(action==='revoke')authorized=false;else controller.abort();
  gate.resolve();
  expect(await pending).toMatchObject({interpretation:null,usage:null});
  expect(d.ledger.snapshot()).toMatchObject({starts:1,unknown:1,unresolved:0});
  expect(await s.observe(observerInput,signal())).toMatchObject({status:'disabled',interpretation:null});
});

it('executes a rich observer through real owned stdin and settles usage in the existing ledger', async () => {
  const d = await setup();
  const code = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
    const parsed=JSON.parse(input);
    if(parsed.messages[0].text!==${JSON.stringify(observerInput.messages[0]!.text)})process.exit(9);
    process.stdout.write(${JSON.stringify(stream(interpretation))});
  });`;
  const s = createObserverSubscriptionSession({...d, authorize: () => true,
    prepare: input => ({executable: process.execPath, cwd: d.path, args: ['-e', code], env: process.env, input: JSON.stringify(input)})});
  closers.push(() => s.close());
  expect(await s.observe(observerInput, signal())).toMatchObject({status: 'interpreted', interpretation,
    outcomes: {prediction:'numeric',call:'success',usage:'known',framingValid:true,closureConfirmed:true,dispatch:'started'},
    usage: {kind: 'subscription-tokens', inputTokens: 20, outputTokens: 3, cachedInputTokens: 5}});
  expect(d.ledger.snapshot()).toEqual({starts: 1, knownTokens: 23, unknown: 0, unresolved: 0});
  expect(await readFile(join(d.path, 'subscription-usage.jsonl'), 'utf8')).not.toMatch(/Build a report|private/);
});

it('does not prepare or reserve a rich call without authorization', async () => {
  const d = await setup(); let preparations = 0;
  const s = createObserverSubscriptionSession({...d, authorize: () => false,
    prepare: () => {preparations++; return d.prepare();}});
  closers.push(() => s.close());
  expect(await s.observe(observerInput, signal())).toMatchObject({status: 'disabled', interpretation: null});
  expect(preparations).toBe(0);
  expect(d.ledger.snapshot().starts).toBe(0);
});

it('records not-dispatched without provider usage when authorization is revoked during durable admission', async () => {
  const d = await setup(), entered = deferred<void>(), gate = deferred<void>(); let authorized = true;
  const s = createObserverSubscriptionSession({...d, authorize: () => authorized,
    ledger: {...d.ledger, reserve: async () => {const id = await d.ledger.reserve(); entered.resolve(); await gate.promise; return id;}}});
  closers.push(() => s.close());
  const pending = s.observe(observerInput, signal()); await entered.promise;
  authorized = false; gate.resolve();
  expect(await pending).toMatchObject({status: 'disabled', interpretation: null,
    usage:null,outcomes:{usage:'not_dispatched',dispatch:'not_started',closureConfirmed:true}});
  expect(d.ledger.snapshot()).toEqual({starts: 1, knownTokens: 0, unknown: 0, unresolved: 0});
  expect(d.runner.status().active).toBe(false);
});

it('blocks additional rich calls after unknown model usage', async () => {
  const d = await setup(`process.stdout.write(${JSON.stringify(stream(interpretation, false))})`);
  const s = createObserverSubscriptionSession({...d, authorize: () => true}); closers.push(() => s.close());
  expect(await s.observe(observerInput, signal())).toMatchObject({status: 'interpreted', interpretation, usage: null,
    outcomes:{prediction:'numeric',call:'success',usage:'unknown',framingValid:true,closureConfirmed:true}});
  expect(d.ledger.snapshot().unknown).toBe(1);
  expect(await s.observe(observerInput, signal())).toMatchObject({status: 'disabled'});
});

it('discards interpretation after authorization revocation during settlement but retains known usage', async () => {
  const d = await setup(`process.stdout.write(${JSON.stringify(stream(interpretation))})`);
  const entered = deferred<void>(), gate = deferred<void>(); let authorized = true;
  const s = createObserverSubscriptionSession({...d, authorize: () => authorized,
    ledger: {...d.ledger, settle: async (id, usage) => {entered.resolve(); await gate.promise; await d.ledger.settle(id, usage);}}});
  closers.push(() => s.close());
  const pending = s.observe(observerInput, signal()); await entered.promise;
  authorized = false; gate.resolve();
  expect(await pending).toMatchObject({status: 'disabled', interpretation: null,
    usage: {inputTokens: 20, outputTokens: 3}});
  expect(d.ledger.snapshot()).toEqual({starts: 1, knownTokens: 23, unknown: 0, unresolved: 0});
});
it("reserves durably before execution and settles a real child's usage",async()=>{
  const d=await setup(); const s=session(d);
  expect(await s.estimate(metrics,signal())).toEqual({status:"estimated",prediction:{lowSeconds:5,highSeconds:10},
    usage:{kind:"subscription-tokens",inputTokens:20,outputTokens:3,cachedInputTokens:5}});
  expect(d.ledger.snapshot()).toEqual({starts:1,knownTokens:23,unknown:0,unresolved:0});
  const rows=(await readFile(join(d.path,"subscription-usage.jsonl"),"utf8")).trim().split("\n").map(x=>JSON.parse(x));
  expect(rows.map(r=>r.type??"header")).toEqual(["header","reserve","settle"]);
});
it("retains unavailable prediction as distinct from failure",async()=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream({lowSeconds:null,highSeconds:null}))})`);
  expect(await session(d).estimate(metrics,signal())).toMatchObject({status:"unavailable",prediction:null});
  expect(d.ledger.snapshot().knownTokens).toBe(23);
});
it("unknown usage blocks all later starts",async()=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream({},false))})`),s=session(d);
  expect(await s.estimate(metrics,signal())).toMatchObject({status:"process_error",prediction:null,usage:null});
  expect(d.ledger.snapshot()).toMatchObject({starts:1,unknown:1});
  expect(await s.estimate(metrics,signal())).toMatchObject({status:"disabled"});
});
it("invalid metrics and pre-abort never reserve",async()=>{
  const d=await setup(),s=session(d),c=new AbortController(); c.abort();
  expect(await s.estimate(metrics,c.signal)).toMatchObject({status:"aborted"});
  expect(await s.estimate({...metrics,prompt:"private"},signal())).toMatchObject({status:"invalid_input"});
  expect(d.ledger.snapshot().starts).toBe(0);
});
it("cancellation during admission cannot launch a late child",async()=>{
  const d=await setup(),gate=deferred<string|null>(),entered=deferred<void>();
  const s=session({...d,ledger:{...d.ledger,reserve:async()=>{const id=await d.ledger.reserve(); entered.resolve(); return gate.promise.then(()=>id);}}});
  const c=new AbortController(),pending=s.estimate(metrics,c.signal); await entered.promise;
  expect(await s.estimate(metrics,signal())).toMatchObject({status:"busy"});
  c.abort(); gate.resolve(null);
  expect(await pending).toMatchObject({status:"aborted",prediction:null});
  expect(d.ledger.snapshot()).toEqual({starts:1,knownTokens:0,unknown:0,unresolved:0});
  expect(d.runner.status().active).toBe(false);
});
it("close drains pending admission before closing the ledger",async()=>{
  const d=await setup(),gate=deferred<void>(),entered=deferred<void>();
  const s=session({...d,ledger:{...d.ledger,reserve:async()=>{const id=await d.ledger.reserve();entered.resolve();await gate.promise;return id;}}});
  const pending=s.estimate(metrics,signal()); await entered.promise;
  const closing=s.close(); gate.resolve();
  expect(await pending).toMatchObject({status:"disabled"}); await closing;
  expect(d.ledger.snapshot()).toEqual({starts:1,knownTokens:0,unknown:0,unresolved:0});
});
it("nonzero exit suppresses prediction but preserves reported usage",async()=>{
  const d=await setup(`process.stdout.write(${JSON.stringify(stream())},()=>process.exit(3))`);
  expect(await session(d).estimate(metrics,signal())).toMatchObject({status:"process_error",prediction:null,usage:{inputTokens:20,outputTokens:3}});
  expect(d.ledger.snapshot().knownTokens).toBe(23);
});
it("preparation failure avoids reservation and sanitizes the error",async()=>{
  const d=await setup(),s=session({...d,prepare:()=>{throw Error("private config");}});
  expect(await s.estimate(metrics,signal())).toEqual({status:"process_error",prediction:null,usage:null});
  expect(d.ledger.snapshot().starts).toBe(0);
});
it("settlement failure closes admission without returning a usable prediction",async()=>{
  const d=await setup(),s=session({...d,ledger:{...d.ledger,settle:async()=>{throw Error("private journal path");}}});
  expect(await s.estimate(metrics,signal())).toMatchObject({status:"accounting_error",prediction:null});
  expect(await s.estimate(metrics,signal())).toMatchObject({status:"disabled"});
  expect(d.ledger.snapshot().unresolved).toBe(1);
});
it("the executing child can observe its durable reservation",async()=>{
  const code=`const fs=require('node:fs'); const rows=fs.readFileSync('subscription-usage.jsonl','utf8').trim().split('\\n').map(JSON.parse); if(rows.at(-1).type!=='reserve') process.exit(8); process.stdout.write(${JSON.stringify(stream())});`;
  const d=await setup(code);
  expect(await session(d).estimate(metrics,signal())).toMatchObject({status:"estimated"});
});
it("canceling a running child suppresses output and settles unknown",async()=>{
  const d=await setup('process.stdout.write(" "); setInterval(()=>{},1000)'),entered=deferred<void>();
  const original=d.runner.run;
  const s=session({...d,runner:{...d.runner,run:(invocation,sig)=>{
    const result=original(invocation,sig); entered.resolve(); return result;
  }}});
  const c=new AbortController(),pending=s.estimate(metrics,c.signal); await entered.promise; c.abort();
  expect(await pending).toMatchObject({status:"aborted",prediction:null,usage:null});
  expect(d.runner.status().active).toBe(false);
  expect(d.ledger.snapshot()).toMatchObject({unknown:1,unresolved:0});
});
it("cancellation during settlement discards prediction but records the completed usage",async()=>{
  const d=await setup(),entered=deferred<void>(),gate=deferred<void>();
  const s=session({...d,ledger:{...d.ledger,settle:async(id,usage)=>{entered.resolve();await gate.promise;await d.ledger.settle(id,usage);}}});
  const c=new AbortController(),pending=s.estimate(metrics,c.signal); await entered.promise;
  expect(await s.estimate(metrics,signal())).toMatchObject({status:"busy"});
  c.abort();gate.resolve();
  expect(await pending).toMatchObject({status:"aborted",prediction:null,usage:{inputTokens:20,outputTokens:3}});
  expect(d.ledger.snapshot()).toMatchObject({knownTokens:23,unresolved:0,unknown:0});
});
it("close during settlement drains durable accounting and never returns an estimate",async()=>{
  const d=await setup(),entered=deferred<void>(),gate=deferred<void>();
  const s=session({...d,ledger:{...d.ledger,settle:async(id,usage)=>{entered.resolve();await gate.promise;await d.ledger.settle(id,usage);}}});
  const pending=s.estimate(metrics,signal());await entered.promise;
  const closing=s.close();gate.resolve();
  expect(await pending).toMatchObject({status:"disabled",prediction:null});await closing;
  expect(d.ledger.snapshot()).toMatchObject({knownTokens:23,unresolved:0});
});

it.skipIf(process.platform !== 'win32')('binds durable ownership before a real child and records each lifecycle phase', async () => {
  const d = await setup(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(stream(interpretation))}))`);
  const bound: InvocationRecord[] = [], updates: InvocationRecordPatch[] = [];
  let observed: Invocation | undefined;
  let record: InvocationRecord = {
    admissionId: randomUUID(), conversationKey: 'ownership-test', turnGeneration: 7,
    ownerUuid: randomUUID(), providerKind: 'subscription', phase: 'bound', deadline: Date.now() + 60_000,
    cleanupOutcome: 'pending',
  };
  const ledger = {
    ...d.ledger,
    reserve: async () => { const id = await d.ledger.reserve(); if (!id) throw new Error('TEST_RESERVE_FAILED'); record = {...record, admissionId: id}; return id; },
    bindInvocation: async (_id: string, value: InvocationRecord) => { bound.push({...value}); },
    updateInvocation: async (_id: string, patch: InvocationRecordPatch) => { updates.push({...patch}); },
  };
  const identityRunner=createOwnedProcessRunner({timeoutMs:15000});
  const runner = {
    ...identityRunner,
    run: async (...args: Parameters<typeof d.runner.run>) => { observed = args[0]; return identityRunner.run(...args); },
  };
  const s = createObserverSubscriptionSession({ledger, runner, prepare: d.prepare, authorize: () => true,
    invocationRecord: () => ({...record})});
  closers.push(() => s.close());
  await expect(s.observe(observerInput, signal())).resolves.toMatchObject({status: 'interpreted'});
  expect(bound).toEqual([record]);
  expect(observed?.ownership).toEqual(record);
  expect(updates).toEqual([
    {phase: 'dispatching'},
    {phase: 'dispatching', pid: expect.any(Number), creationIdentity: expect.stringMatching(/^\d+$/)},
    {phase: 'settling'},
    {phase: 'closed', cleanupOutcome: 'confirmed'},
  ]);
});

it('records unconfirmed cleanup when the runner reports a non-closed child', async () => {
  const d = await setup();
  const updates: InvocationRecordPatch[] = [];
  let record: InvocationRecord = {
    admissionId: randomUUID(), conversationKey: 'unconfirmed-test', turnGeneration: 1,
    ownerUuid: randomUUID(), providerKind: 'subscription', phase: 'bound', deadline: Date.now() + 60_000,
    cleanupOutcome: 'pending',
  };
  const runner = {
    ...d.runner,
    run: async () => ({reason: 'cleanup_timeout' as const, exitCode: null, closed: false, stdout: '', stderr: ''}),
  };
  const ledger = {
    ...d.ledger,
    reserve: async () => { const id = await d.ledger.reserve(); if (!id) throw new Error('TEST_RESERVE_FAILED'); record = {...record, admissionId: id}; return id; },
    bindInvocation: async () => undefined,
    updateInvocation: async (_id: string, patch: InvocationRecordPatch) => { updates.push({...patch}); },
  };
  const s = createObserverSubscriptionSession({ledger, runner, prepare: d.prepare, authorize: () => true,
    invocationRecord: () => ({...record})});
  closers.push(() => s.close());
  await expect(s.observe(observerInput, signal())).resolves.toMatchObject({status: 'process_error'});
  expect(updates.at(-1)).toEqual({phase: 'closed', cleanupOutcome: 'unconfirmed'});
});
