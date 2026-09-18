import {expect, it, vi} from "vitest";
import {normalizeHookInput} from "../../src/hooks/schema.js";
import {PassiveContextStore} from "../../src/server/passive-context-store.js";
import {PassiveGoals} from "../../src/server/passive-goals.js";
import {createConversationSource} from "../../src/observer/conversation-source.js";
import type {HistoryRecord, HistorySnapshot} from "../../src/observer/history-snapshot.js";
import {createHistorySnapshot} from "../../src/observer/history-snapshot.js";
import type {ReadBatch} from "../../src/observer/conversation-record.js";
import {ObserverScheduler, type ObserverObservation, type ObserverWorker} from "../../src/estimation/observer-scheduler.js";
import type {ObserverInput} from "../../src/estimation/observer-contract.js";
import type {PreparedContext} from "../../src/estimation/prepared-context.js";
import type {ResidualRuntime} from '../../src/estimation/residual/runtime.js';
import {createResidualRuntime} from '../../src/estimation/residual/runtime.js';
import {readResidualSegments} from '../../src/estimation/residual/recorder.js';
import {buildDataset} from '../../src/evaluation/residual/dataset.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseCodexCheckpoint} from '../../src/observer/codex-checkpoint.js';

const token = "protected-full-context-scheduler-test-token-123456789";
const answer = {relation: "replace" as const, status: "running" as const, summary: "task", estimate: {remainingSeconds: 100, errorPercent: 20}};

function history(records: ReadBatch["records"], closed: {value: number}): HistorySnapshot {
  return {
    identity: "verified-history",
    sourceEpoch: 1,
    revision: 1,
    coverage: {complete: true, gaps: []},
    async *records(_signal: AbortSignal): AsyncIterable<HistoryRecord> {
      for (const [ordinal, record] of records.entries()) yield {ordinal, record};
    },
    async close(): Promise<void> { closed.value++; }
  };
}

