import {expect, it} from 'vitest';
import {createDesktopObserverRuntime} from '../../src/desktop/observer-runtime.js';
import {ObserverScheduler, type ObserverWorker, type ObserverObservation} from '../../src/estimation/observer-scheduler.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput, type HookName} from '../../src/hooks/schema.js';
import type {ObserverResult} from '../../src/estimation/observer-provider.js';

const usage = {kind: 'subscription-tokens' as const, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0};
it.each(['continue','unknown'] as const)('preserves outage exclusion after an inconclusive %s refresh',async relation=>{
  const f=selectedSourceFixture();f.hook();f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:1000,errorPercent:30};
  f.calls[0]!.finish(estimate);await f.flush();
  f.setAvailable(false);f.time(3600000);f.scheduler.tick();f.setAvailable(true);f.scheduler.tick();
  f.time(4400000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  const uncertain=result('continue');uncertain.interpretation={relation,status:relation==='unknown'?'unknown':'running',summary:null,estimate:null};
  f.calls[1]!.finish(uncertain);await f.flush();
  try{
    f.time(4460000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  }finally{for(const call of f.calls)call.finish(result('continue'));await f.flush();await f.scheduler.close();}
});
it('retains the overdue reservation after a numeric-less refresh instead of retrying every minute',async()=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:100,errorPercent:30};
  const uncertain=result('continue');uncertain.interpretation!.estimate=null;
  f.calls[0]!.finish(estimate);await f.flush();
  f.time(95000);f.scheduler.tick();f.calls[1]!.finish(uncertain);await f.flush();
  f.time(155000);f.scheduler.tick();f.calls[2]!.finish(uncertain);await f.flush();
  try{
    f.time(215000);f.scheduler.tick();expect(f.calls).toHaveLength(3);
    f.time(455000);f.scheduler.tick();expect(f.calls).toHaveLength(4);
  }finally{for(const call of f.calls)call.finish(result('continue'));await f.flush();await f.scheduler.close();}
});
it('reports source failure separately from loading and clears it when source recovers',async()=>{
  const f=selectedSourceFixture();f.setAvailable(false);const key=f.hook();
  f.time(15000);f.scheduler.tick();
  try{
    expect(f.scheduler.diagnostics(key).state).toBe('history_unavailable');
    f.setAvailable(true);f.scheduler.tick();
    expect(f.scheduler.diagnostics(key).state).toBe('estimating');
    expect(f.calls).toHaveLength(1);
    f.calls[0]!.finish(result());await f.flush();
    expect(f.scheduler.diagnostics(key).state).toBe('ready');
  }finally{await f.scheduler.close();}
});
it('backs off after repeated known-usage failures but continues observing long-running work',async()=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:100,errorPercent:30};
  f.calls[0]!.finish(estimate);await f.flush();
  const failed:ObserverResult={status:'process_error',interpretation:null,usage};
  f.time(95000);f.scheduler.tick();f.calls[1]!.finish(failed);await f.flush();
  f.time(155000);f.scheduler.tick();f.calls[2]!.finish(failed);await f.flush();
  f.time(455000);f.scheduler.tick();expect(f.calls).toHaveLength(3);
  f.time(754999);f.scheduler.tick();expect(f.calls).toHaveLength(3);
  f.time(755000);f.scheduler.tick();expect(f.calls).toHaveLength(4);
  f.calls[3]!.finish(failed);await f.flush();
  f.time(2554999);f.scheduler.tick();expect(f.calls).toHaveLength(4);
  f.time(2555000);f.scheduler.tick();expect(f.calls).toHaveLength(5);
  f.calls[4]!.finish(result('continue'));await f.flush();
  expect(f.scheduler.stats().disabled).toBe(false);
  await f.scheduler.close();
});
it('does not spend the near-expiry opportunity again after a rejected attempt until a new prediction',async()=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:400,errorPercent:30};
  f.calls[0]!.finish(estimate);await f.flush();
  f.time(335000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish({status:'admission_denied',interpretation:null,usage:null});await f.flush();
  f.time(395000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  await f.scheduler.close();
});
it('does not count a selected-source outage toward the near-expiry threshold',async()=>{
  const f=selectedSourceFixture();f.hook();f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:100,errorPercent:30};
  f.calls[0]!.finish(estimate);await f.flush();
  f.setAvailable(false);f.time(3600000);f.scheduler.tick();
  f.setAvailable(true);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(3679999);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(3680000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result('continue'));await f.flush();await f.scheduler.close();
});
it('rechecks at eighty percent once per prediction and keeps an overdue fallback after safe failure',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,r=>records.push(r));
  f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:100,errorPercent:30};
  f.calls[0]!.finish(estimate);await f.flush();
  f.time(94999);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(95000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  expect(records.filter(r=>r.kind==='request').at(-1)?.triggerReason).toBe('near_expiry');
  f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish({status:'process_error',interpretation:null,usage});await f.flush();
  f.time(115000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.time(155000);f.scheduler.tick();expect(f.calls).toHaveLength(3);
  expect(records.filter(r=>r.kind==='request').at(-1)?.triggerReason).toBe('overdue');
  f.calls[2]!.finish(result('continue'));await f.flush();
  await f.scheduler.close();
});
it('surfaces desktop startup failure without opening accounting or dispatching inference',async()=>{
  const f=fixture(),key=f.hook('UserPromptSubmit');let now=0,contacts=0;
  const runtime=createDesktopObserverRuntime({
    identity:{inspect:async()=>{throw Error('runtime preflight failed');},
      prepareEstimate:async()=>{contacts++;throw Error('must not infer');},disable(){},async close(){}},
    openAccounting:async()=>{contacts++;throw Error('must not open ledger');},
    dialog:{showMessageBox:async()=>{contacts++;return {response:0};}}
  });
  const scheduler=new ObserverScheduler({goals:f.goals,contexts:f.contexts,workers:runtime.workers,now:()=>now});
  try {
    scheduler.changed(key,'prompt');await runtime.start(new AbortController().signal);
    now=15000;scheduler.tick();
    expect(scheduler.diagnostics(key).state).toBe('setup_failed');
    expect(contacts).toBe(0);
  }finally{await scheduler.close();await runtime.close();await f.scheduler.close();}
});
const result = (relation: 'replace'|'continue' = 'replace'): ObserverResult => ({status: 'interpreted',
  interpretation: {relation, status: 'running', summary: 'current goal', estimate: {remainingSeconds: 600, errorPercent: 30}}, usage});
