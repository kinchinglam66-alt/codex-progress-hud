import {createObserverConsentGate, observerConsentScope, type ObserverAttestation} from '../estimation/observer-consent.js';
import type {ObserverConsentStore} from '../estimation/observer-consent-store.js';
import {createAccountedObserverWorker, type ObserverWorker} from '../estimation/observer-worker.js';
import type {ObserverInput} from '../estimation/observer-contract.js';
import type {Invocation} from '../estimation/owned-process.js';
import type {ReleaseAccountingOwner} from '../estimation/release-accounting.js';
import type {ForecastVersions} from '../estimation/forecast-record.js';
import {requestObserverConsent, type ObserverConsentDialog} from './observer-consent-dialog.js';
import {createObserverRecoveryController, type ObserverRecoveryController, type RecoveryRuntimeBoundary} from './observer-recovery.js';
import {createObserverDiagnosticRunner, type ObserverDiagnostic} from '../estimation/observer-diagnostics.js';
import {createObserverSubscriptionSession} from '../estimation/subscription-session.js';
import type {AccountedUsage} from '../estimation/subscription-accounting.js';
import type {ObserverScheduler} from '../estimation/observer-scheduler.js';

const SLOT_COUNT = 2;
const REFRESH_MS = 120000;
const RECOVERY_INPUT: ObserverInput = Object.freeze({
  goalSummary: 'Synthetic recovery probe. Do not use any real conversation context.',
  activeSeconds: 0,
  runtime: 'waiting',
  messages: [{kind: 'user' as const, text: 'Return one valid observer response for this synthetic recovery probe.', truncated: false}],
  truncated: false,
});

export interface DesktopObserverIdentity {
  inspect(signal: AbortSignal): Promise<{accountLabel: string; evidence: ObserverAttestation}>;
  prepareEstimate(input: ObserverInput, signal: AbortSignal): Promise<{
    accountLabel: string;
    evidence: ObserverAttestation;
    invocation: Invocation;
    provenance?: ForecastVersions;
  }>;
  disable(): void;
  close(): Promise<void>;
}

export interface DesktopObserverRuntimeOptions {
  identity: DesktopObserverIdentity;
  openAccounting: () => Promise<ReleaseAccountingOwner>;
  dialog: ObserverConsentDialog;
  now?: () => number;
  consentStore?: ObserverConsentStore;
}

type SchedulerRecoveryHandle = Pick<ObserverScheduler, 'prepareRecovery' | 'restoreRecovery'>;

type ObserverResult = Awaited<ReturnType<ObserverWorker['observe']>>;

const unavailable = (): ObserverResult => ({status: 'disabled', interpretation: null, usage: null});

