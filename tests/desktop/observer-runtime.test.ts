import {expect, afterEach, describe, it, vi} from 'vitest';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import type {ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import type {ObserverAttestation} from '../../src/estimation/observer-consent.js';
import type {ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';
import type {SubscriptionAccounting} from '../../src/estimation/subscription-accounting.js';
import type {Invocation} from '../../src/estimation/owned-process.js';
import {createDesktopObserverRuntime} from '../../src/desktop/observer-runtime.js';
import {createObserverProviderHost} from '../../src/desktop/observer-provider-host.js';
import {createNativeRetentionPermit, type NativeRetentionPermit, type NativeRetentionState} from '../../src/estimation/native-owner-retention.js';
import {ObserverScheduler, type ObserverObservation} from '../../src/estimation/observer-scheduler.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createObserverConsentStore} from '../../src/estimation/observer-consent-store.js';

const input: ObserverInput = {
  goalSummary: 'Build a report',
  activeSeconds: 20,
  runtime: 'running',
  messages: [{kind: 'user', text: 'Build the report', truncated: false}],
  truncated: false,
};
it('carries one-use session proof through serialized desktop checks and revokes it with consent',async()=>{
 const events:string[]=[],signal=new AbortController().signal;let options:any,claimed=0;
 const policies:unknown[]=[];
 const rawProof={validate:async()=>true,valid:()=>true};
 const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),
  identity:{...identityFor(()=>0,events),invalidateSessionReuse:()=>{events.push('identity-reuse-invalidated');},prepareSession:async(_signal,policy)=>{policies.push(policy);return {accountLabel:'synthetic',evidence:evidence(0),invocation:invocation(),
   validateAcceptance:async()=>true,reuse:{claim:async()=>{claimed++;return rawProof;},invalidate:()=>{events.push('reuse-invalidated');}}};}},
  persistentReceiptDirectory:'test-receipts',persistentWorkerFactory:configuration=>{options=configuration;return {
   observe:async()=>({status:'interpreted',interpretation:null,usage:null}),status:()=>({active:false,disabled:false,poisoned:false}),disable(){},close:async()=>{}};}});
 try{
  await runtime.start(signal);runtime.workerSource.acquire('source');
  const prepared=await options.prepareSession(signal,{accountCache:'allow'});
  expect(policies).toEqual([{accountCache:'allow'}]);
  expect(prepared.reuse).toBeDefined();
  const [proof,second]=await Promise.all([prepared.reuse.claim(signal),prepared.reuse.claim(signal)]);
  expect(proof.valid()).toBe(true);expect(second).toBeNull();expect(claimed).toBe(1);
  expect(await proof.validate(signal)).toBe(true);
  expect(prepared.validateAcceptance).toBeTypeOf('function');
  expect(await prepared.validateAcceptance(signal)).toBe(true);
  await runtime.revokeConsent();
  expect(events).toContain('identity-reuse-invalidated');
  expect(proof.valid()).toBe(false);expect(await proof.validate(signal)).toBe(false);
  expect(await prepared.validateAcceptance(signal)).toBe(false);
 }finally{await runtime.close();}
});
it('does not refresh the original evidence expiry when checking a reused desktop proof',async()=>{
 const events:string[]=[],signal=new AbortController().signal;let now=0,options:any;
 const runtime=createDesktopObserverRuntime({now:()=>now,dialog:dialogFor(events),openAccounting:async()=>owner(events),
  identity:{...identityFor(()=>now,events),prepareSession:async()=>({accountLabel:'synthetic',evidence:{...evidence(0),expiresAt:50},invocation:invocation(),
   reuse:{claim:async()=>({validate:async()=>true,valid:()=>true}),invalidate(){}}})},
  persistentReceiptDirectory:'test-receipts',persistentWorkerFactory:configuration=>{options=configuration;return {
   observe:async()=>({status:'interpreted',interpretation:null,usage:null}),status:()=>({active:false,disabled:false,poisoned:false}),disable(){},close:async()=>{}};}});
 try{
  await runtime.start(signal);runtime.workerSource.acquire('source');
  const prepared=await options.prepareSession(signal);
  expect(prepared.reuse).toBeDefined();const proof=await prepared.reuse.claim(signal);
  now=50;expect(await proof.validate(signal)).toBe(false);expect(proof.valid()).toBe(false);
 }finally{await runtime.close();}
});
it('serializes account preparations and rejects a queued cancellation without touching shared identity',async()=>{
 const events:string[]=[],signal=new AbortController().signal;
 const held=deferred<void>();let options:any,reads=0,invalidations=0;
 const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),
  identity:{...identityFor(()=>0,events),invalidateSessionReuse:()=>{invalidations++;},prepareSession:async()=>{
   reads++;await held.promise;return {accountLabel:'synthetic',evidence:evidence(0),invocation:invocation()};}},
  persistentReceiptDirectory:'test-receipts',persistentWorkerFactory:value=>{options=value;return {
   observe:async()=>({status:'disabled',interpretation:null,usage:null}),status:()=>({active:false,disabled:false,poisoned:false}),disable(){},close:async()=>{}};}});
 try{
  await runtime.start(signal);runtime.workerSource.acquire('source');
  const first=options.prepareSession(signal,{accountCache:'allow'});
  await vi.waitFor(()=>expect(reads).toBe(1));
  const cancelled=new AbortController();
  const second=options.prepareSession(cancelled.signal,{accountCache:'allow'});
  const rejected=expect(second).rejects.toThrow();cancelled.abort();held.resolve();
  await first;await rejected;
  expect(reads).toBe(1);expect(invalidations).toBe(0);
 }finally{held.resolve();await runtime.close();}
});
it('retains a healthy persistent worker between scheduler operations and closes it on shutdown',async()=>{
  const events:string[]=[];let created=0,released=0,closed=0;
  const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),identity:identityFor(()=>0,events),
    persistentReceiptDirectory:'test-receipts',
    persistentWorkerFactory:()=>{created++;return {observe:async()=>({status:'interpreted',interpretation:JSON.parse(interpretation),usage:null}),
      status:()=>({active:false,disabled:false,poisoned:false}),disable(){},close:async()=>{closed++;},release:async()=>{released++;}};}});
  try{
    await runtime.start(new AbortController().signal);
    const first=runtime.workerSource.acquire('persistent');
    await first.observe(input,new AbortController().signal,'persistent',0);
    await runtime.workerSource.release('persistent');
    expect(runtime.workerSource.acquire('persistent')).toBe(first);
    expect(created).toBe(1);expect(released).toBe(1);expect(closed).toBe(0);
  }finally{await runtime.close();}
  expect(closed).toBeGreaterThan(0);
});
it('carries retention through provider host and runtime, including revocation with no outer lease',async()=>{
 const events:string[]=[],directory=await mkdtemp(join(tmpdir(),'hud-runtime-host-retention-'));
 const state={conversationKey:'source',turnKey:'turn',generation:0,running:true};
 const permit=createNativeRetentionPermit({...state,idleStartedAtMs:0,nextOrdinaryAtMs:300000});
 const receivedPermits:Array<NativeRetentionPermit|null|undefined>=[],receivedStates:Array<NativeRetentionState|null>=[];
 let created=0,closed=0;
 const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),identity:identityFor(()=>0,events),
  persistentReceiptDirectory:'test-receipts',persistentWorkerFactory:()=>{created++;return {
   observe:async()=>({status:'disabled',interpretation:null,usage:null}),status:()=>({active:false,disabled:false,poisoned:false}),
   disable(){},close:async()=>{closed++;},release:async value=>{receivedPermits.push(value);},
   updateRetentionState:value=>{receivedStates.push(value);}};}});
 const host=await createObserverProviderHost({dataDirectory:directory,autoStartSubscription:true,
  consentProtection:{protect:value=>value,unprotect:value=>value},openSubscription:async()=>{
   await runtime.start(new AbortController().signal);
   return {...runtime,inspect:async()=>({label:'synthetic',fingerprint:'synthetic'})};}});
 try{
  await host.start(new AbortController().signal);
  host.workerSource!.acquire('source');host.workerSource!.updateRetentionState!('source',state);
  await host.workerSource!.release('source',permit);
  expect(receivedPermits).toEqual([permit]);expect(closed).toBe(0);
  host.workerSource!.updateRetentionState!('source',null);
  expect(receivedStates).toEqual([state,null]);
  host.workerSource!.acquire('source');expect(created).toBe(1);
 }finally{await host.close();await runtime.close();await rm(directory,{recursive:true,force:true});}
 expect(closed).toBeGreaterThan(0);
});
it('does not replace a poisoned native owner whose cleanup is still unconfirmed',async()=>{
 const events:string[]=[];let created=0,poisoned=false;
 const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),identity:identityFor(()=>0,events),
  persistentReceiptDirectory:'test-receipts',persistentWorkerFactory:()=>{created++;return {
   observe:async()=>({status:'disabled',interpretation:null,usage:null}),
   status:()=>({active:false,disabled:false,poisoned,cleanupPending:true}),disable(){},close:async()=>{poisoned=false;}};}});
 try{
  await runtime.start(new AbortController().signal);const first=runtime.workerSource.acquire('native');
  poisoned=true;
  expect(()=>runtime.workerSource.acquire('native')).toThrow('OBSERVER_WORKER_CLEANUP_PENDING');
  expect(created).toBe(1);expect(runtime.workerSource.all()).toContain(first);
 }finally{await runtime.close();}
});
it.each(['dynamic','compatibility'])('forwards stage diagnostics through the %s runtime worker',async mode=>{
  const events:string[]=[],stages:string[]=[];
  const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),identity:identityFor(()=>0,events)});
  try{
    await runtime.start(new AbortController().signal);
    const worker=mode==='dynamic'?runtime.workerSource.acquire('stages'):runtime.workers[0]!;
    const result=await worker.observe(input,new AbortController().signal,'stages',0,stage=>stages.push(stage));
    expect(result.status).toBe('interpreted');
    expect(stages).toContain('settlement');
    expect(stages.at(-1)).toBe('finished');
  }finally{await runtime.close();}
});