const unknownUsageResult = (): ObserverResult => ({...result(),usage:null,
  outcomes:{prediction:'numeric',call:'success',usage:'unknown',framingValid:true,closureConfirmed:true,dispatch:'started'}});
const transientResult=():ObserverResult=>({status:'process_error',interpretation:null,usage:null,
  outcomes:{prediction:'invalid',call:'failed',usage:'unknown',framingValid:false,closureConfirmed:true,dispatch:'not_started',retryable:'pre_dispatch_transient'}});
const cancelledBeforeDispatch=():ObserverResult=>({status:'aborted',interpretation:null,usage:null,
  outcomes:{prediction:'invalid',call:'cancelled',usage:'not_dispatched',framingValid:false,closureConfirmed:true,dispatch:'not_started'}});
it('counts estimate freshness from its input snapshot rather than hiding provider latency',async()=>{
  const f=fixture();const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(45000);f.calls[0]!.finish(result());await f.flush();
  expect(f.scheduler.diagnostics(key).estimateAgeSeconds).toBe(30);
  await f.scheduler.close();
});
it('preserves API usage through the neutral scheduler observation boundary',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,row=>records.push(row));const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();
  const apiUsage={kind:'api-tokens' as const,inputTokens:4,outputTokens:2,cachedInputTokens:0};
  f.calls[0]!.finish({...result(),usage:apiUsage});await f.flush();
  expect(records.find(row=>row.kind==='result'&&row.key===key)?.usage).toEqual(apiUsage);
  await f.scheduler.close();
});
it('keeps the scheduler alive after a provider failure with trusted durable settlement',async()=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish({status:'process_error',interpretation:null,usage:null,outcomes:{
    prediction:'invalid',call:'failed',usage:'unknown',framingValid:false,closureConfirmed:true,
    dispatch:'unknown',accounting:'durably_settled'}});await f.flush();
  expect(f.scheduler.stats().disabled).toBe(false);
  await f.scheduler.close();
});
it('does not dispatch fallback work while an API provider is blocked for configuration',async()=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish({status:'disabled',interpretation:null,usage:null,outcomes:{
    prediction:'invalid',call:'failed',usage:'not_dispatched',framingValid:false,closureConfirmed:true,
    dispatch:'not_started',failureCode:'unauthorized'}});await f.flush();
  expect(f.scheduler.stats().disabled).toBe(false);
  await f.scheduler.close();
});
it('retains the current estimate after an unknown-usage refresh',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,row=>records.push(row));const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();
  const estimate=result();estimate.interpretation!.estimate={remainingSeconds:100,errorPercent:30};
  f.calls[0]!.finish(estimate);await f.flush();
  const unknown=result('continue');unknown.interpretation!.estimate=null;unknown.usage=null;
  f.time(95000);f.scheduler.tick();f.calls[1]!.finish(unknown);await f.flush();
  expect(f.goals.view(key,95000)?.prediction?.remainingSeconds).toBe(100);
  expect(records.find(row=>row.kind==='result'&&row.requestId===2)?.usage).toBeNull();
  await f.scheduler.close();
});
function fixture(workerCount = 2, closeTimeoutMs = 6000, onObservation?:(record:ObserverObservation)=>void, withProvenance: boolean|'throw' = false, dynamic = false) {
  let now = 0, id = 0;
  const contexts = new PassiveContextStore(), goals = new PassiveGoals(contexts);
  const calls: Array<{signal: AbortSignal; key: string; input: unknown; finish(value: ObserverResult, closed?: boolean): void}> = [];
  const makeWorker = (): ObserverWorker => {
    let active = false, disabled = false;
    return {observe: (input, signal, key) => {active = true; return new Promise<ObserverResult>(resolve => {
      calls.push({signal, key, input, finish(value, closed = true) {active = !closed; resolve(value);}});
    });}, disable() {disabled = true;}, async close() {disabled = true;},
      status: () => ({active, disabled, poisoned: false}),
      ...(withProvenance ? {provenance: () => {if(withProvenance==='throw')throw Error('diagnostic sink');return {input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'};}} : {})};
  };
  const workers: ObserverWorker[] = Array.from({length: workerCount}, makeWorker);
  const owners = new Map<string, ObserverWorker>();
  const workerSource = dynamic ? {
    acquire(key: string) { const worker = owners.get(key) ?? makeWorker(); owners.set(key, worker); if (!workers.includes(worker)) workers.push(worker); return worker; },
    async release(key: string) { owners.delete(key); },
    all() { return workers; }
  } : undefined;
  const scheduler = new ObserverScheduler({contexts, goals, now: () => now, closeTimeoutMs, ...(workerSource ? {workerSource} : {workers}), ...(onObservation?{onObservation}:{})});
  const hook = (name: HookName, session = 'one', turn = 'first') => {
    const envelope = normalizeHookInput(name, {session_id: session, turn_id: turn, tool_use_id: String(++id)}, now,
      'protected-observer-scheduler-test-token-123456789').envelope;
    const kind = name === 'UserPromptSubmit' ? 'user' : name === 'Stop' ? 'assistant' : 'tool';
    if (name !== 'Interrupt') envelope.content = {kind, text: 'task data', truncated: false};
    goals.observe(envelope, true, now); contexts.ingest(envelope, now);
    scheduler.changed(envelope.sessionKey, name === 'UserPromptSubmit' ? 'prompt' : name === 'Stop' ? 'final' : 'activity');
    return envelope.sessionKey;
  };
  const time = (value: number) => {now = value;};
  const flush = async () => {await Promise.resolve(); await Promise.resolve();};
  return {scheduler, goals, contexts, calls, hook, time, flush};
}

function paceFixture(onObservation?:(record:ObserverObservation)=>void) {
  const f=fixture(1,6000,onObservation,true);
  const measurementRef='pm_0123456789abcdef0123456789abcdef';
  const intervals=[10,20,30].map((startActiveSeconds,index)=>({workClass:'file_processing' as const,unit:'file' as const,
    startActiveSeconds,endActiveSeconds:startActiveSeconds+10,completedUnits:1,complete:true,serial:true}));
  f.goals.paceIntervals=(_ticket,work)=>{
    const target=work?.parts.find(part=>part.remainingUnits!==null);
    return work?.composition==='serial'&&work.changeReason==='routine'&&target?.measurementRef===measurementRef?intervals:[];
  };
  return {...f,measurementRef};
}

it('records accepted raw and shadow forecast provenance without changing the HUD prediction',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,row=>records.push(row),true);const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish(result());await f.flush();
  const forecast=records.find(row=>row.kind==='result')?.forecast;
  expect(forecast).toMatchObject({schemaVersion:1,predictionId:1,generation:1,snapshotActiveSeconds:15,
    rawSeconds:600,shadowSeconds:null,paceReason:'missing_measurements',calibration:'uncalibrated',
    versions:{input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'}});
  expect(f.goals.view(key,15000)?.prediction?.remainingSeconds).toBe(600);
  await f.scheduler.close();
});

it('uses only accepted frozen file intervals for an eligible shadow forecast',async()=>{
  const records:ObserverObservation[]=[];const f=paceFixture(row=>records.push(row));const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  const measurementRef=f.measurementRef;
  f.calls[0]!.finish({...result(),interpretation:{...result().interpretation!,estimate:{remainingSeconds:100,errorPercent:30},work:{
    composition:'serial',changeReason:'routine',parts:[
      {workClass:'other',unit:'unknown',remainingUnits:null,priorSeconds:20},
      {workClass:'file_processing',unit:'file',remainingUnits:2,priorSeconds:80,measurementRef}]}}});
  await f.flush();
  const forecast=records.find(row=>row.kind==='result')?.forecast;
  expect(forecast).toMatchObject({rawSeconds:100,shadowSeconds:40,paceReason:'eligible',calibration:'uncalibrated',
    measurement:{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3}});
  expect(f.goals.view(key,15000)?.prediction?.remainingSeconds).toBe(100);
  expect(f.calls).toHaveLength(1);
  await f.scheduler.close();
});

it('abstains when the accepted shadow reference is stale, mismatched, scope-changed, or absent',async()=>{
  for(const mode of ['stale','mismatch','scope','missing'] as const){
    const records:ObserverObservation[]=[];const f=paceFixture(row=>records.push(row));const key=f.hook('UserPromptSubmit');
    f.time(15000);f.scheduler.tick();
    const measurementRef=mode==='missing'?'pm_00000000000000000000000000000000':mode==='stale'?'pm_ffffffffffffffffffffffffffffffff':mode==='mismatch'?'pm_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee':f.measurementRef;
    const work={composition:'serial' as const,changeReason:(mode==='scope'?'scope_change':'routine') as 'scope_change'|'routine',parts:[
      {workClass:'other' as const,unit:'unknown' as const,remainingUnits:null,priorSeconds:20},
      {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:2,priorSeconds:80,measurementRef}]};
    f.calls[0]!.finish({...result(),interpretation:{...result().interpretation!,estimate:{remainingSeconds:100,errorPercent:30},work}});
    await f.flush();
    expect(records.find(row=>row.kind==='result')?.forecast).toMatchObject({rawSeconds:100,shadowSeconds:null,
      paceReason:mode==='scope'?'invalid_composition':'missing_measurements'});
    expect(f.goals.view(key,15000)?.prediction?.remainingSeconds).toBe(100);
    await f.scheduler.close();
  }
});

it('does not emit a forecast for a stale ticket or without provenance',async()=>{
  const stale:ObserverObservation[]=[];const f=fixture(1,6000,row=>stale.push(row),true);const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();f.goals.end(key);f.calls[0]!.finish(result());await f.flush();
  expect(stale.find(row=>row.kind==='result')).not.toHaveProperty('forecast');
  await f.scheduler.close();

  const missing:ObserverObservation[]=[];const g=fixture(1,6000,row=>missing.push(row));const other=g.hook('UserPromptSubmit');
  g.time(15000);g.scheduler.tick();g.calls[0]!.finish(result());await g.flush();
  expect(missing.find(row=>row.kind==='result')).toMatchObject({accepted:true,forecastDiagnostic:'provenance_unavailable'});
  expect(g.goals.view(other,15000)?.prediction?.remainingSeconds).toBe(600);
  await g.scheduler.close();
});

it('anchors accepted replacement forecast records to the rebased prediction clock',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,row=>records.push(row),true);const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();f.calls[0]!.finish(result());await f.flush();
  f.time(100000);f.hook('UserPromptSubmit','one','second');f.time(160000);f.scheduler.tick();
  f.calls[1]!.finish(result());await f.flush();
  expect(f.goals.view(key,160000)?.prediction?.observedActiveSeconds).toBe(60);
  expect(records.filter(row=>row.kind==='result').at(-1)?.forecast).toMatchObject({generation:2,snapshotActiveSeconds:60});
  await f.scheduler.close();
});

it('contains a provenance callback failure without disrupting an accepted raw estimate',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,row=>records.push(row),'throw');const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();f.calls[0]!.finish(result());await f.flush();
  expect(records.find(row=>row.kind==='result')).toMatchObject({accepted:true,forecastDiagnostic:'provenance_unavailable'});
  expect(f.goals.view(key,15000)?.prediction?.remainingSeconds).toBe(600);
  await f.scheduler.close();
});

it('anchors null replacement forecasts to the new goal snapshot, excluding response latency',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,row=>records.push(row),true);const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();f.calls[0]!.finish(result());await f.flush();
  f.time(100000);f.hook('UserPromptSubmit','one','second');f.time(160000);f.scheduler.tick();
  const response=result();response.interpretation!.estimate=null;
  f.time(180000);f.calls[1]!.finish(response);await f.flush();
  expect(f.goals.view(key,180000)?.prediction).toBeNull();
  expect(records.filter(row=>row.kind==='result').at(-1)?.forecast).toMatchObject({
    generation:2,snapshotActiveSeconds:60,rawSeconds:null,shadowSeconds:null});
  await f.scheduler.close();
});

