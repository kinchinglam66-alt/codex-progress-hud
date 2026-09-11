import type {ObserverInput} from './observer-contract.js';
import type {ObserverWorker} from './observer-scheduler.js';
import type {Invocation} from './owned-process.js';
import {createOwnedProcessRunner} from './owned-process.js';
import {createObserverSubscriptionSession, type ObserverSubscriptionResult} from './subscription-session.js';
import type {ObserverResult} from './observer-provider.js';
import type {ReleaseAccountingOwner} from './release-accounting.js';
import type {ForecastVersions} from './forecast-record.js';
import type {ReleaseRecoveryEvent} from './release-accounting.js';
import type {AdmissionKind} from './subscription-accounting.js';
import {normalizeAdmissionReason} from '../core/observer-diagnostics.js';
import {randomUUID} from 'node:crypto';

export type {ObserverWorker} from './observer-scheduler.js';

export interface AccountedObserverWorkerOptions {
  accounting: ReleaseAccountingOwner;
  prepare: (input: ObserverInput, signal: AbortSignal) => Invocation | {invocation:Invocation;provenance?:ForecastVersions} |
    Promise<Invocation | {invocation:Invocation;provenance?:ForecastVersions}>;
  authorize: () => boolean;
  now?: () => number;
}

const failure = (status: ObserverSubscriptionResult['status'] = 'process_error', usage: ObserverSubscriptionResult['usage'] = null): ObserverSubscriptionResult => ({
  status,
  interpretation: null,
  usage,
});

function neutralResult(value: ObserverSubscriptionResult): ObserverResult {
  return {
    ...value,
    usage: value.usage === null ? null : {
      kind: value.usage.kind,
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
      cachedInputTokens: value.usage.cachedInputTokens ?? 0,
    },
  };
}

function authorized(authorize: () => boolean): boolean {
  try { return authorize() === true; }
  catch { return false; }
}

/**
 * Owns one reusable observer slot. The accounting owner is shared by the
 * scheduler and deliberately remains outside this worker's lifecycle.
 * Preparation and authorization are trusted host seams; neither receives the
 * internal conversation key.
 */