function fixture(options: {checkpoint?:boolean;owned?:boolean;native?:boolean;paired?:boolean;pairError?:string;deferHistory?: boolean; deferPreparation?: boolean;research?:ResidualRuntime;advancingClock?:boolean} = {}) {
  let now = 0;
  let resolveHistory!: (value: HistorySnapshot) => void;
  let resolvePreparation!: (value: PreparedContext) => void;
  let rejectPreparation!: (error: Error) => void;
  const closed = {value: 0};
  let disabled = false;
  let observed = 0;
  let prepared = 0;
  let observedAt: number | undefined;
  const observations: ObserverObservation[] = [];
  let records: ReadBatch["records"] = [{id: "user", turnId: "first", atMs: 1, kind: "user", text: "work"}];
  let resetNext = false;
  let sourceTurnKey = "";
  const source = createConversationSource({
    source: {
      read: async () => { const reset = resetNext; resetNext = false; return {records, caughtUp: true, partialLine: false, reset}; },
      snapshot: async () => {
        if(options.native)throw Error('PARSED_HISTORY_FORBIDDEN');
        if (options.deferHistory) return new Promise<HistorySnapshot>(resolve => { resolveHistory = resolve; });
        const snapshot=history(records, closed);
        if(options.checkpoint)snapshot.checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[
          {type:'compaction',encrypted_content:'checkpoint-fixture'},
          {type:'message',role:'user',content:[{type:'input_text',text:'retained historical fact'}]}]}})!;
        return snapshot;
      },
      ...(options.native?{nativeSnapshot:async(id:string)=>({kind:'native' as const,sourceThreadId:id,sourceTurnId:'first',sourceEpoch:1,revision:1,
        byteLength:1024,path:'C:/owned/native-snapshot',close:async()=>{closed.value++;}})}:{}),
      ...(options.paired?{openNativeTurn:async()=>{if(options.pairError)throw Object.assign(Error(options.pairError),{code:options.pairError});return ({identity:'paired',sourceEpoch:1,revision:1,currentTurnId:'first',baseKey:'paired-base',
        boundary:{currentTurnId:'first',currentStartOffset:0,watermark:100,completed:null},supplement:history(records,{value:0}),
        validate:async(s:AbortSignal)=>{s.throwIfAborted();},openBase:async()=>null,close:async()=>{closed.value++;}});}}:{}),
      remove: () => {},
      close: async () => {}
    },
    now: () => now,
    wallNow: () => now,
    turnKeyFor: () => sourceTurnKey
  });
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts, source.goals,options.research?event=>options.research!.boundary(event):undefined);
  let prepareResult: PreparedContext = {
    input: {goalSummary: null, activeSeconds: 0, runtime: "running", messages: [{kind: "user", text: "prepared", truncated: false}], truncated: false},
    representation: {mode: "full", sourceComplete: true, originalRecords: 1, compressedThroughOrdinal: null, sizing: "conservative"},
    metrics: {sizing: "conservative", originalTextBytes: 11, originalTextTokenEstimate: 3, preparedRequestBytes: 321,
      preparedTokenEstimate: 87, compressionCalls: 0, cachedCompressionCalls: 0}
  };
  const worker: ObserverWorker = {
    prepareContext: async (input, _snapshot, _signal, _key, _generation, timestamp) => {
      prepared++;
      if(options.research)for await(const record of _snapshot.snapshot.records(_signal))void record;
      observedAt = timestamp;
      if (options.deferPreparation) return new Promise<PreparedContext>((resolve, reject) => {
        resolvePreparation = resolve;
        rejectPreparation = reject;
      });
      return {...prepareResult, input};
    },
    observe: async (_input: ObserverInput) => {
      observed++;
      return {status: "interpreted", interpretation: answer, usage: null};
    },
    status: () => ({active: false, disabled, poisoned: false}),
    disable: () => { disabled = true; },
    close: async () => { disabled = true; }
  };
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker], now: () => options.advancingClock?now++:now,
    ...(options.owned?{workerSource:{acquire:()=>worker,all:()=>[worker],release:async()=>{await worker.release?.();}}}:{}),
    onObservation: record => observations.push(record),...(options.research?{research:options.research}:{})});
  const envelope = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "first"}, now, token).envelope;
  goals.observe(envelope, true, now);
  sourceTurnKey = envelope.turnKey!;
  source.attach(envelope.sessionKey, "conversation-id", sourceTurnKey);
  now = 500;
  source.tick();
  const flush = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };
  const start = async () => {
    await flush();
    scheduler.changed(envelope.sessionKey, "prompt");
    now = 16_000;
    scheduler.tick();
    await flush();
  };
  return {
    scheduler, source, goals, worker, envelope, observations, closed,
    time: (value: number) => { now = value; },
    setRecords: (value: ReadBatch["records"]) => { records = value; },
    resetSource: () => { resetNext = true; },
    setSourceTurn: (value: string) => { sourceTurnKey = value; },
    resolveHistory: (value = history(records, closed)) => resolveHistory(value),
    resolvePreparation: (value = prepareResult) => resolvePreparation(value),
    rejectPreparation: (error = Error("context_too_large")) => rejectPreparation(error),
    prepareResult: (value: PreparedContext) => { prepareResult = value; },
    preparedContext: () => prepareResult,
    start, flush, counts: () => ({prepared, observed, observedAt, disabled})
  };
}

it('includes preparation in the deadline and never dispatches an ETA after late preparation',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const f=fixture({deferPreparation:true});
 try{
  await f.start();expect(f.counts().prepared).toBe(1);
  f.time(46000);await vi.advanceTimersByTimeAsync(30000);
  expect(f.scheduler.diagnostics(f.envelope.sessionKey)).toMatchObject({state:'call_failed',contextState:'estimate_timeout'});
  expect(f.scheduler.stats().inFlight).toBe(1);
  f.resolvePreparation();await f.flush();expect(f.counts().observed).toBe(0);
  expect(f.scheduler.stats().inFlight).toBe(0);
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('estimate_timeout');
 }finally{f.scheduler.disable();await f.source.close();vi.useRealTimers();}
});