function selectedSourceFixture(workerCount = 1) {
  let now = 0, id = 0, revision = 1, sourceEpoch = 0, available = true, currentActionId: string|null = 'action', finalAvailable = false;
  const contexts = new PassiveContextStore();
  const source = {
    health: () => available ? 'ready' as const : 'error' as const,
    epoch: () => available ? sourceEpoch : null,
    read: (_key: string, _turnKey: string, query: {activeSeconds: number; runtime: 'running'|'waiting'|'paused'}) => ({
      epoch: 0, revision, currentActionId, finalAvailable,
      input: {goalSummary: null, activeSeconds: query.activeSeconds, runtime: query.runtime,
        messages: [{kind: 'user' as const, text: 'source task', truncated: false}], truncated: false}
    })
  };
  const goals = new PassiveGoals(contexts, source);
  const calls: Array<{signal: AbortSignal; key: string; finish(value: ObserverResult): void}> = [];
  const workers: ObserverWorker[] = Array.from({length: workerCount}, () => {
    let active = false, disabled = false;
    return {observe: (_input, signal, key) => {active = true; return new Promise(resolve => {
      calls.push({signal, key, finish(value) {active = false; resolve(value);}});
    });}, disable() {disabled = true;}, async close() {disabled = true;},
      status: () => ({active, disabled, poisoned: false})};
  });
  const scheduler = new ObserverScheduler({contexts, goals, workers, now: () => now});
  const hook = (session = 'one', turn = 'first') => {
    const envelope = normalizeHookInput('UserPromptSubmit',
      {session_id: session, turn_id: turn, tool_use_id: String(++id)}, now,
      'protected-observer-scheduler-test-token-123456789').envelope;
    goals.observe(envelope, true, now);
    scheduler.changed(envelope.sessionKey, 'prompt');
    return envelope.sessionKey;
  };
  const stop = (session = 'one', turn = 'first') => {
    const envelope = normalizeHookInput('Stop',
      {session_id: session, turn_id: turn, tool_use_id: String(++id)}, now,
      'protected-observer-scheduler-test-token-123456789').envelope;
    envelope.content = {kind: 'assistant', text: 'final status', truncated: false};
    goals.observe(envelope, true, now);
    scheduler.changed(envelope.sessionKey, 'final');
    return envelope.sessionKey;
  };
  return {
    scheduler, goals, calls, hook, stop,
    time: (value: number) => {now = value;},
    flush: async () => {await Promise.resolve(); await Promise.resolve();},
    setSource: (nextRevision: number, nextActionId: string|null = currentActionId, nextFinalAvailable = finalAvailable) => {
      revision = nextRevision; currentActionId = nextActionId; finalAvailable = nextFinalAvailable;
    },
    setEpoch: (nextEpoch:number) => {sourceEpoch=nextEpoch;},
    setAvailable: (nextAvailable:boolean) => {available=nextAvailable;}
  };
}