function binding(evidence: ObserverAttestation): string { return JSON.stringify(observerConsentScope(evidence)); }

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(new Error('OBSERVER_SETUP_CANCELLED'));
    };
    signal.addEventListener('abort', abort, {once: true});
    operation.then(value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

function serial<T>(tail: Promise<void>, operation: () => Promise<T>): {result: Promise<T>; next: Promise<void>} {
  const result = tail.then(operation);
  return {result, next: result.then(() => undefined, () => undefined)};
}

/**
 * Desktop-private owner for the consent-bound observer. It deliberately
 * exposes two stable, initially unavailable slots so the scheduler can be
 * wired before first-use setup without creating an admission path early.
 */
export function createDesktopObserverRuntime({identity, openAccounting, dialog, now = Date.now, consentStore}: DesktopObserverRuntimeOptions) {
  let disabled = false;
  let ready = false;
  let setupFailed = false;
  let setup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let setupController: AbortController | undefined;
  let externalSignal: AbortSignal | undefined;
  let externalAbort: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshController: AbortController | undefined;
  let metadataTail: Promise<void> = Promise.resolve();
  let accounting: ReleaseAccountingOwner | undefined;
  let accountingOpen: Promise<ReleaseAccountingOwner> | undefined;
  let lateAccountingOwner: ReleaseAccountingOwner | undefined;
  let ledgerOpening = false;
  let openingCancelled = false;
  let authorizedBinding: string | undefined;
  let recoveryController: ObserverRecoveryController | undefined;
  let schedulerRecovery: SchedulerRecoveryHandle | undefined;
  let preparedSchedulerGeneration: number | undefined;
  let recoveryDelegatesClosed = false;
  const delegates: Array<ObserverWorker | undefined> = [];

  function disableDelegates(): void {
    for (const delegate of delegates) {
      try {delegate?.disable();} catch { /* Keep ownership until close confirms it. */ }
    }
  }

  function disable(): void {
    if (ledgerOpening) openingCancelled = true;
    disabled = true;
    ready = false;
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    setupController?.abort();
    refreshController?.abort();
    try {identity.disable();} catch { /* Identity close reports uncertain ownership. */ }
    disableDelegates();
    gate.revoke();
    recoveryController?.disable();
  }

  const gate = createObserverConsentGate({now, onInvalidate: () => { ready = false; }});

  function slot(index: number): ObserverWorker {
    return {
      observe(input, signal, conversationKey): Promise<ObserverResult> {
        const delegate = delegates[index];
        if (disabled || !ready || !delegate) return Promise.resolve(unavailable());
        try {return delegate.observe(input, signal, conversationKey);}
        catch {return Promise.resolve(unavailable());}
      },
      status() {
        const delegate = delegates[index];
        if (!delegate) return {active: false, disabled: true, poisoned: false, setupFailed};
        try {
          const state = delegate.status();
          return disabled || !ready ? {...state, disabled: true} : state;
        }
        catch {return {active: true, disabled: true, poisoned: true};}
      },
      disable() {
        try {delegates[index]?.disable();} catch { /* Close retains the failed owner. */ }
      },
      close() {
        try {return delegates[index]?.close() ?? Promise.resolve();}
        catch {return Promise.reject(new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED'));}
      },
      provenance() {
        const delegate=delegates[index];
        if (disabled || !ready || !delegate) return null;
        try {return delegate.provenance?.() ?? null;}
        catch {return null;}
      },
    };
  }

  const workers = Object.freeze(Array.from({length: SLOT_COUNT}, (_, index) => slot(index))) as readonly ObserverWorker[];

  function check(signal: AbortSignal): void {
    if (disabled || signal.aborted || !gate.authorized()) throw new Error('OBSERVER_NOT_READY');
  }

  function prepare(input: ObserverInput, signal: AbortSignal): ReturnType<DesktopObserverIdentity['prepareEstimate']> {
    const queued = serial(metadataTail, async () => {
      check(signal);
      const prepared = await identity.prepareEstimate(input, signal);
      check(signal);
      gate.update(prepared.evidence);
      if (!gate.authorized() || authorizedBinding === undefined || binding(prepared.evidence) !== authorizedBinding) {
        disable();
        throw new Error('OBSERVER_IDENTITY_CHANGED');
      }
      return prepared;
    });
    metadataTail = queued.next;
    return queued.result;
  }

  function installDelegates(owner: ReleaseAccountingOwner): void {
    for (let index = 0; index < SLOT_COUNT; index++) {
      delegates[index] = createAccountedObserverWorker({
        accounting: owner,
        prepare,
        authorize: () => !disabled && ready && gate.authorized(),
        now,
      });
    }
  }

  async function rebuildDelegates(): Promise<void> {
    if (disabled || !ready || !accounting) throw new Error('OBSERVER_RECOVERY_DISABLED');
    const old = delegates.map(delegate => delegate);
    for (const delegate of old) {
      try { delegate?.disable(); } catch { /* close below verifies ownership */ }
    }
    const closed = await Promise.allSettled(old.map(delegate => delegate?.close() ?? Promise.resolve()));
    if (closed.some(result => result.status === 'rejected') || old.some(delegate => {
      if (!delegate) return false;
      try { const state = delegate.status(); return state.active || state.poisoned; }
      catch { return true; }
    })) throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');
    installDelegates(accounting);
    recoveryDelegatesClosed = false;
  }

  async function closeDelegatesForRecovery(): Promise<void> {
    const old = delegates.map(delegate => delegate);
    for (const delegate of old) {
      try { delegate?.disable(); } catch { /* close below verifies ownership */ }
    }
    const closed = await Promise.allSettled(old.map(delegate => delegate?.close() ?? Promise.resolve()));
    if (closed.some(result => result.status === 'rejected') || old.some(delegate => {
      if (!delegate) return false;
      try { const state = delegate.status(); return state.active || state.poisoned; }
      catch { return true; }
    })) throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');
    recoveryDelegatesClosed = true;
  }

  async function enableScheduler(): Promise<void> {
    if (preparedSchedulerGeneration === undefined || schedulerRecovery === undefined) return;
    const generation = preparedSchedulerGeneration;
    await schedulerRecovery.restoreRecovery(generation);
    preparedSchedulerGeneration = undefined;
  }

  async function releaseRecoveryGate(): Promise<void> {
    if (!recoveryDelegatesClosed && preparedSchedulerGeneration === undefined) return;
    if (recoveryDelegatesClosed) await rebuildDelegates();
    await enableScheduler();
  }

  function recoveryBoundary(): RecoveryRuntimeBoundary {
    return {
      enabled: () => !disabled && ready && gate.authorized(),
      async check(signal: AbortSignal): Promise<{binding: string; closureConfirmed: boolean}> {
      check(signal);
        if (schedulerRecovery !== undefined && preparedSchedulerGeneration === undefined) {
          preparedSchedulerGeneration = await schedulerRecovery.prepareRecovery();
        }
        if (!recoveryDelegatesClosed) await closeDelegatesForRecovery();
        const snapshot = await identity.inspect(signal);
        check(signal);
        gate.update(snapshot.evidence);
        const current = binding(snapshot.evidence);
        if (!gate.authorized() || authorizedBinding === undefined || current !== authorizedBinding) {
          disable();
          throw new Error('OBSERVER_RECOVERY_BINDING_CHANGED');
        }
        const states = delegates.map(delegate => {
          try { return delegate?.status() ?? {active: false, poisoned: false}; }
          catch { return {active: true, poisoned: true}; }
        });
        return {binding: current, closureConfirmed: states.every(state => !state.active && !state.poisoned)};
      },
      async runTrial(reservationId: string, signal: AbortSignal) {
        if (!accounting || disabled || !ready || !gate.authorized()) throw new Error('OBSERVER_RECOVERY_DISABLED');
        let diagnostic: ObserverDiagnostic | undefined;
        const runner = createObserverDiagnosticRunner(value => { diagnostic = value; });
        let usage: AccountedUsage | null = null;
        const trialLedger = {
          reserve: async () => reservationId,
          settle: async (_id: string, value: AccountedUsage | null) => { usage = value === null ? null : {...value}; },
          cancelBeforeDispatch: async () => undefined,
          close: async () => undefined,
        };
        const session = createObserverSubscriptionSession({
          ledger: trialLedger,
          runner,
          prepare: async (input: ObserverInput, prepareSignal: AbortSignal) => (await prepare(input, prepareSignal)).invocation,
          authorize: () => !disabled && ready && gate.authorized(),
        });
        let result: ObserverResult;
        try { result = await session.observe(RECOVERY_INPUT, signal); }
        catch { result = unavailable(); }
        let closureConfirmed = false;
        try { await session.close(); closureConfirmed = !runner.status().active && !runner.status().poisoned; }
        catch { closureConfirmed = false; }
        const success = result.status === 'interpreted' && result.interpretation !== null &&
          result.outcomes?.call === 'success' && result.outcomes.framingValid === true && closureConfirmed;
        return {usage, success, closureConfirmed, callResult: result, ...(diagnostic ? {diagnostic} : {})};
      },
      rebuild: rebuildDelegates,
      release: releaseRecoveryGate,
      enable: enableScheduler,
    };
  }

  function refresh(): void {
    const queued = serial(metadataTail, async () => {
      if (disabled) return;
      const controller = new AbortController();
      refreshController = controller;
      try {
        const snapshot = await identity.inspect(controller.signal);
        if (disabled) return;
        gate.update(snapshot.evidence);
        if (authorizedBinding === undefined || binding(snapshot.evidence) !== authorizedBinding) { disable(); return; }
        if (!gate.authorized()) {
          const stored = await readConsent();
          if (stored === null || !gate.restore(stored)) { disable(); return; }
        }
        if (!disabled && gate.authorized()) ready = true;
      } catch {
        ready = false;
      } finally {
        if (refreshController === controller) refreshController = undefined;
      }
    });
    metadataTail = queued.next;
    void queued.result.catch(() => undefined);
  }

  function beginRefresh(): void {
    refreshTimer = setInterval(refresh, REFRESH_MS);
    const timer = refreshTimer as ReturnType<typeof setInterval> & {unref?: () => void};
    timer.unref?.();
  }

  async function start(signal: AbortSignal): Promise<void> {
    if (disabled || closing || setup) return setup ?? Promise.resolve();
    externalSignal = signal;
    externalAbort = () => disable();
    signal.addEventListener('abort', externalAbort, {once: true});
    setupController = new AbortController();
    const combined = AbortSignal.any([signal, setupController.signal]);
    const operation = (async () => {
      try {
        gate.revoke();
        if (combined.aborted) throw new Error('OBSERVER_SETUP_CANCELLED');
        const snapshot = await identity.inspect(combined);
        if (combined.aborted) throw new Error('OBSERVER_SETUP_CANCELLED');
        gate.update(snapshot.evidence);
        authorizedBinding = binding(snapshot.evidence);
        const stored = await readConsent();
        const restored = stored !== null && gate.restore(stored);
        const consent = restored ? true : await waitForSignal(requestObserverConsent(gate, dialog, snapshot.accountLabel), combined);
        if (!consent || !gate.authorized()) throw new Error('OBSERVER_CONSENT_REQUIRED');
        if (!restored) await consentStore?.grant(observerConsentScope(snapshot.evidence), now());

        ledgerOpening = true;
        openingCancelled = false;
        const opened = Promise.resolve().then(openAccounting);
        accountingOpen = opened;
        void opened.then(owner => {
          ledgerOpening = false;
          if (openingCancelled || disabled || closing) {
            lateAccountingOwner = owner;
          }
        }, () => {ledgerOpening = false;});
        const owner = await waitForSignal(opened, combined);
        ledgerOpening = false;
        if (combined.aborted || disabled || !gate.authorized()) {
          lateAccountingOwner ??= owner;
          return;
        }
        accounting = owner;
        installDelegates(owner);
        if (typeof owner.recoveryStatus === 'function' && typeof owner.preflightRecovery === 'function' &&
            typeof owner.confirmRecovery === 'function' && typeof owner.reserveRecoveryTrial === 'function' &&
            typeof owner.settleRecoveryTrial === 'function' && typeof owner.finishRecovery === 'function' &&
            typeof owner.cancelRecoveryTrial === 'function' && typeof owner.cancelRecovery === 'function') {
          recoveryController = createObserverRecoveryController({
            accounting: owner as import('../estimation/release-accounting.js').ReleaseAccountingRecoveryOwner,
            runtime: recoveryBoundary(),
          });
        }
        ready = true;
        beginRefresh();
      } catch {
        if (!combined.aborted && !disabled) setupFailed = true;
        disable();
      }
    })();
    setup = operation.finally(() => {
      if (setup === operation) setup = undefined;
      setupController = undefined;
    });
    await setup;
  }

  async function readConsent() {
    try { return await consentStore?.read() ?? null; }
    catch { return null; }
  }

  async function revokeConsent(): Promise<void> {
    // Stop permission and owned work immediately; storage failure must not keep
    // dispatch alive. Propagate deletion errors so durable revocation is not claimed.
    disable();
    await consentStore?.revoke();
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      disable();
      await recoveryController?.cancel().catch(() => undefined);
      externalSignal?.removeEventListener('abort', externalAbort!);
      await setup?.catch(() => undefined);
      await accountingOpen?.catch(() => undefined);

      const workerResults = await Promise.allSettled(delegates.map(delegate => delegate?.close() ?? Promise.resolve()));
      await metadataTail.catch(() => undefined);
      let identityClosed = false;
      try {
        await identity.close();
        identityClosed = true;
      } catch { /* Keep the accounting owner open until identity ownership is confirmed. */ }

      const workersClosed = workerResults.every(result => result.status === 'fulfilled');
      const workersConfirmed = delegates.every(delegate => {
        if (!delegate) return true;
        try {
          const state = delegate.status();
          return !state.active && !state.poisoned;
        } catch { return false; }
      });
      if (!workersClosed || !workersConfirmed || !identityClosed) throw new Error('OBSERVER_CLOSE_UNCONFIRMED');

      const owner = accounting ?? lateAccountingOwner;
      if (owner) await owner.close();
    })();
    return closing;
  }

  const recovery = {
    status: () => recoveryController?.status() ?? {state: setupFailed ? 'repair_environment' as const : 'unauthorized' as const, revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false},
    preflight: () => recoveryController?.preflight() ?? Promise.resolve({state: setupFailed ? 'repair_environment' as const : 'unauthorized' as const, revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    confirm: (revision: number) => recoveryController?.confirm(revision) ?? Promise.reject(new Error('OBSERVER_RECOVERY_UNAVAILABLE')),
    cancel: () => recoveryController?.cancel() ?? releaseRecoveryGate(),
    binding: () => recoveryController?.binding(),
  };
  return {workers, start, disable, close, revokeConsent, recoveryBoundary, recovery,
    schedulerRecovery: {attachScheduler(scheduler: SchedulerRecoveryHandle): void { schedulerRecovery = scheduler; }}};
}