it('retains flight and release ownership until the paired source finishes closing after timeout',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const f=fixture({owned:true,native:true,paired:true});
 let finish!:()=>void,released=0;
 f.worker.release=async()=>{released++;};
 f.worker.prepareNativeTurnContext=async(input,source,_signal,_key,_generation,_at,sample)=>{
  const close=source.close;source.close=async()=>{await new Promise<void>(resolve=>{finish=resolve;});await close();};
  sample!();return {...f.preparedContext(),input};
 };
 try{
  await f.start();expect(f.counts().observed).toBe(1);
  f.time(46000);await vi.advanceTimersByTimeAsync(30000);
  expect(f.scheduler.stats().inFlight).toBe(1);expect(released).toBe(0);
  finish();await f.flush();expect(f.scheduler.stats().inFlight).toBe(0);expect(released).toBe(1);
  expect(f.goals.view(f.envelope.sessionKey,46000)?.prediction).toBeNull();expect(f.closed.value).toBe(1);
 }finally{finish?.();await f.flush();f.scheduler.disable();await f.source.close();vi.useRealTimers();}
});

it('uses the completed-turn pair without allocating a legacy full snapshot, retaining source through observe',async()=>{
 const f=fixture({native:true,paired:true});let prepares=0;
 f.worker.nativeSourceDestination=async()=>{throw Error('LEGACY_COPY_FORBIDDEN');};
 f.worker.prepareNativeTurnContext=async(input,source,signal,_key,_generation,_at,sample)=>{
  prepares++;await source.validate(signal);for await(const _record of source.supplement.records(signal)){}
  const fresh=sample!();return {...f.preparedContext(),input:{...input,...fresh}};
 };
 const observe=f.worker.observe;f.worker.observe=async(...args)=>{expect(f.closed.value).toBe(0);return observe(...args);};
 try{await f.start();expect(prepares).toBe(1);expect(f.counts().observed).toBe(1);expect(f.counts().prepared).toBe(0);expect(f.closed.value).toBe(1);}
 finally{f.scheduler.disable();await f.source.close();}
});

it.each(['completed','paused'] as const)('does not dispatch a paired preparation after source runtime becomes %s',async runtime=>{
 const f=fixture({native:true,paired:true});let finish!:()=>void,started=0;
 f.worker.prepareNativeTurnContext=async(input,_source,_signal,_key,_generation,_at,sample)=>{
  started++;await new Promise<void>(resolve=>{finish=resolve;});sample!();return {...f.preparedContext(),input};
 };
 try{
  await f.start();expect(started).toBe(1);
  if(runtime==='completed'){
   f.time(17000);f.setRecords([{id:'terminal',turnId:'first',sourceTurnId:'first',atMs:17000,kind:'runtime',runtime:'waiting',outcome:'completed'}]);
   f.source.tick();await f.flush();f.goals.reconcileSource(f.envelope.sessionKey,17000);
   expect(f.goals.view(f.envelope.sessionKey,17000)?.status).toBe('completed');
  }else f.goals.runtime(f.envelope.sessionKey,f.envelope.turnKey!,runtime,17000);
  finish();await f.flush();expect(f.counts().observed).toBe(0);expect(f.closed.value).toBe(1);
 }finally{f.scheduler.disable();await f.source.close();}
});

it('reports unavailable native pairs without importing legacy history',async()=>{
 const f=fixture();let fallback=0;
 f.worker.prepareNativeTurnContext=async()=>{throw Error('NATIVE_WORKER_MUST_NOT_START');};
 f.worker.prepareNativeHistoryFallback=async(input,history,signal,_key,_generation,_at,sample)=>{
  fallback++;await history.validate(signal);const fresh=sample!();return {...f.preparedContext(),input:{...input,...fresh}};
 };
 try{await f.start();expect(fallback).toBe(0);expect(f.counts().observed).toBe(0);expect(f.closed.value).toBe(0);
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('native_context_failed');
 }finally{f.scheduler.disable();await f.source.close();}
});

it('never falls back after entering a native worker even when its failure resembles a source error',async()=>{
 const f=fixture({paired:true});let fallback=0;
 f.worker.prepareNativeTurnContext=async()=>{throw Error('history_incomplete');};
 f.worker.prepareNativeHistoryFallback=async()=>{fallback++;return f.preparedContext();};
 try{await f.start();expect(fallback).toBe(0);expect(f.counts().observed).toBe(0);expect(f.closed.value).toBe(1);}
 finally{f.scheduler.disable();await f.source.close();}
});