it('retries a proven transient once after cooldown, not repeatedly on identical input',async()=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish(transientResult());await f.flush();
  expect(f.scheduler.stats().disabled).toBe(false);
  expect(f.scheduler.diagnostics(f.calls[0]!.key)).toMatchObject({state:'call_failed',retryPending:true,callsLastHour:1});
  f.time(74999);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(75000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(transientResult());await f.flush();
  f.time(900000);f.scheduler.tick();expect(f.calls).toHaveLength(3);
  f.calls[2]!.finish(result());await f.flush();
  await f.scheduler.close();
});
it('allows another conversation to estimate after one reservation is cancelled before dispatch',async()=>{
  const f=fixture(1),first=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.scheduler.end(first);f.calls[0]!.finish(cancelledBeforeDispatch());await f.flush();
  expect(f.scheduler.stats().disabled).toBe(false);
  expect(f.goals.view(first,15000)?.prediction).toBeNull();
  const second=f.hook('UserPromptSubmit','two');f.time(30000);f.scheduler.tick();
  expect(f.calls).toHaveLength(2);f.calls[1]!.finish(result());await f.flush();
  expect(f.goals.view(second,30000)?.prediction?.remainingSeconds).toBe(600);
  await f.scheduler.close();
});
it.each(['closure','dispatch','usage','call','status'])('keeps unknown-spend stop when cancellation lacks %s proof',async missing=>{
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  const value=cancelledBeforeDispatch();
  if(missing==='closure')value.outcomes!.closureConfirmed=false;
  if(missing==='dispatch')value.outcomes!.dispatch='unknown';
  if(missing==='usage')value.outcomes!.usage='unknown';
  if(missing==='call')value.outcomes!.call='failed';
  if(missing==='status')value.status='process_error';
  f.calls[0]!.finish(value);await f.flush();expect(f.scheduler.stats().disabled).toBe(false);
  await f.scheduler.close();
});

it('projects distinct estimation states and accepted prediction age without task text',async()=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');
  expect(f.scheduler.diagnostics(key)).toMatchObject({state:'pending',estimateAgeSeconds:null});
  f.time(15000);f.scheduler.tick();expect(f.scheduler.diagnostics(key).state).toBe('estimating');
  f.calls[0]!.finish(result());await f.flush();f.time(18000);
  expect(f.scheduler.diagnostics(key)).toMatchObject({state:'ready',estimateAgeSeconds:3,callsLastHour:1});
  f.hook('UserPromptSubmit','one','second');expect(f.scheduler.diagnostics(key).estimateAgeSeconds).toBeNull();
  await f.scheduler.close();
});

