import type {ObserverInput} from './observer-contract.js';
import type {ObserverWorker} from './observer-scheduler.js';
import type {Invocation} from './owned-process.js';
import {createOwnedProcessRunner} from './owned-process.js';
import {createObserverSubscriptionSession, type ObserverSubscriptionResult} from './subscription-session.js';
import type {ReleaseAccountingOwner} from './release-accounting.js';

export type {ObserverWorker} from './observer-scheduler.js';

export interface AccountedObserverWorkerOptions {
  accounting: ReleaseAccountingOwner;
  prepare: (input: ObserverInput, signal: AbortSignal) => Invocation | Promise<Invocation>;
  authorize: () => boolean;
}

const failure = (status: ObserverSubscriptionResult['status'] = 'process_error', usage: ObserverSubscriptionResult['usage'] = null): ObserverSubscriptionResult => ({
  status,
  interpretation: null,
  usage,
});

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
export function createAccountedObserverWorker({accounting, prepare, authorize}: AccountedObserverWorkerOptions): ObserverWorker {
  let active = false;
  let disabled = false;
  let poisoned = false;
  let pending: Promise<ObserverSubscriptionResult> | undefined;
  let session: ReturnType<typeof createObserverSubscriptionSession> | undefined;
  let runner: ReturnType<typeof createOwnedProcessRunner> | undefined;
  let unconfirmedRunner: ReturnType<typeof createOwnedProcessRunner> | undefined;
  let closing: Promise<void> | undefined;

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

  async function invoke(input: ObserverInput, signal: AbortSignal, conversationKey: string): Promise<ObserverSubscriptionResult> {
    let view: ReturnType<ReleaseAccountingOwner['forConversation']> | undefined;
    let localRunner: ReturnType<typeof createOwnedProcessRunner> | undefined;
    let localSession: ReturnType<typeof createObserverSubscriptionSession> | undefined;
    try {
      view = accounting.forConversation(conversationKey);
      localRunner = createOwnedProcessRunner();
      localSession = createObserverSubscriptionSession({ledger: view, runner: localRunner, prepare, authorize});
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
      const revoked = disabled || signal.aborted || !authorized(authorize);
      if (revoked && result.status === 'interpreted') {
        return delivered(failure(signal.aborted ? 'aborted' : 'disabled', result.usage));
      }
      return delivered(result);
    } catch {
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
    observe(input, signal, conversationKey): Promise<ObserverSubscriptionResult> {
      if (disabled || poisoned || closing) return Promise.resolve(failure('disabled'));
      if (active) return Promise.resolve(failure('busy'));
      if (!authorized(authorize)) return Promise.resolve(failure('disabled'));
      active = true;
      const operation = invoke(input, signal, conversationKey);
      pending = operation;
      operation.finally(() => {
        if (pending === operation) pending = undefined;
      }).catch(() => undefined);
      return operation;
    },
    status,
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