it('uses a verified checkpoint window when a large native rollout cannot be acquired',async()=>{
 const f=fixture({paired:true,pairError:'source_unobserved',checkpoint:true});let prepared=0;
 f.worker.prepareNativeTurnContext=async()=>{throw Error('NATIVE_WORKER_MUST_NOT_START');};
 f.worker.prepareNativeHistoryFallback=async(input,history,signal,_key,_generation,_at,sample,policy)=>{
  prepared++;expect(policy).toEqual({checkpointOnly:true});
  expect(history.snapshot.checkpoint?.items[1]).toMatchObject({content:[{text:'retained historical fact'}]});
  await history.validate(signal);const fresh=sample!();return {...f.preparedContext(),input:{...input,...fresh}};
 };
 try{await f.start();expect(prepared).toBe(1);expect(f.counts().observed).toBe(1);expect(f.closed.value).toBe(1);}
 finally{f.scheduler.disable();await f.source.close();}
});

it('does not replay raw history after source acquisition fails',async()=>{
 const f=fixture({paired:true,pairError:'source_unobserved'});let prepared=0;
 f.worker.prepareNativeTurnContext=async()=>{throw Error('UNREACHABLE');};
 f.worker.prepareNativeHistoryFallback=async()=>{prepared++;return f.preparedContext();};
 try{await f.start();expect(prepared).toBe(0);expect(f.counts().observed).toBe(0);expect(f.closed.value).toBe(1);}
 finally{f.scheduler.disable();await f.source.close();}
});

it('rejects an incomplete checkpoint suffix before preparing a session',async()=>{
 const f=fixture({paired:true,pairError:'source_unobserved',checkpoint:true});let prepared=0;
 f.worker.prepareNativeTurnContext=async()=>{throw Error('UNREACHABLE');};
 f.worker.prepareNativeHistoryFallback=async()=>{prepared++;return f.preparedContext();};
 f.setRecords([{id:'u',turnId:'first',kind:'user',text:'changed',atMs:1}]);
 // Mutate during validation: verified source records must remain immutable.
 const original=f.goals.openNativeHistoryFallback.bind(f.goals);
 f.goals.openNativeHistoryFallback=async(...args)=>{
  const value=await original(...args);if(value)value.snapshot.coverage={complete:false,gaps:['unreadable_record']};return value;
 };
 try{await f.start();expect(prepared).toBe(0);expect(f.counts().observed).toBe(0);expect(f.closed.value).toBe(1);}
 finally{f.scheduler.disable();await f.source.close();}
});

it('reports unsupported native terminals without invoking a legacy fallback',async()=>{
 const f=fixture({paired:true,pairError:'source_terminal_unsupported'});let fallback=0,native=0;
 f.worker.prepareNativeTurnContext=async()=>{native++;throw Error('UNREACHABLE');};
 f.worker.prepareNativeHistoryFallback=async(input,history,signal,_key,_generation,_at,sample)=>{
  fallback++;await history.validate(signal);sample!();return {...f.preparedContext(),input};
 };
 try{await f.start();expect(native).toBe(0);expect(fallback).toBe(0);expect(f.counts().observed).toBe(0);
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('native_context_failed');
 }finally{f.scheduler.disable();await f.source.close();}
});

it('does not prepare a fallback model when the alternative history is incomplete',async()=>{
 const f=fixture({deferHistory:true});let prepared=0;
 f.worker.prepareNativeTurnContext=async()=>{throw Error('UNREACHABLE');};
 f.worker.prepareNativeHistoryFallback=async()=>{prepared++;return f.preparedContext();};
 try{
  await f.start();expect(prepared).toBe(0);expect(f.counts().observed).toBe(0);
 }finally{f.scheduler.disable();await f.source.close();}
});