it('does not retry a proven transient when its goal was cancelled',async()=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.scheduler.end(key);f.calls[0]!.finish(transientResult());await f.flush();
  f.time(900000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  await f.scheduler.close();
});

it('displays a proven current answer with unknown usage without globally disabling calls',async()=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish(unknownUsageResult());await f.flush();
  expect(f.goals.view(key,15000)?.prediction?.remainingSeconds).toBe(600);
  expect(f.scheduler.stats().disabled).toBe(false);
  f.time(90000);f.hook('UserPromptSubmit','two');f.scheduler.tick();
  expect(f.calls).toHaveLength(1);
  f.time(105000);f.scheduler.tick();expect(f.calls).toHaveLength(2);f.calls[1]!.finish(result());await f.flush();
  await f.scheduler.close();
});

it.each(['end','disable'])('does not display unknown-usage results after external %s',async action=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  if(action==='disable')f.scheduler.disable();else f.scheduler.end(key);
  f.calls[0]!.finish(unknownUsageResult());await f.flush();
  expect(f.goals.view(key,15000)?.prediction).toBeNull();
  await f.scheduler.close();
});

it.each(['framing','closure','call','dispatch'])('rejects unknown usage without valid %s proof',async missing=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  const response=unknownUsageResult();
  if(missing==='framing')response.outcomes!.framingValid=false;
  if(missing==='closure')response.outcomes!.closureConfirmed=false;
  if(missing==='call')response.outcomes!.call='failed';
  if(missing==='dispatch')response.outcomes!.dispatch='unknown';
  f.calls[0]!.finish(response);await f.flush();
  expect(f.goals.view(key,15000)?.prediction).not.toBeNull();expect(f.scheduler.stats().disabled).toBe(false);
  await f.scheduler.close();
});

it('records prediction prefixes separately from delivery without raw context or summaries',async()=>{
  const records:ObserverObservation[]=[];
  const f=fixture(1,6000,value=>records.push(value));
  f.hook('UserPromptSubmit');f.hook('PostToolUse');f.time(15000);f.scheduler.tick();
  f.time(18000);f.calls[0]!.finish({...result('replace'),timings:{preparationMs:100,providerMs:2000,settlementMs:20,deliveryMs:5,totalMs:2125}});await f.flush();
  expect(records.find(value=>value.kind==='request')).toMatchObject({at:15000,activeSeconds:15,requestId:1});
  expect(records.find(value=>value.kind==='result')).toMatchObject({at:18000,requestedAt:15000,observedActiveSeconds:15,
    activeSeconds:18,accepted:true,estimate:{remainingSeconds:600,errorPercent:30},usage,requestId:1,
    timings:{preparationMs:100,providerMs:2000,settlementMs:20,deliveryMs:5,totalMs:2125}});
  expect(JSON.stringify(records)).not.toContain('task data');
  expect(JSON.stringify(records)).not.toContain('current goal');
  await f.scheduler.close();
});

it('supports 25 hours of progressing work without wall-time sleeps or extra unchanged calls',async()=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');f.hook('PostToolUse');
  for(let hour=0;hour<25;hour++){
    f.time(hour*3600000+15000);
    if(hour)f.hook('PostToolUse');
    f.scheduler.tick();
    expect(f.calls).toHaveLength(hour+1);
    const response=result(hour?'continue':'replace');
    response.interpretation!.estimate={remainingSeconds:(25-hour)*3600,errorPercent:50};
    f.calls[hour]!.finish(response);await f.flush();
    f.scheduler.tick();expect(f.calls).toHaveLength(hour+1);
  }
  expect(f.goals.view(key,24*3600000+15000)?.activeSeconds).toBe(86415);
  expect(f.scheduler.stats().disabled).toBe(false);
  await f.scheduler.close();
});

it.each(['session-end','server-close'])('retains exactly one cancelled result and usage after %s removes goal state',async kind=>{
  const records:ObserverObservation[]=[];
  const f=fixture(1,6000,value=>records.push(value));
  const key=f.hook('UserPromptSubmit');f.hook('PostToolUse');f.time(15000);f.scheduler.tick();
  f.time(18000);
  let closing:Promise<void>|undefined;
  if(kind==='session-end'){f.goals.end(key);f.scheduler.end(key);}
  else{f.goals.clear();closing=f.scheduler.close();}
  f.calls[0]!.finish({...result(),status:'aborted',interpretation:null});await f.flush();
  if(closing)await closing;
  const results=records.filter(value=>value.kind==='result');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({key,generation:0,requestId:1,requestedAt:15000,observedActiveSeconds:15,accepted:false,status:'aborted',usage});
  if(!closing)await f.scheduler.close();
});

it('does not attribute a removed generation result to the replacement goal clock',async()=>{
  const records:ObserverObservation[]=[];const f=fixture(1,6000,value=>records.push(value));
  const key=f.hook('UserPromptSubmit');f.hook('PostToolUse');f.time(15000);f.scheduler.tick();
  // A separate host lifecycle replaces the goal object while a stale callback is pending.
  f.goals.clear();f.contexts.clear();f.time(20000);f.hook('UserPromptSubmit','one','second');f.hook('PostToolUse','one','second');
  const replacement=f.goals.request(key,20000)!;
  f.goals.settle(replacement.ticket,result().interpretation,20000);
  f.time(23000);f.calls[0]!.finish(result());await f.flush();
  expect(records.find(value=>value.kind==='result')).toMatchObject({generation:0,activeSeconds:15,runtime:'running',activeTimeKnown:false,accepted:false});
  await f.scheduler.close();
});

it('dispatches from the user goal at 15s before a long tool returns, without unchanged polling', async () => {
  const f = fixture(); f.hook('UserPromptSubmit');
  f.time(14000); f.scheduler.tick(); expect(f.calls).toHaveLength(0);
  f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(result()); await f.flush();
  f.time(900000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result()); await f.flush();
});

