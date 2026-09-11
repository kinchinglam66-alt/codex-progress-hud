import {afterEach, expect, it, vi} from 'vitest';
import type {ReleaseAccountingRecoveryOwner} from '../../src/estimation/release-accounting.js';
import {createObserverRecoveryController, type RecoveryRuntimeBoundary} from '../../src/desktop/observer-recovery.js';
import {ObserverScheduler, type ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverResult} from '../../src/estimation/observer-provider.js';

const usage = {inputTokens: 6, outputTokens: 2, cachedInputTokens: 1};

function accounting(): ReleaseAccountingRecoveryOwner {
  let state: 'blocked' | 'awaiting_confirmation' | 'probing' | 'recovered' | 'failed' = 'blocked';
  const confirmation = {attemptId: 'd6d3a4d7-43f9-4b8d-8ff2-0cb8e5d7c5c9', revision: 1, binding: 'account:route:assets'};
  return {
    forConversation: vi.fn(),
    snapshot: vi.fn(() => ({starts: 1, activeStarts: 0, inFlight: 0, unresolved: 0, knownTokens: 0, unknown: 1, poisoned: false})),
    recoveryStatus: vi.fn(() => ({state, revision: 1, knownTokens: 0, unknown: 1, recoveryAllowed: state === 'blocked' || state === 'failed'})),
    preflightRecovery: vi.fn(async () => ({state: 'blocked' as const, revision: 1, knownTokens: 0, unknown: 1, recoveryAllowed: true, allowed: true})),
    confirmRecovery: vi.fn(async () => { state = 'awaiting_confirmation'; return confirmation; }),
    reserveRecoveryTrial: vi.fn(async () => { state = 'probing'; return '11111111-1111-4111-8111-111111111111'; }),
    settleRecoveryTrial: vi.fn(async () => undefined),
    finishRecovery: vi.fn(async (_attemptId, result) => { state = result.success ? 'recovered' : 'failed'; }),
    cancelRecoveryTrial: vi.fn(async () => { state = 'failed'; }),
    cancelRecovery: vi.fn(async () => { state = 'failed'; }),
    recoveryAdmission: vi.fn(async () => ({allowed: true, kind: 'ordinary' as const, nextEligibleAt: null})),
    reconcileRecoveredPending: vi.fn(async () => 0),
    releaseRecoveryAdmission: vi.fn(async () => undefined),
    recordRecoveryEvent: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

afterEach(() => vi.restoreAllMocks());

it('projects detailed diagnostics with a category allowlist and detached status arrays',async()=>{
  const controller=createObserverRecoveryController({accounting:accounting(),runtime:{
    enabled:()=>true,check:async()=>({binding:'account:route:assets',closureConfirmed:true}),
    runTrial:async()=>({usage:null,success:false,closureConfirmed:true,diagnostic:{reason:'exited' as const,exitCode:7,closed:true,
      parserError:'protocol' as const,elapsedMs:123,errorCategories:['http_403','SECRET','http_403']}}),rebuild:async()=>undefined,
  }});
  await controller.preflight();await expect(controller.confirm(1)).rejects.toThrow();
  expect(controller.status()).toMatchObject({lastDiagnostic:{processReason:'exited',exitCode:7,parserError:'protocol',elapsedMs:123,errorCategories:['http_403']}});
  expect(JSON.stringify(controller.status())).not.toContain('SECRET');
  const snapshot=controller.status() as any;snapshot.lastDiagnostic.errorCategories.push('mutated');
  expect(JSON.stringify(controller.status())).not.toContain('mutated');
});

it.each([
  [{preparationFailed:true},'preparation_failed'],
  [{processReason:'timeout'},'timeout'],
  [{processReason:'exited',call:'success',framingValid:false},'invalid_output'],
  [{processReason:'exited',call:'success',framingValid:true,prediction:'numeric',usage:'unknown'},'missing_usage'],
] as const)('exposes a safe call reason from a failed recovery',async(outcomes,reason)=>{
  const controller=createObserverRecoveryController({accounting:accounting(),runtime:{
    enabled:()=>true,check:async()=>({binding:'account:route:assets',closureConfirmed:true}),
    runTrial:async()=>({usage:null,success:false,closureConfirmed:true,callResult:{status:'process_error',interpretation:null,usage:null,
      outcomes:{prediction:'invalid',call:'failed',usage:'unknown',framingValid:false,closureConfirmed:true,dispatch:'unknown',...outcomes}}}),
    rebuild:async()=>undefined,
  }});
  await controller.preflight();await expect(controller.confirm(1)).rejects.toThrow();
  expect(controller.status()).toMatchObject({lastDiagnostic:{callReason:reason}});
});

it('retains a failed trial diagnosis without exporting raw error details', async () => {
  const controller = createObserverRecoveryController({accounting: accounting(), runtime: {
    enabled: () => true,
    check: async () => ({binding: 'account:route:assets', closureConfirmed: true}),
    runTrial: async () => { throw new Error('SECRET raw provider response'); },
    rebuild: async () => undefined,
  }});
  await controller.preflight();
  await expect(controller.confirm(1)).rejects.toThrow('OBSERVER_RECOVERY_FAILED');
  expect(controller.status()).toMatchObject({lastDiagnostic: {
    stage: 'trial', outcome: 'failed', usagePresent: false, closureConfirmed: false,
  }});
  expect(JSON.stringify(controller.status())).not.toContain('SECRET');
});

it('distinguishes rebuild failure from model trial failure', async () => {
  const controller = createObserverRecoveryController({accounting: accounting(), runtime: {
    enabled: () => true,
    check: async () => ({binding: 'account:route:assets', closureConfirmed: true}),
    runTrial: async () => ({usage, success: true, closureConfirmed: true}),
    rebuild: async () => { throw Error('private path'); },
  }});
  await controller.preflight();
  await expect(controller.confirm(1)).rejects.toThrow('OBSERVER_RECOVERY_FAILED');
  expect(controller.status()).toMatchObject({lastDiagnostic: {
    stage: 'rebuild', outcome: 'failed', usagePresent: true, closureConfirmed: true,
  }});
});

it('preflight never calls the model and concurrent confirmation consumes one trial', async () => {
  const model = {calls: 0};
  const boundary: RecoveryRuntimeBoundary = {
    enabled: () => true,
    check: vi.fn(async () => ({binding: 'account:route:assets', closureConfirmed: true})),
    runTrial: vi.fn(async () => { model.calls++; return {usage, success: true, closureConfirmed: true}; }),
    rebuild: vi.fn(async () => undefined),
  };
  const owner = accounting();
  const controller = createObserverRecoveryController({accounting: owner, runtime: boundary});

  const preflight = await controller.preflight();
  expect(preflight).toMatchObject({state: 'blocked', allowed: true});
  expect(model.calls).toBe(0);

  await Promise.all([controller.confirm(1), controller.confirm(1)]);
  expect(model.calls).toBe(1);
  expect(owner.reserveRecoveryTrial).toHaveBeenCalledOnce();
  expect(controller.status()).toMatchObject({state: 'recovered'});
});

it('returns a blocked reboot-guidance preflight when trusted closure evidence is unavailable', async () => {
  const boundary: RecoveryRuntimeBoundary = {
    enabled: () => true,
    check: async () => ({binding: 'account:route:assets', closureConfirmed: false, reason: 'unresolved_previous_call' as const}),
    runTrial: vi.fn(async () => ({usage, success: true, closureConfirmed: true})),
    rebuild: vi.fn(async () => undefined),
  };
  const controller = createObserverRecoveryController({accounting: accounting(), runtime: boundary});

  await expect(controller.preflight()).resolves.toMatchObject({
    state: 'blocked', allowed: false, reason: 'unresolved_previous_call',
  });
  expect(boundary.runTrial).not.toHaveBeenCalled();
});

it('cancellation or disabled plugin cannot enter the model boundary', async () => {
  let enabled = true;
  const boundary: RecoveryRuntimeBoundary = {
    enabled: () => enabled,
    check: vi.fn(async () => ({binding: 'account:route:assets', closureConfirmed: true})),
    runTrial: vi.fn(async () => ({usage, success: true, closureConfirmed: true})),
    rebuild: vi.fn(async () => undefined),
  };
  const owner = accounting();
  const controller = createObserverRecoveryController({accounting: owner, runtime: boundary});
  await controller.preflight();
  enabled = false;
  await expect(controller.confirm(1)).rejects.toThrow('OBSERVER_RECOVERY_DISABLED');
  expect(boundary.runTrial).not.toHaveBeenCalled();
});

it('drives a disabled scheduler through successful recovery before ordinary observation resumes', async () => {
  let now = 0;
  let active = false;
  let disabled = false;
  const calls: Array<(result: ObserverResult) => void> = [];
  const failure: ObserverResult = {status: 'accounting_error', interpretation: null, usage: null};
  const success: ObserverResult = {
    status: 'interpreted',
    interpretation: {relation: 'continue', status: 'running', summary: 'ordinary observation', estimate: {remainingSeconds: 120, errorPercent: 20}},
    usage: {kind: 'subscription-tokens', inputTokens: 4, outputTokens: 1, cachedInputTokens: 0},
  };
  const worker: ObserverWorker & {rearm(): void} = {
    observe: () => { active = true; return new Promise(resolve => calls.push(result => {active = false; resolve(result);})); },
    status: () => ({active, disabled, poisoned: false}),
    disable: () => {disabled = true;},
    close: async () => {disabled = true;},
    rearm: () => {disabled = false;},
  };
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts);
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker], now: () => now});
  const key = normalizeHookInput('UserPromptSubmit', {session_id: 'controller-scheduler-recovery', turn_id: 'one', tool_use_id: 'tool-one'}, now, 'protected-controller-scheduler-recovery-token-123456789').envelope.sessionKey;
  const first = normalizeHookInput('UserPromptSubmit', {session_id: 'controller-scheduler-recovery', turn_id: 'one', tool_use_id: 'tool-one'}, now, 'protected-controller-scheduler-recovery-token-123456789').envelope;
  first.content = {kind: 'user', text: 'first task', truncated: false};
  goals.observe(first, true, now); contexts.ingest(first, now); scheduler.changed(key, 'prompt');
  now = 15_000; scheduler.tick();
  expect(calls).toHaveLength(1);
  calls[0]!(failure);
  await Promise.resolve(); await Promise.resolve();
  expect(scheduler.stats().disabled).toBe(true);

  const owner = accounting();
  let recoveryGeneration: number | undefined;
  const boundary: RecoveryRuntimeBoundary = {
    enabled: () => true,
    check: async () => ({
      binding: 'account:route:assets',
      closureConfirmed: (recoveryGeneration = await scheduler.prepareRecovery()) >= 1,
    }),
    runTrial: async () => ({usage: {inputTokens: 6, outputTokens: 2, cachedInputTokens: 1}, success: true, closureConfirmed: true}),
    rebuild: async () => {worker.rearm();},
    enable: async () => scheduler.restoreRecovery(recoveryGeneration!),
  };
  const controller = createObserverRecoveryController({accounting: owner, runtime: boundary});
  await expect(controller.preflight()).resolves.toMatchObject({allowed: true});
  const confirmed = await controller.confirm(1);
  expect(confirmed).toMatchObject({state: 'recovered'});
  expect(controller.status()).toMatchObject({state: 'recovered'});
  expect(scheduler.stats().disabled).toBe(false);

  now = 100_000;
  const second = normalizeHookInput('UserPromptSubmit', {session_id: 'controller-scheduler-recovery', turn_id: 'two', tool_use_id: 'tool-two'}, now, 'protected-controller-scheduler-recovery-token-123456789').envelope;
  second.content = {kind: 'user', text: 'ordinary task after recovery', truncated: false};
  goals.observe(second, true, now); contexts.ingest(second, now); scheduler.changed(key, 'prompt');
  scheduler.tick();
  now = 111_000; scheduler.tick();
  expect(calls).toHaveLength(2);
  calls[1]!(success);
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toHaveLength(2);
  await scheduler.close();
});