it('native scheduling bypasses parsed history and sends a prepared native input',async()=>{
 const f=fixture({native:true});let nativePrepares=0;
 f.worker.nativeSourceDestination=async()=>({destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}});
 f.worker.prepareNativeContext=async(input,source,_signal,_key,_generation,_at,sample)=>{
  sample!();
  nativePrepares++;expect(source.currentTurnId).toBe('first');await source.snapshot.close();
  return {input,sourceBytes:source.snapshot.byteLength,sourceRevision:source.snapshot.revision};
 };
 try{
  await f.start();expect(nativePrepares).toBe(1);expect(f.counts().prepared).toBe(0);expect(f.counts().observed).toBe(1);
  expect(f.closed.value).toBe(1);
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('context_native');
 }finally{await f.scheduler.close();await f.source.close();}
});
it('samples native state after preparation while preserving the original request latency',async()=>{
 const f=fixture({native:true});let finish!:()=>void;let samples=0;
 f.worker.nativeSourceDestination=async()=>({destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}});
 f.worker.prepareNativeContext=async(input,source,_signal,_key,_generation,_at,sample)=>{
  await new Promise<void>(resolve=>{finish=resolve;});const fresh=sample!();samples++;
  await source.snapshot.close();return {input:{...input,activeSeconds:fresh.activeSeconds},sourceBytes:1024,sourceRevision:1};
 };
 let modelInput:ObserverInput|undefined;
 f.worker.observe=async input=>{modelInput=input;f.time(96000);return {status:'interpreted',interpretation:answer,usage:null};};
 try{
  await f.start();f.time(86000);finish();await f.flush();
  expect(samples).toBe(1);expect(modelInput?.activeSeconds).toBe(86);
  expect(f.goals.view(f.envelope.sessionKey,96000)?.prediction?.observedActiveSeconds).toBe(86);
  expect(f.observations.find(row=>row.kind==='result')).toMatchObject({requestedAt:16000,observedActiveSeconds:86});
 }finally{await f.scheduler.close();await f.source.close();}
});
it('a native preparation failure never falls back to history or a second model path',async()=>{
 const f=fixture({native:true});let nativePrepares=0;
 f.worker.nativeSourceDestination=async()=>({destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}});
 f.worker.prepareNativeContext=async(_input,source)=>{nativePrepares++;await source.snapshot.close();throw Error('NATIVE_FORK_GOAL_UNVERIFIED');};
 try{
  await f.start();expect(nativePrepares).toBe(1);expect(f.counts().prepared).toBe(0);expect(f.counts().observed).toBe(0);expect(f.closed.value).toBe(1);
 }finally{await f.scheduler.close();await f.source.close();}
});

it('never dispatches an image projection to a worker without native preparation',async()=>{
 const f=fixture();delete f.worker.prepareContext;
 f.setRecords([{id:'image',turnId:'first',atMs:1,kind:'user',text:'inspect',imageCount:1,imageFingerprint:'a'.repeat(64)}]);
 await f.flush();f.time(5500);f.source.changed(f.envelope.sessionKey);f.source.tick();await f.flush();
 try{await f.start();f.time(22000);f.source.tick();await f.flush();f.scheduler.tick();await f.flush();expect(f.counts().observed).toBe(0);
   expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('image_context_unsupported');
 }finally{await f.scheduler.close();await f.source.close();}
});
it('keeps missing-image quality through subsequent preparation and clears after verified full context',async()=>{
 const options={deferPreparation:false};const f=fixture(options),full=f.preparedContext();
 f.prepareResult({...full,representation:{...full.representation,mode:'incomplete',sourceComplete:false,missingImages:1,inferenceEligible:true,sourceGaps:['missing_image']}});
 try{
   await f.start();expect(f.counts().observed).toBe(1);
   options.deferPreparation=true;
   f.time(300000);f.source.tick();await f.flush();f.scheduler.changed(f.envelope.sessionKey,'failure');
   f.time(316000);f.source.tick();await f.flush();f.scheduler.tick();await f.flush();
   expect(f.counts().prepared).toBe(2);
   expect(f.scheduler.diagnostics(f.envelope.sessionKey)).toMatchObject({contextState:'context_preparing',missingImages:1});
   f.resolvePreparation(full);await f.flush();
   expect(f.scheduler.diagnostics(f.envelope.sessionKey)).toMatchObject({contextState:'context_full',missingImages:0});
 }finally{await f.scheduler.close();await f.source.close();}
});
it.each([false,true])('permits missing images but not unrelated prepared gaps (otherGap=%s)',async otherGap=>{
 const f=fixture();const previous=f.preparedContext();
 f.prepareResult({...previous,representation:{...previous.representation,mode:'incomplete',sourceComplete:false,
   missingImages:1,inferenceEligible:true,sourceGaps:otherGap?['missing_image','unsupported_payload']:['missing_image']}});
 try{
   await f.start();
   expect(f.counts().observed).toBe(otherGap?0:1);
   if(!otherGap)expect(f.scheduler.diagnostics(f.envelope.sessionKey)).toMatchObject({missingImages:1});
   expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe(otherGap?'history_incomplete':'context_images_missing');
 }finally{await f.scheduler.close();await f.source.close();}
});
it.each(['late-gap','read-error','complete'] as const)('scans history before any provider preparation: %s',async scenario=>{
  const f=fixture({deferHistory:true});let scanFinished=false,closed=0;
  const snapshot=createHistorySnapshot({identity:'fixed',sourceEpoch:1,revision:1,open:()=>({
    async readPage(offset){
      expect(f.counts().prepared).toBe(0);expect(f.counts().observed).toBe(0);
      if(offset===0)return {records:[{id:'large',kind:'user' as const,turnId:'first',atMs:1,text:'x'.repeat(200000)}],nextOffset:1,done:false,coverage:{complete:true,gaps:[]}};
      if(scenario==='read-error')throw Error('unreadable source');
      scanFinished=true;
      return {records:[],nextOffset:2,done:true,coverage:scenario==='late-gap'?{complete:false,gaps:['unsupported_payload' as const]}:{complete:true,gaps:[]}};
    },async close(){}
  }),async close(){closed++;}});
  try{
    await f.start();f.resolveHistory(snapshot);await f.flush();
    expect(f.counts()).toMatchObject({prepared:scenario==='complete'?1:0,observed:scenario==='complete'?1:0});
    if(scenario!=='complete'){
      expect(closed).toBe(1);
      expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('history_incomplete');
    }else expect(scanFinished).toBe(true);
  }finally{await snapshot.close();await f.scheduler.close();await f.source.close();}
});