const interpretation = JSON.stringify({
  relation: 'continue',
  status: 'running',
  summary: 'Building the report',
  estimate: {remainingSeconds: 7200, errorPercent: 40},
});

const observerOutput = [
  JSON.stringify({type: 'turn.started'}),
  JSON.stringify({type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: interpretation}}),
  JSON.stringify({type: 'turn.completed', usage: {input_tokens: 20, output_tokens: 3, cached_input_tokens: 5}}),
].join('\n') + '\n';

type Provenance = {input:string;prompt:string;model:string;algorithm:string};

interface RuntimeIdentity {
  inspect(signal: AbortSignal): Promise<{accountLabel: string; evidence: ObserverAttestation}>;
  prepareEstimate(input: ObserverInput, signal: AbortSignal): Promise<{accountLabel: string; evidence: ObserverAttestation; invocation: Invocation; provenance?: Provenance}>;
  disable(): void;
  close(): Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {resolve = nextResolve; reject = nextReject;});
  return {promise, resolve, reject};
}

function invocation(): Invocation {
  return {
    executable: process.execPath,
    cwd: process.cwd(),
    args: ['-e', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(observerOutput)}))`],
    env: process.env,
    input: '',
  };
}

function owner(events: string[]): ReleaseAccountingOwner {
  let next = 0;
  let closed = false;
  const views = new Set<SubscriptionAccounting>();
  return {
    forConversation(key: string): SubscriptionAccounting {
      const view: SubscriptionAccounting = {
        reserve: async () => {
          if (closed) return null;
          events.push(`reserve:${key}`);
          return `reservation-${next++}`;
        },
        settle: async (_id, usage) => {events.push(`settle:${key}:${usage ? 'known' : 'unknown'}`);},
        bindInvocation:async()=>{events.push(`bind:${key}`);},
        updateInvocation:async(_id,patch)=>{events.push(`identity:${key}:${patch.phase}`);},
        cancelBeforeDispatch:async()=>{events.push(`not-dispatched:${key}`);},
        close: async () => {events.push(`view-close:${key}`); views.delete(view);},
      };
      views.add(view);
      return view;
    },
    snapshot: () => ({starts: next, activeStarts: next, inFlight: 0, unresolved: 0, knownTokens: 0, unknown: 0, poisoned: false}),
    close: async () => {closed = true; events.push('accounting-close');},
  };
}

function evidence(now: number, accountFingerprint = 'a'.repeat(64)): ObserverAttestation {
  return {
    accountFingerprint,
    routeFingerprint: 'b'.repeat(64),
    assetsFingerprint: 'c'.repeat(64),
    observedAt: now,
    expiresAt: now + 300000,
  };
}

function identityFor(clock: () => number, events: string[], options: {
  inspect?: () => ObserverAttestation;
  prepare?: () => Promise<void> | void;
  closeError?: Error;
  invocation?: () => Invocation;
  provenance?: () => Provenance;
} = {}): RuntimeIdentity {
  return {
    inspect: async signal => {
      if (signal.aborted) throw new Error('ABORTED');
      events.push('inspect');
      return {accountLabel: 'synthetic@example.invalid', evidence: options.inspect?.() ?? evidence(clock())};
    },
    prepareEstimate: async (_input, signal) => {
      if (signal.aborted) throw new Error('ABORTED');
      events.push('prepare');
      await options.prepare?.();
      const prepared={accountLabel: 'synthetic@example.invalid', evidence: options.inspect?.() ?? evidence(clock()), invocation: options.invocation?.() ?? invocation()};
      return options.provenance?{...prepared,provenance:options.provenance()}:prepared;
    },
    disable: () => {events.push('identity-disable');},
    close: async () => {events.push('identity-close'); if (options.closeError) throw options.closeError;},
  };
}

function dialogFor(events: string[], response = 0) {
  return {showMessageBox: async () => {events.push('dialog'); return {response};}};
}

describe('desktop observer runtime composition', () => {
  afterEach(() => {vi.useRealTimers();});
  it('rejects startup account drift before consent or an account-scoped ledger is opened',async()=>{
    const events:string[]=[];
    const runtime=createDesktopObserverRuntime({identity:identityFor(()=>0,events,{inspect:()=>evidence(0,'b'.repeat(64))}),
      dialog:dialogFor(events),now:()=>0,accountingAccountFingerprint:'a'.repeat(64),
      openAccounting:async()=>{events.push('open-accounting');return owner(events);}});
    try{
      await expect(runtime.start(new AbortController().signal)).rejects.toThrow('OBSERVER_SETUP_UNAVAILABLE');
      expect(events).not.toContain('dialog');expect(events).not.toContain('open-accounting');
      expect(runtime.workers.every(worker=>worker.status().disabled)).toBe(true);
    }finally{await runtime.close();}
  });

  it('rejects an inline activation when setup fails instead of reporting completion', async () => {
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({identity: identityFor(() => 0, events),
      dialog: dialogFor(events), now: () => 0,
      openAccounting: async () => {throw new Error('PRIVATE_STORAGE_ERROR');}});
    try {
      await expect(runtime.start(new AbortController().signal, {kind: 'inline', accountFingerprint: 'a'.repeat(64), generation: 1, revision: 1})).rejects.toThrow('OBSERVER_SETUP_UNAVAILABLE');
      expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    } finally {await runtime.close();}
  });

  it('accepts only a matching inline account binding and does not open the legacy consent dialog', async () => {
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal, {kind: 'inline', accountFingerprint: 'a'.repeat(64), generation: 1, revision: 1});
    expect(events).not.toContain('dialog');
    expect(runtime.workers.every(worker => !worker.status().disabled)).toBe(true);
    await runtime.close();
  });

  it('captures sanitized exit and HTTP details through the actual recovery runner',async()=>{
    const events:string[]=[];
    const runtime=createDesktopObserverRuntime({now:()=>0,dialog:dialogFor(events),openAccounting:async()=>owner(events),
      identity:identityFor(()=>0,events,{invocation:()=>({...invocation(),args:['-e',"process.stderr.write('HTTP 403 token=SECRET private@example.invalid');process.exitCode=7;"]})})});
    try{
      await runtime.start(new AbortController().signal);
      const trial=await runtime.recoveryBoundary().runTrial('synthetic-reservation',new AbortController().signal);
      expect(trial).toMatchObject({success:false,usage:null,diagnostic:{reason:'exited',exitCode:7,parserError:'protocol',errorCategories:['http_403']}});
      expect(JSON.stringify(trial)).not.toMatch(/SECRET|private@example/);
    }finally{await runtime.close();}
  });

  it('obtains reboot proof inside the authorized runtime boundary before reconciliation', async () => {
    const events: string[] = [];
    const proof = {source: 'windows-win32-operating-system' as const, bootAt: 10_001, observedAt: 20_000};
    const accounting = owner(events) as ReleaseAccountingOwner & {
      recoveryStatus: () => {state: 'blocked'; revision: number; knownTokens: number; unknown: number; recoveryAllowed: boolean; reason: 'unresolved_previous_call'};
      reconcileRecoveredPending: (value: typeof proof) => Promise<number>;
    };
    accounting.recoveryStatus = () => ({state: 'blocked', revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: true, reason: 'unresolved_previous_call'});
    accounting.reconcileRecoveredPending = vi.fn(async value => {expect(value).toEqual(proof); return 1;});
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 20_000, events),
      dialog: dialogFor(events),
      openAccounting: async () => accounting,
      now: () => 20_000,
      inspectRecoveryBootBoundary: async () => proof,
    });
    try {
      await runtime.start(new AbortController().signal);
      expect(accounting.reconcileRecoveredPending).toHaveBeenCalledOnce();
      await expect(runtime.recoveryBoundary().check(new AbortController().signal)).resolves.toMatchObject({binding: expect.any(String), closureConfirmed: true});
      expect(accounting.reconcileRecoveredPending).toHaveBeenCalledTimes(2);
    } finally { await runtime.close(); }
  });

  it('keeps startup available when same-boot orphan reconciliation cannot prove closure',async()=>{
    const events:string[]=[],accounting=owner(events);
    accounting.recoveryStatus=()=>({state:'blocked',revision:0,knownTokens:0,unknown:1,recoveryAllowed:true,reason:'unresolved_previous_call'});
    accounting.reconcileRecoveredPending=vi.fn(async()=>{throw Error('RELEASE_RECOVERY_INVALID');});
    const inspectProof=vi.fn(async()=>({source:'windows-win32-operating-system' as const,bootAt:0,observedAt:20000}));
    const runtime=createDesktopObserverRuntime({identity:identityFor(()=>20000,events),dialog:dialogFor(events),openAccounting:async()=>accounting,now:()=>20000,inspectRecoveryBootBoundary:inspectProof});
    try{
      await runtime.start(new AbortController().signal);
      expect(inspectProof).toHaveBeenCalledOnce();
      expect(accounting.recoveryStatus().reason).toBe('unresolved_previous_call');
      expect(runtime.workers.every(worker=>!worker.status().disabled)).toBe(true);
      expect(events.some(event=>event.startsWith('reserve:'))).toBe(false);
    }finally{await runtime.close();}
  });

  it('refuses orphan reconciliation after the account binding changes during the boot probe',async()=>{
    const events:string[]=[],accounting=owner(events);let account='a'.repeat(64);
    accounting.recoveryStatus=()=>({state:'blocked',revision:0,knownTokens:0,unknown:1,recoveryAllowed:true,reason:'unresolved_previous_call'});
    accounting.reconcileRecoveredPending=vi.fn(async()=>1);
    const runtime=createDesktopObserverRuntime({identity:identityFor(()=>20000,events,{inspect:()=>evidence(20000,account)}),dialog:dialogFor(events),openAccounting:async()=>accounting,now:()=>20000,
      inspectRecoveryBootBoundary:async()=>{account='d'.repeat(64);return {source:'windows-win32-operating-system',bootAt:10000,observedAt:20000};}});
    try{
      await runtime.start(new AbortController().signal);
      expect(accounting.reconcileRecoveredPending).not.toHaveBeenCalled();
      expect(runtime.workers.every(worker=>worker.status().disabled)).toBe(true);
    }finally{await runtime.close();}
  });

  it('cancels authorized dispatch before waiting for a consent deletion that fails',async()=>{
    const events:string[]=[];
    const deletion=deferred<void>();
    const runtime=createDesktopObserverRuntime({identity:identityFor(()=>0,events),dialog:dialogFor(events),
      openAccounting:async()=>owner(events),now:()=>0,
      consentStore:{read:async()=>null,grant:async()=>{},matches:()=>false,revoke:()=>deletion.promise}});
    await runtime.start(new AbortController().signal);
    expect(runtime.workers.every(worker=>!worker.status().disabled)).toBe(true);
    const revoke=runtime.revokeConsent();
    const rejected=expect(revoke).rejects.toThrow('STORAGE_LOCKED');
    const disabledImmediately=runtime.workers.every(worker=>worker.status().disabled);
    deletion.reject(Error('STORAGE_LOCKED'));
    try{
      await rejected;
      expect(disabledImmediately).toBe(true);
      await expect(runtime.workers[0]!.observe(input,new AbortController().signal,'after-revoke')).resolves.toMatchObject({status:'disabled'});
      expect(events).not.toContain('prepare');
    }finally{await runtime.close();}
  });

  it('keeps both slots unavailable and performs no dispatch before consent and accounting readiness', async () => {
    const events: string[] = [];
    const consent = deferred<{response: number}>();
    const accounting = deferred<ReleaseAccountingOwner>();
    const identity = identityFor(() => 0, events);
    const runtime = createDesktopObserverRuntime({identity, dialog: {showMessageBox: async () => {events.push('dialog'); return consent.promise;}}, openAccounting: () => accounting.promise, now: () => 0});
    const start = runtime.start(new AbortController().signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    expect(runtime.workers).toHaveLength(2);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    await expect(runtime.workers[0]!.observe(input, new AbortController().signal, 'before-ready')).resolves.toMatchObject({status: 'disabled'});
    expect(events).not.toContain('prepare');
    consent.resolve({response: 0});
    await vi.waitFor(() => expect(events).not.toContain('identity-disable'));
    await expect(runtime.workers[0]!.observe(input, new AbortController().signal, 'during-ledger-open')).resolves.toMatchObject({status: 'disabled'});
    expect(events).not.toContain('reserve:during-ledger-open');
    accounting.resolve(owner(events));
    await start;
    expect(runtime.workers.every(worker => !worker.status().disabled)).toBe(true);
    await runtime.close();
    expect(events).toContain('accounting-close');
  });

  it('exposes exactly two reusable accounted observer slots after authorization', async () => {
    const events: string[] = [];
    const accountingOwner = owner(events);
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: async () => accountingOwner,
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    expect(runtime.workers).toHaveLength(2);
    expect(new Set(runtime.workers).size).toBe(2);
    const results = await Promise.all(runtime.workers.map((worker, index) => worker.observe(input, new AbortController().signal, `conversation-${index}`)));
    expect(results.map(result => ({status:result.status,outcomes:result.outcomes}))).toEqual([
      expect.objectContaining({status:'interpreted'}),expect.objectContaining({status:'interpreted'})
    ]);
    expect(events.filter(event => event.startsWith('reserve:'))).toHaveLength(2);
    for(const key of ['conversation-0','conversation-1']){
      expect(events.indexOf(`bind:${key}`)).toBeGreaterThan(events.indexOf(`reserve:${key}`));
      expect(events.indexOf(`settle:${key}:known`)).toBeGreaterThan(events.indexOf(`identity:${key}:dispatching`));
      expect(events).toContain(`identity:${key}:closed`);
    }
    await runtime.close();
  });

  it('forwards slot provenance through the scheduler into an accepted forecast record', async () => {
    let now=0;const events:string[]=[];const contexts=new PassiveContextStore();const goals=new PassiveGoals(contexts);
    const records:ObserverObservation[]=[];
    const runtime=createDesktopObserverRuntime({
      identity:identityFor(()=>now,events,{provenance:()=>({input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'})}),
      dialog:dialogFor(events),openAccounting:async()=>owner(events),now:()=>now,
    });
    await runtime.start(new AbortController().signal);
    const scheduler=new ObserverScheduler({contexts,goals,workers:runtime.workers,now:()=>now,onObservation:row=>records.push(row)});
    const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'scheduler-runtime',turn_id:'first',tool_use_id:'one'},now,
      'protected-observer-scheduler-test-token-123456789').envelope;
    envelope.content={kind:'user',text:'Build the report',truncated:false};
    goals.observe(envelope,true,now);contexts.ingest(envelope,now);scheduler.changed(envelope.sessionKey,'prompt');
    now=15000;scheduler.tick();
    await vi.waitFor(()=>expect(records.find(row=>row.kind==='result')).toBeDefined());
    await vi.waitFor(()=>expect(records.find(row=>row.kind==='result')?.forecast).toMatchObject({versions:{model:'model-v1'}}));
    await scheduler.close();await runtime.close();
  });

  it('revokes a cancelled consent attempt and ignores its late dialog response', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const consent = deferred<{response: number}>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: {showMessageBox: async () => {events.push('dialog'); return consent.promise;}},
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    const start = runtime.start(controller.signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    controller.abort();
    await start;
    consent.resolve({response: 0});
    await Promise.resolve();
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    expect(events).not.toContain('accounting-close');
    await runtime.close();
  });

  it('refreshes the same identity binding every 120 seconds beyond the initial five-minute evidence window', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    for (let index = 0; index < 4; index++) {
      clock += 120000;
      await vi.advanceTimersByTimeAsync(120000);
    }
    expect(events.filter(event => event === 'inspect').length).toBeGreaterThanOrEqual(5);
    expect(runtime.workers.every(worker => !worker.status().disabled)).toBe(true);
    await runtime.close();
  });

  it('suspends dispatch during a temporary identity refresh failure and resumes after revalidation', async () => {
    vi.useFakeTimers();
    let clock = 0, inspections = 0;
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events, {inspect: () => { if (inspections++ === 1) throw Error('TEMPORARY_NETWORK'); return evidence(clock); }}),
      dialog: dialogFor(events), openAccounting: async () => owner(events), now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    clock = 120000; await vi.advanceTimersByTimeAsync(120000);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    clock = 240000; await vi.advanceTimersByTimeAsync(120000);
    expect(runtime.workers.every(worker => !worker.status().disabled)).toBe(true);
    await runtime.close();
  });

  it('revokes idle retention when failed refreshes outlast account evidence without permanently disabling the worker',async()=>{
    vi.useFakeTimers();let clock=0,fail=false,disabledCalls=0;const events:string[]=[],states:unknown[]=[];
    const runtime=createDesktopObserverRuntime({now:()=>clock,dialog:dialogFor(events),openAccounting:async()=>owner(events),
      identity:identityFor(()=>clock,events,{inspect:()=>{if(fail)throw Error('NETWORK_UNAVAILABLE');return evidence(clock);}}),
      persistentReceiptDirectory:'test-receipts',persistentWorkerFactory:()=>({
        observe:async()=>({status:'disabled',interpretation:null,usage:null}),status:()=>({active:false,disabled:false,poisoned:false}),
        updateRetentionState:state=>states.push(state),disable:()=>{disabledCalls++;},close:async()=>{},release:async()=>{}})});
    try{
      await runtime.start(new AbortController().signal);runtime.workerSource.acquire('retained');fail=true;
      clock=120000;await vi.advanceTimersByTimeAsync(120000);expect(states).not.toContain(null);
      clock=240000;await vi.advanceTimersByTimeAsync(120000);expect(states).not.toContain(null);
      clock=360000;await vi.advanceTimersByTimeAsync(120000);expect(states).toContain(null);
      expect(disabledCalls).toBe(0);
    }finally{await runtime.close();}
  });
  it('revokes both slots when a refresh observes an identity change', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let changed = false;
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events, {inspect: () => evidence(clock, changed ? 'd'.repeat(64) : 'a'.repeat(64))}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    changed = true;
    clock = 120000;
    await vi.advanceTimersByTimeAsync(120000);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    await expect(runtime.workers[0]!.observe(input, new AbortController().signal, 'changed-account')).resolves.toMatchObject({status: 'disabled'});
    await runtime.close();
  });

  it('fails closed when a delayed renewal lets the original evidence expire', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const original = evidence(0);
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => clock, events, {inspect: () => original}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => clock,
    });
    await runtime.start(new AbortController().signal);
    clock = 360000;
    await vi.advanceTimersByTimeAsync(360000);
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    expect(events).not.toContain('prepare');
    await runtime.close();
  });

  it('cancels preparation and prevents admission when disabled during metadata work', async () => {
    const events: string[] = [];
    const preparation = deferred<void>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events, {prepare: () => preparation.promise}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    const pending = runtime.workers[0]!.observe(input, new AbortController().signal, 'during-preparation');
    await vi.waitFor(() => expect(events).toContain('prepare'));
    runtime.disable();
    preparation.resolve();
    await expect(pending).resolves.toMatchObject({status: 'disabled'});
    expect(events).not.toContain('reserve:during-preparation');
    await runtime.close();
  });

  it('closes workers and drained metadata before closing accounting', async () => {
    const events: string[] = [];
    const preparation = deferred<void>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events, {prepare: () => preparation.promise}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    const pending = runtime.workers[0]!.observe(input, new AbortController().signal, 'close-order');
    await vi.waitFor(() => expect(events).toContain('prepare'));
    const closing = runtime.close();
    preparation.resolve();
    await pending;
    await closing;
    expect(events.indexOf('view-close:close-order')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('accounting-close')).toBeGreaterThan(events.indexOf('view-close:close-order'));
  });

  it('closes a ledger that resolves after disable without exposing ready slots', async () => {
    const events: string[] = [];
    const accounting = deferred<ReleaseAccountingOwner>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: () => {events.push('open-accounting'); return accounting.promise;},
      now: () => 0,
    });
    const start = runtime.start(new AbortController().signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    await vi.waitFor(() => expect(events).toContain('open-accounting'));
    runtime.disable();
    await vi.waitFor(() => expect(events).toContain('identity-disable'));
    const lateOwner = owner(events);
    accounting.resolve(lateOwner);
    await start;
    expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true);
    expect(events).not.toContain('accounting-close');
    await runtime.close();
    expect(events.filter(event => event === 'accounting-close')).toHaveLength(1);
  });

  it('retains accounting when a delegate close is unconfirmed and preserves delegate ownership in status', async () => {
    vi.resetModules();
    vi.doMock('../../src/estimation/observer-worker.js', () => ({
      createAccountedObserverWorker: () => ({
        observe: async () => unavailableResult(),
        status: () => ({active: true, disabled: true, poisoned: true}),
        disable: () => undefined,
        close: async () => {throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');},
      }),
    }));
    try {
      const {createDesktopObserverRuntime: createMockedRuntime} = await import('../../src/desktop/observer-runtime.js');
      const events: string[] = [];
      const runtime = createMockedRuntime({
        identity: identityFor(() => 0, events),
        dialog: dialogFor(events),
        openAccounting: async () => owner(events),
        now: () => 0,
      });
      await runtime.start(new AbortController().signal);
      const delegate=runtime.workerSource.acquire('unconfirmed-delegate');
      expect(delegate.status()).toMatchObject({active: true, disabled: true, poisoned: true});
      runtime.disable();
      expect(runtime.workerSource.all()).toContain(delegate);
      expect(delegate.status()).toMatchObject({active: true, disabled: true, poisoned: true});
      await expect(runtime.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
      expect(events).not.toContain('accounting-close');
    } finally {
      vi.doUnmock('../../src/estimation/observer-worker.js');
      vi.resetModules();
    }
  });

  it('retains accounting when identity close is not confirmed', async () => {
    const events: string[] = [];
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events, {closeError: new Error('IDENTITY_CLOSE_FAILED')}),
      dialog: dialogFor(events),
      openAccounting: async () => owner(events),
      now: () => 0,
    });
    await runtime.start(new AbortController().signal);
    await expect(runtime.close()).rejects.toThrow('OBSERVER_CLOSE_UNCONFIRMED');
    expect(events).not.toContain('accounting-close');
  });

  it('does not turn a late accounting close failure into a successful shutdown', async () => {
    const events: string[] = [];
    const accounting = deferred<ReleaseAccountingOwner>();
    const runtime = createDesktopObserverRuntime({
      identity: identityFor(() => 0, events),
      dialog: dialogFor(events),
      openAccounting: () => accounting.promise,
      now: () => 0,
    });
    const start = runtime.start(new AbortController().signal);
    await vi.waitFor(() => expect(events).toContain('dialog'));
    await vi.waitFor(() => expect(runtime.workers.every(worker => worker.status().disabled)).toBe(true));
    runtime.disable();
    const lateOwner = owner(events);
    lateOwner.close = async () => {events.push('accounting-close-failed'); throw new Error('ACCOUNTING_CLOSE_FAILED');};
    accounting.resolve(lateOwner);
    await start;
    await expect(runtime.close()).rejects.toThrow('ACCOUNTING_CLOSE_FAILED');
    expect(events).toContain('identity-close');
    expect(events).toContain('accounting-close-failed');
    expect(events.indexOf('identity-close')).toBeLessThan(events.indexOf('accounting-close-failed'));
  });

  it('restores a remembered consent grant only after fresh identity validation on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hud-runtime-consent-'));
    try {
      const path = join(directory, 'consent.json');
      const firstStore = createObserverConsentStore(path, {protect: value => `sealed:${value}`, unprotect: value => value.slice('sealed:'.length)});
      const firstEvents: string[] = [];
      const first = createDesktopObserverRuntime({identity: identityFor(() => 0, firstEvents), dialog: dialogFor(firstEvents), openAccounting: async () => owner(firstEvents), consentStore: firstStore, now: () => 0});
      await first.start(new AbortController().signal);
      await first.close();

      const secondEvents: string[] = [];
      const secondStore = createObserverConsentStore(path, {protect: value => `sealed:${value}`, unprotect: value => value.slice('sealed:'.length)});
      const second = createDesktopObserverRuntime({identity: identityFor(() => 0, secondEvents), dialog: dialogFor(secondEvents, 1), openAccounting: async () => owner(secondEvents), consentStore: secondStore, now: () => 0});
      await second.start(new AbortController().signal);
      expect(secondEvents).not.toContain('dialog');
      expect(second.workers.every(worker => !worker.status().disabled)).toBe(true);
      await second.close();
    } finally { await rm(directory, {recursive: true, force: true}); }
  });

  it.each(['main','independent'] as const)('restores offline account-follow only for a main grant (%s)',async(mode)=>{
    const directory=await mkdtemp(join(tmpdir(),'hud-runtime-follow-'));
    try{
      const path=join(directory,'consent.json'),protection={protect:(v:string)=>v,unprotect:(v:string)=>v};
      const firstEvents:string[]=[],store=createObserverConsentStore(path,protection);
      const first=createDesktopObserverRuntime({identity:identityFor(()=>0,firstEvents),dialog:dialogFor(firstEvents),openAccounting:async()=>owner(firstEvents),consentStore:store,now:()=>0,subscriptionAccountSource:mode});
      await first.start(new AbortController().signal);await first.close();
      const events:string[]=[],changed=identityFor(()=>0,events,{inspect:()=>evidence(0,'d'.repeat(64))});
      const next=createDesktopObserverRuntime({identity:changed,dialog:dialogFor(events,1),openAccounting:async()=>owner(events),consentStore:createObserverConsentStore(path,protection),now:()=>0,subscriptionAccountSource:'main'});
      try{await next.start(new AbortController().signal);expect(events.includes('dialog')).toBe(mode!=='main');expect(next.workers.every(w=>!w.status().disabled)).toBe(mode==='main');}
      finally{await next.close();}
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('does not restore remembered consent when the verified account scope changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hud-runtime-consent-scope-'));
    try {
      const path = join(directory, 'consent.json');
      const store = createObserverConsentStore(path, {protect: value => `sealed:${value}`, unprotect: value => value.slice('sealed:'.length)});
      const firstEvents: string[] = [];
      const first = createDesktopObserverRuntime({identity: identityFor(() => 0, firstEvents), dialog: dialogFor(firstEvents), openAccounting: async () => owner(firstEvents), consentStore: store, now: () => 0});
      await first.start(new AbortController().signal); await first.close();
      const secondEvents: string[] = [];
      const changedIdentity = identityFor(() => 0, secondEvents, {inspect: () => evidence(0, 'd'.repeat(64))});
      const second = createDesktopObserverRuntime({identity: changedIdentity, dialog: dialogFor(secondEvents, 1), openAccounting: async () => owner(secondEvents), consentStore: createObserverConsentStore(path, {protect: value => `sealed:${value}`, unprotect: value => value.slice('sealed:'.length)}), now: () => 0});
      await second.start(new AbortController().signal);
      expect(secondEvents).toContain('dialog');
      expect(second.workers.every(worker => worker.status().disabled)).toBe(true);
      await second.close();
    } finally { await rm(directory, {recursive: true, force: true}); }
  });
});

function unavailableResult() {
  return {status: 'disabled' as const, interpretation: null, usage: null};
}