export function createAccountedObserverWorker({accounting, prepare, authorize, now = Date.now}: AccountedObserverWorkerOptions): ObserverWorker {
  let active = false;
  let disabled = false;
  let poisoned = false;
  let pending: Promise<ObserverSubscriptionResult> | undefined;
  let session: ReturnType<typeof createObserverSubscriptionSession> | undefined;
  let runner: ReturnType<typeof createOwnedProcessRunner> | undefined;
  let unconfirmedRunner: ReturnType<typeof createOwnedProcessRunner> | undefined;
  let closing: Promise<void> | undefined;
  let preparedProvenance: ForecastVersions|null = null;
  const ownerUuid = randomUUID();

  const disable = (): void => {
    disabled = true;
    try { session?.disable(); } catch { poisoned = true; }
    try { runner?.disable(); } catch { poisoned = true; }
    try { unconfirmedRunner?.disable(); } catch { poisoned = true; }
  };

  const status = () => {
    const retained = runner ?? unconfirmedRunner;
    let childStatus: {active: boolean; disabled: boolean; poisoned: boolean} | undefined;
    try { childStatus = retained?.status(); } catch { childStatus = {active: true, disabled: true, poisoned: true}; }
    return {
      active: active || childStatus?.active === true,
      disabled,
      poisoned: poisoned || childStatus?.poisoned === true,
    };
  };

  async function invoke(input: ObserverInput, signal: AbortSignal, conversationKey: string, turnGeneration: number): Promise<ObserverSubscriptionResult> {
    let view: ReturnType<ReleaseAccountingOwner['forConversation']> | undefined;
    let localRunner: ReturnType<typeof createOwnedProcessRunner> | undefined;
    let localSession: ReturnType<typeof createObserverSubscriptionSession> | undefined;
    let admittedKind: AdmissionKind | undefined;
    let recoveryEventRecorded = false;
    const recordRecoveryEvent = async (event: ReleaseRecoveryEvent): Promise<void> => {
      if (recoveryEventRecorded || !accounting.recordRecoveryEvent) return;
      recoveryEventRecorded = true;
      await accounting.recordRecoveryEvent(event).catch(() => undefined);
    };
    try {
      view = accounting.forConversation(conversationKey);
      localRunner = createOwnedProcessRunner();
      const prepareInvocation = async (value:ObserverInput, prepareSignal:AbortSignal):Promise<Invocation> => {
        const prepared = await prepare(value, prepareSignal);
        if (typeof prepared === 'object' && prepared !== null && 'invocation' in prepared) {
          preparedProvenance = prepared.provenance ?? null;
          return prepared.invocation;
        }
        return prepared;
      };
      const admission = accounting.recoveryAdmission
        ? await accounting.recoveryAdmission(now(), true, conversationKey)
        : {allowed: true, kind: 'ordinary' as const};
      if (!admission.allowed) return {...failure('admission_denied'),admissionReason:normalizeAdmissionReason('reason' in admission ? admission.reason : undefined)};
      admittedKind = admission.kind;
      localSession = createObserverSubscriptionSession({ledger: view, runner: localRunner, prepare:prepareInvocation, authorize, admissionKind: admittedKind,
        invocationRecord: admissionId => ({admissionId, conversationKey, turnGeneration, ownerUuid, providerKind: 'subscription', phase: 'bound', deadline: now() + 60_000, cleanupOutcome: 'pending'})});
      runner = localRunner;
      session = localSession;
      let result: ObserverSubscriptionResult;
      try { result = await localSession.observe(input, signal); }
      catch { result = failure(); }
      const deliveryStarted=performance.now();
      const delivered=(value:ObserverSubscriptionResult):ObserverSubscriptionResult=>{
        if(!result.timings)return value;
        const deliveryMs=Math.round(performance.now()-deliveryStarted);
        return {...value,timings:{...result.timings,deliveryMs,totalMs:result.timings.totalMs+deliveryMs}};
      };
      const event: ReleaseRecoveryEvent | undefined = result.outcomes?.retryable === 'pre_dispatch_transient'
        ? {kind: admittedKind === 'half_open' ? 'half_open_failure' : 'recoverable_failure', at: now()}
        : undefined;
      // A retryable half-open transient owns the claim until this serialized
      // event atomically clears it and installs cooldown. Generic release is
      // only for proven no-dispatch exits.
      if (event) await recordRecoveryEvent({...event, conversationKey});
      let closeFailed = false;
      try { await localSession.close(); }
      catch { closeFailed = true; }
      let childStatus: {active: boolean; disabled: boolean; poisoned: boolean};
      try { childStatus = localRunner.status(); }
      catch { childStatus = {active: true, disabled: true, poisoned: true}; }
      if (closeFailed || childStatus.poisoned) {
        poisoned = true;
        disabled = true;
      }
      if (childStatus.active || childStatus.poisoned) {
        // Keep the object strongly reachable until the direct child confirms
        // close; the scheduler must not recycle this slot meanwhile.
        unconfirmedRunner = localRunner;
      }
      if (closeFailed) return delivered(failure());
      if (!event && admittedKind === 'half_open' && !childStatus.active && !childStatus.poisoned) {
        try {
          if (accounting.releaseRecoveryAdmission) await accounting.releaseRecoveryAdmission(conversationKey);
          else await view.releaseRecoveryAdmission?.();
        } catch { poisoned = true; disabled = true; return delivered(failure()); }
      }
      const revoked = disabled || signal.aborted || !authorized(authorize);
      if (revoked && result.status === 'interpreted') {
        return delivered(failure(signal.aborted ? 'aborted' : 'disabled', result.usage));
      }
      return delivered(result);
    } catch {
      if (admittedKind !== undefined) await recordRecoveryEvent({kind: admittedKind === 'half_open' ? 'half_open_failure' : 'recoverable_failure', at: now(), conversationKey});
      disabled = true;
      try { await localSession?.close(); }
      catch { poisoned = true; }
      if (!localSession) {
        try { await view?.close(); }
        catch { poisoned = true; }
      }
      return failure();
    } finally {
      if (session === localSession) session = undefined;
      if (runner === localRunner) runner = undefined;
      active = false;
    }
  }

  return {
    observe(input, signal, conversationKey, turnGeneration=0): Promise<ObserverResult> {
      if (disabled || poisoned || closing) return Promise.resolve(neutralResult(failure('disabled')));
      if (active) return Promise.resolve(neutralResult(failure('busy')));
      if (!authorized(authorize)) return Promise.resolve(neutralResult(failure('disabled')));
      active = true;
      preparedProvenance = null;
      const operation = invoke(input, signal, conversationKey, turnGeneration);
      pending = operation;
      operation.finally(() => {
        if (pending === operation) pending = undefined;
      }).catch(() => undefined);
      return operation.then(neutralResult);
    },
    status,
    provenance: () => preparedProvenance,
    recoveryStatus: () => accounting.recoveryStatus?.(),
    disable,
    close(): Promise<void> {
      if (closing) return closing;
      disable();
      const inFlight = pending;
      closing = (async () => {
        try { await inFlight; }
        catch { throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED'); }
        const state = status();
        if (state.active || state.poisoned) throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');
      })();
      return closing;
    },
  };
}