it('captures the full-context prefix without changing production ETA when research fails',async()=>{
  let captures=0;
  const research:ResidualRuntime={capture(){captures++;throw Error('recording failure');},accept(){throw Error('recording failure');},unavailable(){},boundary(){},forget(){},async close(){}};
  const ordinary=fixture(),withResearch=fixture({research});
  await ordinary.start();await withResearch.start();
  expect(captures).toBe(1);
  expect(withResearch.counts()).toEqual(ordinary.counts());
  expect(withResearch.goals.view(withResearch.envelope.sessionKey,16000)).toEqual(ordinary.goals.view(ordinary.envelope.sessionKey,16000));
  await ordinary.scheduler.close();await withResearch.scheduler.close();
});

it('does not prepare a source whose turn changed during the local scan',async()=>{
  const f=fixture({deferHistory:true});let release!:()=>void;
  const snapshot=history([],{value:0});let closed=0;
  snapshot.close=async()=>{closed++;};
  snapshot.records=async function*(){
    yield {ordinal:0,record:{id:'u',turnId:'first',atMs:1,kind:'user',text:'work'}};
    await new Promise<void>(resolve=>{release=resolve;});
  };
  try{
    await f.start();f.resolveHistory(snapshot);await f.flush();
    const next=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'second'},17000,token).envelope;
    f.time(17000);f.goals.observe(next,true,17000);f.setSourceTurn(next.turnKey!);
    f.source.attach(next.sessionKey,'conversation-id',next.turnKey!);
    release();await f.flush();
    expect(f.counts()).toMatchObject({prepared:0,observed:0});expect(closed).toBe(1);
  }finally{release?.();await f.scheduler.close();await f.source.close();}
});

it('does not observe a representation that became incomplete during provider preparation',async()=>{
  const f=fixture();const value=f.preparedContext();
  f.prepareResult({...value,representation:{...value.representation,mode:'incomplete',sourceComplete:false}});
  try{
    await f.start();expect(f.counts()).toMatchObject({prepared:1,observed:0});
    expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe('history_incomplete');
  }finally{await f.scheduler.close();await f.source.close();}
});