it('records distinct skip reasons once per transition without leaking prompt content', async () => {
  const records:ObserverObservation[]=[];
  const f=fixture(1,6000,row=>records.push(row));
  f.hook('PostToolUse');f.time(15000);f.scheduler.tick();f.scheduler.tick();
  f.hook('UserPromptSubmit');f.scheduler.tick();f.scheduler.tick();
  f.time(30000);f.scheduler.tick();
  expect(f.calls).toHaveLength(1);
  f.scheduler.tick();f.scheduler.tick();
  f.calls[0]!.finish(result());await f.flush();
  f.scheduler.tick();f.scheduler.tick();
  expect(records.filter(row=>row.kind==='skip').map(row=>row.status)).toEqual([
    'context_missing','event_coalescing','request_in_flight','cooldown']);
  expect(JSON.stringify(records)).not.toContain('task data');
  await f.scheduler.close();
});

it('resets the summary for a new turn without requiring another tool result', async () => {
  const f=fixture(1);const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(result());await f.flush();
  f.time(80000);f.hook('UserPromptSubmit','one','second');
  f.time(95000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.input).toMatchObject({goalSummary:null,activeSeconds:15});
  f.calls[1]!.finish(result('continue'));await f.flush();
  expect(f.goals.view(key,95000)?.prediction).not.toBeNull();
  await f.scheduler.close();
});

it('admits distinct user-only conversations without a global two-slot ceiling', async () => {
  const f = fixture(2, 6000, undefined, false, true);
  for (const session of ['one', 'two', 'three']) {f.hook('UserPromptSubmit', session);}
  f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(3);
  expect(f.scheduler.stats().inFlight).toBe(3);
  for (const call of f.calls) call.finish(result());
  await f.flush();
  await f.scheduler.close();
});

it.each(['paused','interrupted','stopped','failed'] as const)('does not start an initial user-only estimate while %s', state=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');
  const turn=f.contexts.read(key)!.entries[0]!.turnKey;
  f.time(10000);f.goals.runtime(key,turn,state,10000);f.scheduler.changed(key,'runtime');
  f.time(15000);f.scheduler.tick();expect(f.calls).toHaveLength(0);
});