it.each([false,true])('joins a real scheduler forecast with independent same-turn source completion (advancing clock: %s)',async advancingClock=>{
  const directory=await mkdtemp(join(tmpdir(),'residual-scheduler-'));
  const research=await createResidualRuntime(directory),f=fixture({research,advancingClock});
  f.worker.provenance=()=>({input:'i1',prompt:'p1',model:'m1',algorithm:'a1'});
  try{
    await f.flush();
    const bootstrap=f.goals.request(f.envelope.sessionKey,500)!;
    f.goals.settle(bootstrap.ticket,answer,500);
    f.worker.observe=async()=>({status:'interpreted',interpretation:{...answer,relation:'continue'},usage:null});
    await f.start();
    expect(f.counts().prepared).toBe(1);
    f.time(20000);f.setRecords([{id:'end',turnId:'first',atMs:20000,kind:'runtime',runtime:'waiting',outcome:'completed'}]);
    f.source.tick();await f.flush();f.goals.reconcileSource(f.envelope.sessionKey,20000);
    await f.scheduler.close();await research.close();
    const result=buildDataset((await readResidualSegments(directory)).records);
    expect(result.samples,JSON.stringify(result)).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({features:{rawSeconds:100}});
    expect(result.samples[0]!.actualSeconds).toBeCloseTo(4,1);
  }finally{await f.scheduler.close();await research.close();await rm(directory,{recursive:true,force:true});}
});
it('keeps accepted forecasts with a later history watermark in the coverage denominator',async()=>{
  let captured=0,unavailable=0;
  let detail:unknown;
  const research:ResidualRuntime={capture(){captured++;return {};},accept(){return true;},unavailable(_o,_p,_r,_a,_v,reason){unavailable++;detail=reason;},boundary(){},forget(){},async close(){}};
  const f=fixture({research,deferHistory:true});f.worker.provenance=()=>({input:'i',prompt:'p',model:'m',algorithm:'a'});
  await f.start();
  f.resolveHistory(history([{id:'user',turnId:'first',atMs:1,kind:'user',text:'work'},
    {id:'late',turnId:'first',atMs:17000,kind:'tool_result',actionId:'late',exitCode:0}],{value:0}));
  await f.flush();
  expect(f.counts().observed).toBe(1);expect(captured).toBe(0);expect(unavailable).toBe(1);
  expect(detail).toBe('fingerprint_changed');
  await f.scheduler.close();
});

it("does not observe until delayed source history preparation finishes", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  expect(f.counts()).toMatchObject({prepared: 0, observed: 0});
  f.resolveHistory();
  await f.flush();
  expect(f.counts()).toMatchObject({prepared: 1, observed: 1, observedAt: 16_000});
  expect(f.observations.map(row => row.contextState)).toEqual(expect.arrayContaining(["history_loading", "context_preparing", "context_full"]));
  expect(f.observations.filter(row => row.contextMetrics)).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: "stage", contextMetrics: f.preparedContext().metrics})
  ]));
  expect(f.observations.at(-1)).toMatchObject({contextMetrics: f.preparedContext().metrics});
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe("context_full");
  await f.scheduler.close();
});

it("accepts delayed history after same-turn activity advances the trusted clock", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  const activity = normalizeHookInput("PostToolUse", {session_id: "session", turn_id: "first"}, 17_000, token).envelope;
  f.time(17_000);
  f.goals.observe(activity, true, 17_000);
  f.resolveHistory();
  await f.flush();
  expect(f.counts()).toMatchObject({prepared: 1, observed: 1});
  await f.scheduler.close();
});

it("rejects preparation after a new authenticated turn without observing it", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  const next = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "second"}, 16_000, token).envelope;
  f.goals.observe(next, true, 16_000);
  f.setSourceTurn(next.turnKey!);
  f.source.attach(next.sessionKey, "conversation-id", next.turnKey!);
  f.resolveHistory();
  await f.flush();
  expect(f.counts().observed).toBe(0);
  await f.scheduler.close();
});

it("does not persist a stale preparation failure onto the next goal", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  const next = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "second"}, 16_000, token).envelope;
  f.goals.observe(next, true, 16_000);
  f.setSourceTurn(next.turnKey!);
  f.source.attach(next.sessionKey, "conversation-id", next.turnKey!);
  f.rejectPreparation(Error("context_too_large"));
  await f.flush();
  expect(f.scheduler.diagnostics(next.sessionKey).contextState).toBeUndefined();
  await f.scheduler.close();
});

it("rejects preparation after a source epoch reset", async () => {
  const f = fixture({deferHistory: true});
  await f.start();
  f.setRecords([{id: "user", turnId: "first", atMs: 1, kind: "user", text: "reset"}]);
  f.resetSource();
  f.source.changed(f.envelope.sessionKey);
  f.time(16_500);
  f.source.tick();
  await f.flush();
  f.scheduler.tick();
  f.resolveHistory();
  await f.flush();
  expect(f.counts().observed).toBe(0);
  await f.scheduler.close();
});