it('retries unknown estimates after 300, 600 and 1800 active seconds without new text',async()=>{
  const f=fixture(1);const key=f.hook('UserPromptSubmit');
  f.time(15000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  const response=result();response.interpretation!.estimate=null;
  f.calls[0]!.finish(response);await f.flush();
  expect(f.goals.view(key,15000)?.prediction).toBeNull();
  for(const [index,at] of [315000,915000,2715000].entries()){
    f.time(at-1);f.scheduler.tick();expect(f.calls).toHaveLength(index+1);
    f.time(at);f.scheduler.tick();expect(f.calls).toHaveLength(index+2);
    const next=result('continue');next.interpretation!.estimate=null;
    f.calls[index+1]!.finish(next);await f.flush();
  }
  await f.scheduler.close();
});

it('keeps authenticated conversation identity outside model input across slot reuse', async () => {
  const f = fixture(1);
  const first = f.hook('UserPromptSubmit', 'one'); f.hook('PostToolUse', 'one');
  const second = f.hook('UserPromptSubmit', 'two'); f.hook('PostToolUse', 'two');
  f.time(15000); f.scheduler.tick();
  expect(f.calls[0]!.key).toBe(first);
  expect(JSON.stringify(f.calls[0]!.input)).not.toContain(first);
  f.calls[0]!.finish(result()); await f.flush(); f.scheduler.tick();
  expect(f.calls[1]!.key).toBe(second);
  expect(second).not.toBe(first);
  expect(JSON.stringify(f.calls[1]!.input)).not.toContain(second);
  f.calls[1]!.finish(result()); await f.flush();
  await f.scheduler.close();
});

it('rejects stale prompt results without freeing a still-running conversation slot early', async () => {
  const f = fixture(); const session = f.hook('UserPromptSubmit'); f.hook('PostToolUse');
  f.time(15000); f.scheduler.tick();
  f.time(20000); f.hook('UserPromptSubmit', 'one', 'second'); f.hook('PostToolUse', 'one', 'second');
  f.time(90000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(result()); await f.flush();
  expect(f.goals.view(session, 90000)?.prediction).toBeNull();
  f.scheduler.tick(); expect(f.calls).toHaveLength(2);
});

it('allows a coalesced final-status judgment in waiting but no repeated waiting polls', async () => {
  const f = fixture(); const session = f.hook('UserPromptSubmit'); f.hook('PostToolUse');
  f.time(15000); f.scheduler.tick(); f.calls[0]!.finish(result()); await f.flush();
  f.time(20000); f.hook('Stop');
  f.time(74000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.time(75000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish({...result('continue'), interpretation: {relation: 'continue', status: 'waiting', summary: null, estimate: null}});
  await f.flush(); f.time(900000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  expect(f.goals.view(session, 900000)?.activeSeconds).toBe(20);
});

it('cancels an in-flight call on pause and resumes only after event coalescing', async () => {
  const f = fixture(); const session = f.hook('UserPromptSubmit'); f.hook('PostToolUse');
  const turn = f.contexts.read(session)!.entries[0]!.turnKey;
  f.time(15000); f.scheduler.tick();
  f.time(20000); f.goals.runtime(session, turn, 'paused', 20000); f.scheduler.changed(session, 'runtime');
  expect(f.calls[0]!.signal.aborted).toBe(true);
  f.calls[0]!.finish({status: 'aborted', interpretation: null, usage}); await f.flush();
  f.time(100000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.goals.runtime(session, turn, 'running', 100000); f.scheduler.changed(session, 'runtime');
  f.time(109999); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.time(110000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
});

it('retains its original worker ownership when the caller mutates the configuration array', async () => {
  const contexts = new PassiveContextStore(), goals = new PassiveGoals(contexts); let closed = false;
  const workers: ObserverWorker[] = [{observe: async () => result(), disable() {},
    status: () => ({active: false, disabled: false, poisoned: false}), async close() {closed = true;}}];
  const scheduler = new ObserverScheduler({contexts, goals, workers, now: () => 0});
  workers.length = 0;
  await scheduler.close();
  expect(closed).toBe(true);
});

it('retires an unconfirmed worker locally without disabling healthy conversations', async () => {
  const f = fixture(2, 6000, undefined, false, true); f.hook('UserPromptSubmit'); f.hook('PostToolUse');
  f.time(15000); f.scheduler.tick();
  f.calls[0]!.finish(result(), false); await f.flush();
  expect(f.scheduler.stats()).toMatchObject({disabled: false, inFlight: 0});
  f.time(130000); f.hook('UserPromptSubmit', 'two'); f.hook('PostToolUse', 'two');
  f.time(145000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result()); await f.flush();
  await expect(f.scheduler.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
  f.calls[0]!.finish(result(), true); await f.flush();
});

it('disables further admission after unknown usage even if a child has closed', async () => {
  const f = fixture(); f.hook('UserPromptSubmit'); f.hook('PostToolUse');
  f.time(15000); f.scheduler.tick();
  f.calls[0]!.finish({status: 'process_error', interpretation: null, usage: null}); await f.flush();
  expect(f.scheduler.stats()).toMatchObject({disabled: false, inFlight: 0});
});

it('bounds shutdown when an owned worker never acknowledges cancellation', async () => {
  const f = fixture(1, 25); f.hook('UserPromptSubmit'); f.hook('PostToolUse');
  f.time(15000); f.scheduler.tick();
  await expect(f.scheduler.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
  expect(f.calls[0]!.signal.aborted).toBe(true);
  expect(f.scheduler.stats().inFlight).toBe(1);
  f.calls[0]!.finish({status: 'aborted', interpretation: null, usage: null}); await f.flush();
});

it('attempts every worker cleanup even if another worker close throws synchronously', async () => {
  const contexts = new PassiveContextStore(), goals = new PassiveGoals(contexts); let secondClosed = false;
  const base = {observe: async () => result(), status: () => ({active: false, disabled: false, poisoned: false}), disable() {}};
  const scheduler = new ObserverScheduler({contexts, goals, now: () => 0, workers: [
    {...base, close() {throw new Error('private failure');}},
    {...base, async close() {secondClosed = true;}}
  ]});
  await expect(scheduler.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
  expect(secondClosed).toBe(true);
});

it('continues observing replacements beyond twelve calls while retaining the minimum spacing', async () => {
  const f = fixture(1);
  for (let index = 0; index < 13; index++) {
    f.time(index * 70000); f.hook('UserPromptSubmit', 'one', `turn-${index}`); f.hook('PostToolUse', 'one', `turn-${index}`);
    f.time(index * 70000 + 15000); f.scheduler.tick();
    expect(f.calls).toHaveLength(index + 1); f.calls[index]!.finish(result()); await f.flush();
  }
  expect(f.calls).toHaveLength(13);
  await f.scheduler.close();
});

it('dispatches selected-source changes only when the source revision changes', async () => {
  const f = selectedSourceFixture();
  const key = f.hook(); f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(result()); await f.flush();

  f.time(100000); f.setSource(1); f.scheduler.changed(key, 'activity'); f.scheduler.tick();
  expect(f.calls).toHaveLength(1);

  f.setSource(2); f.scheduler.tick();
  f.time(315000); f.scheduler.tick();
  expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result()); await f.flush();
  await f.scheduler.close();
});

it('permits exactly one overdue recheck for a selected-source action', async () => {
  const f = selectedSourceFixture();
  f.hook(); f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  const overdue = result(); overdue.interpretation!.estimate = {remainingSeconds: 0, errorPercent: 30};
  f.calls[0]!.finish(overdue); await f.flush();

  f.time(74000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.time(75000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result()); await f.flush();

  f.time(135000); f.scheduler.tick();
  expect(f.calls).toHaveLength(2);
  await f.scheduler.close();
});

it('permits overdue rechecks without an action id and backs off repeated expired answers', async () => {
  const f = selectedSourceFixture();
  f.setSource(1, null);
  f.hook(); f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  const expired = result(); expired.interpretation!.estimate = {remainingSeconds: 0, errorPercent: 30};
  f.calls[0]!.finish(expired); await f.flush();

  f.time(74999); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  f.time(75000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  const expiredAgain = result('continue'); expiredAgain.interpretation!.estimate = {remainingSeconds: 0, errorPercent: 30};
  f.calls[1]!.finish(expiredAgain); await f.flush();

  f.time(135000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.time(374999); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  f.time(375000); f.scheduler.tick(); expect(f.calls).toHaveLength(3);
  f.calls[2]!.finish(result('continue')); await f.flush();
  await f.scheduler.close();
});

it('records static trigger reasons and active scheduling anchors', async () => {
  const records:ObserverObservation[]=[];
  const f=fixture(1,6000,row=>records.push(row));
  const key=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  expect(records.find(row=>row.kind==='request')).toMatchObject({triggerReason:'initial',
    lastRequestActiveSeconds:null,eligibleActiveSeconds:null});
  f.calls[0]!.finish(result());await f.flush();
  f.time(314000);f.scheduler.tick();
  f.time(315000);f.scheduler.tick();
  const request=records.filter(row=>row.kind==='request').at(-1);
  expect(request).toMatchObject({triggerReason:'periodic',lastRequestActiveSeconds:15,
    eligibleActiveSeconds:315});
  expect(JSON.stringify(records)).not.toContain('task data');
  f.calls[1]!.finish(result('continue')); await f.flush();
  await f.scheduler.close();
});

it('rebases the scheduler active anchor when an accepted replacement rebases the goal clock', async () => {
  const f=fixture(1);const key=f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish(result());await f.flush();
  f.time(100000);f.hook('UserPromptSubmit','one','second');f.time(160000);f.scheduler.tick();
  expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result());await f.flush();
  f.time(459000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.time(460000);f.scheduler.tick();expect(f.calls).toHaveLength(3);
  f.calls[2]!.finish(result('continue'));await f.flush();
  expect(f.goals.view(key,460000)?.activeSeconds).toBe(360);
  await f.scheduler.close();
});

it('does not let one conversation reason class defeat round-robin rotation', async () => {
  const f=fixture(1);const first=f.hook('UserPromptSubmit','one');const second=f.hook('UserPromptSubmit','two');
  f.time(15000);f.scheduler.tick();expect(f.calls[0]!.key).toBe(first);
  f.calls[0]!.finish(result());await f.flush();f.scheduler.tick();expect(f.calls[1]!.key).toBe(second);
  f.calls[1]!.finish(result());await f.flush();
  f.time(315000);f.hook('UserPromptSubmit','two','second');f.scheduler.tick();
  expect(f.calls[2]!.key).toBe(first);
  f.calls[2]!.finish(result('continue'));await f.flush();
  await f.scheduler.close();
});

it('freezes scheduling anchors while the selected source is unavailable', async () => {
  const f=selectedSourceFixture();const key=f.hook();f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish(result());await f.flush();
  f.setAvailable(false);f.time(3600000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.setAvailable(true);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  expect(f.goals.view(key,3600000)?.activeSeconds).toBe(3600);
  f.time(3615000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(3899999);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  f.time(3900000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result('continue'));await f.flush();
  await f.scheduler.close();
});

it('preserves the overdue reservation across a source outage', async()=>{
  const f=selectedSourceFixture();f.hook();f.time(15000);f.scheduler.tick();
  const expired=result();expired.interpretation!.estimate={remainingSeconds:0,errorPercent:30};
  f.calls[0]!.finish(expired);await f.flush();
  f.time(75000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish({status:'admission_denied',interpretation:null,usage:null});await f.flush();
  f.setAvailable(false);f.time(76000);f.scheduler.tick();
  f.time(3600000);f.setAvailable(true);f.scheduler.tick();
  f.time(3615000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.time(3900000);f.scheduler.tick();expect(f.calls).toHaveLength(3);
  f.calls[2]!.finish(result('continue'));await f.flush();await f.scheduler.close();
});

it('excludes an outage from the age of a prediction returned by an in-flight call',async()=>{
  const f=selectedSourceFixture();f.hook();f.time(15000);f.scheduler.tick();
  f.setAvailable(false);f.time(16000);f.scheduler.tick();
  f.time(3600000);f.setAvailable(true);f.scheduler.tick();
  f.calls[0]!.finish(result());await f.flush();
  f.time(3615000);f.scheduler.tick();expect(f.calls).toHaveLength(1);
  await f.scheduler.close();
});

it('keeps an event received in the same millisecond as dispatch pending', async () => {
  const f=fixture(1);f.hook('UserPromptSubmit');f.time(15000);f.scheduler.tick();
  f.calls[0]!.finish(result());await f.flush();
  f.hook('UserPromptSubmit','one','second');
  f.time(75000);f.scheduler.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result('continue'));await f.flush();
  await f.scheduler.close();
});

it('fences transient retry and status state by source goal identity', async () => {
  const f=selectedSourceFixture();f.hook();f.time(15000);f.scheduler.tick();
  f.setEpoch(1);f.scheduler.tick();
  f.calls[0]!.finish(transientResult());await f.flush();
  expect(f.scheduler.diagnostics(f.calls[0]!.key)).toMatchObject({retryPending:false,state:'pending'});
  await f.scheduler.close();
});

it('does not schedule an overdue retry when the selected source has no current action', async () => {
  const f = selectedSourceFixture();
  f.hook(); f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(1);
  const overdue = result(); overdue.interpretation!.estimate = {remainingSeconds: 0, errorPercent: 30};
  f.calls[0]!.finish(overdue); await f.flush();
  f.setSource(2, null);

  f.time(75000); f.scheduler.tick();
  expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish(result('continue')); await f.flush();
  await f.scheduler.close();
});

it('keeps overdue rechecks isolated by conversation and preserves the global limit', async () => {
  const f = selectedSourceFixture(2);
  const first = f.hook('one'); const second = f.hook('two');
  f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(2);
  for (const call of f.calls) {
    const overdue = result(); overdue.interpretation!.estimate = {remainingSeconds: 0, errorPercent: 30};
    call.finish(overdue);
  }
  await f.flush();

  f.time(75000); f.scheduler.tick();
  expect(f.calls.filter(call => call.key === first)).toHaveLength(2);
  expect(f.calls.filter(call => call.key === second)).toHaveLength(2);
  expect(f.scheduler.stats().inFlight).toBe(2);
  expect(f.calls[2]!.key).toBe(first);
  expect(f.calls[3]!.key).toBe(second);
  f.calls[2]!.finish(result()); f.calls[3]!.finish(result()); await f.flush();
  await f.scheduler.close();
});

it('does not let continuous source reconciliation starve the initial estimate', async () => {
  const f = selectedSourceFixture();
  f.hook();
  for (const time of [5000, 10000, 15000]) {
    f.time(time); f.setSource(time / 5000 + 1); f.scheduler.tick();
  }
  expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(result()); await f.flush();
  await f.scheduler.close();
});

it('attaches delayed persisted final evidence once when a waiting source revision arrives', async () => {
  const f = selectedSourceFixture();
  const key = f.hook();
  f.time(10000); f.stop();
  f.time(15000); f.scheduler.tick(); expect(f.calls).toHaveLength(0);

  f.time(50000); f.setSource(2, 'action', true); f.scheduler.tick();
  f.time(60000); f.scheduler.tick();
  expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(result('continue')); await f.flush();

  f.time(80000); f.scheduler.tick();
  expect(f.calls).toHaveLength(1);
  expect(f.goals.view(key, 80000)?.runtime).toBe('waiting');
  await f.scheduler.close();
});