it("does not observe after the worker is disabled during preparation", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  expect(f.counts().prepared).toBe(1);
  f.worker.disable();
  f.resolvePreparation();
  await f.flush();
  expect(f.counts().observed).toBe(0);
  await f.scheduler.close();
});

it("releases a ticket after preparation failure without exposing the raw error", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  f.rejectPreparation(Error("context_too_large: secret source text"));
  await f.flush();
  expect(f.counts().observed).toBe(0);
  expect(f.observations.at(-1)).toMatchObject({kind: "result", contextState: "context_too_large"});
  expect(f.observations.at(-1)).not.toHaveProperty("error");
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe("context_too_large");
  await f.scheduler.close();
});

it("clears the persisted context state when a new goal begins", async () => {
  const f = fixture({deferPreparation: true});
  await f.start();
  f.rejectPreparation(Error("context_too_large"));
  await f.flush();
  expect(f.scheduler.diagnostics(f.envelope.sessionKey).contextState).toBe("context_too_large");

  const next = normalizeHookInput("UserPromptSubmit", {session_id: "session", turn_id: "second"}, 16_000, token).envelope;
  f.goals.observe(next, true, 16_000);
  f.setSourceTurn(next.turnKey!);
  f.source.attach(next.sessionKey, "conversation-id", next.turnKey!);
  f.scheduler.changed(next.sessionKey, "prompt");
  expect(f.scheduler.diagnostics(next.sessionKey).contextState).toBeUndefined();
  await f.scheduler.close();
});

it("keeps history preparation independent for two conversations", async () => {
  let now = 0;
  const closed = {value: 0};
  const pending = new Map<string, (snapshot: HistorySnapshot) => void>();
  const turnKeys = new Map<string, string>();
  const source = createConversationSource({
    source: {
      read: async (id) => ({records: [{id: `user-${id}`, turnId: "first", atMs: 1, kind: "user", text: id}], caughtUp: true, partialLine: false, reset: false}),
      snapshot: async (id) => new Promise<HistorySnapshot>(resolve => { pending.set(id, resolve); }),
      remove: () => {},
      close: async () => {}
    },
    now: () => now,
    wallNow: () => now,
    turnKeyFor: host => turnKeys.get(host)!
  });
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts, source.goals);
  const observed: string[] = [];
  const worker = (index: number): ObserverWorker => ({
    prepareContext: async input => ({input, representation: {
      mode: "full", sourceComplete: true, originalRecords: 1, compressedThroughOrdinal: null, sizing: "conservative"
    }}),
    observe: async (_input, _signal, key) => { observed.push(`${index}:${key}`); return {status: "interpreted", interpretation: answer, usage: null}; },
    status: () => ({active: false, disabled: false, poisoned: false}),
    disable: () => {}, close: async () => {}
  });
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker(1), worker(2)], now: () => now});
  const envelopes = ["a", "b"].map(session => normalizeHookInput("UserPromptSubmit", {session_id: session, turn_id: "first"}, 0, token).envelope);
  for (const envelope of envelopes) {
    goals.observe(envelope, true, 0);
    const host = `host-${envelope.sessionKey}`;
    turnKeys.set(host, envelope.turnKey!);
    source.attach(envelope.sessionKey, host, envelope.turnKey!);
  }
  now = 500;
  source.tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  scheduler.changed(envelopes[0]!.sessionKey, "prompt");
  scheduler.changed(envelopes[1]!.sessionKey, "prompt");
  now = 16_000;
  scheduler.tick();
  await Promise.resolve();
  expect(pending.size).toBe(2);
  pending.get(`host-${envelopes[0]!.sessionKey}`)!(history([], closed));
  await new Promise<void>(resolve => setImmediate(resolve));
  await Promise.resolve(); await Promise.resolve();
  expect(observed).toHaveLength(1);
  pending.get(`host-${envelopes[1]!.sessionKey}`)!(history([], closed));
  await new Promise<void>(resolve => setImmediate(resolve));
  await Promise.resolve(); await Promise.resolve();
  expect(observed).toHaveLength(2);
  await scheduler.close();
  await source.close();
});
