import {createObserverConsentGate, observerConsentScope, type ObserverAttestation} from '../estimation/observer-consent.js';
import type {PersistentReceiptBinding} from '../estimation/observer-persistent-receipt.js';
import type {ObserverConsentStore} from '../estimation/observer-consent-store.js';
import {createAccountedObserverWorker, type ObserverWorker} from '../estimation/observer-worker.js';
import type {ObserverInput} from '../estimation/observer-contract.js';
import type {ObserverCallStage} from '../estimation/observer-provider.js';
import type {Invocation} from '../estimation/owned-process.js';
import type {ReleaseAccountingOwner} from '../estimation/release-accounting.js';
import type {ForecastVersions} from '../estimation/forecast-record.js';
import {requestObserverConsent, type ObserverConsentDialog} from './observer-consent-dialog.js';
import {createObserverRecoveryController, type ObserverRecoveryController, type RecoveryRuntimeBoundary} from './observer-recovery.js';
import {createObserverDiagnosticRunner, type ObserverDiagnostic} from '../estimation/observer-diagnostics.js';
import {createObserverSubscriptionSession, type ObserverSubscriptionResult} from '../estimation/subscription-session.js';
import type {AccountedUsage} from '../estimation/subscription-accounting.js';
import type {ObserverScheduler, ObserverWorkerSource} from '../estimation/observer-scheduler.js';
import {inspectRecoveryBootBoundary, type RecoveryBootBoundaryProof} from '../estimation/recovery-boot-boundary.js';
import {withContextPreparation, type PreparationConfiguration, type PreparationScope} from '../estimation/context-worker.js';
import type {CompressionRequest} from '../estimation/context-compression.js';

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
  prepareSession?(signal:AbortSignal):Promise<{accountLabel:string;evidence:ObserverAttestation;invocation:Invocation}>;
  prepareEstimate(input: ObserverInput, signal: AbortSignal): Promise<{
    accountLabel: string;
    evidence: ObserverAttestation;
    invocation: Invocation;
    provenance?: ForecastVersions;
  }>;
  /** Trusted, pinned summary invocation; never a general-purpose model call. */
  prepareCompression?(request: CompressionRequest, signal: AbortSignal): Promise<{
    accountLabel: string;
    evidence: ObserverAttestation;
    invocation: Invocation;
  }>;
  disable(): void;
  close(): Promise<void>;
}

export interface DesktopObserverContextPreparation {
  /** Capacity-derived, host-attested allowance for the prepared observer
   * invocation. It only widens stdin; output and argument limits remain owned
   * by the process runner. */
  inputBudgetBytes?: number;
  configure: (scope: PreparationScope, prepareCompression: TrustedCompressionPreparation,
    authorize: () => boolean, accounting: ReleaseAccountingOwner) => Promise<PreparationConfiguration>;
}

type TrustedCompressionPreparation = (request: CompressionRequest, signal: AbortSignal) => Promise<{
  accountLabel: string;
  evidence: ObserverAttestation;
  invocation: Invocation;
}>;

export interface DesktopObserverRuntimeOptions {
  identity: DesktopObserverIdentity;
  openAccounting: () => Promise<ReleaseAccountingOwner>;
  dialog: ObserverConsentDialog;
  now?: () => number;
  consentStore?: ObserverConsentStore;
  inspectRecoveryBootBoundary?: () => Promise<RecoveryBootBoundaryProof>;
  contextPreparation?: DesktopObserverContextPreparation;
  /** Host-selected implementation; never selected by source conversation text. */
  persistentWorkerFactory?:(options:{accounting:ReleaseAccountingOwner;prepareSession:(signal:AbortSignal)=>Promise<{invocation:Invocation;binding:PersistentReceiptBinding}>;
    receiptDirectory:string;
    authorize:()=>boolean;now:()=>number})=>ObserverWorker;
  persistentReceiptDirectory?:string;
}

export interface ObserverInlineConsent {
  kind: 'inline';
  accountFingerprint: string;
  generation: number;
  revision: number;
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
export function createDesktopObserverRuntime({identity, openAccounting, dialog, now = Date.now, consentStore,
  inspectRecoveryBootBoundary: inspectBootBoundary, contextPreparation,persistentWorkerFactory,persistentReceiptDirectory}: DesktopObserverRuntimeOptions) {
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
  const delegates = new Map<string, ObserverWorker>();
  const releasingDelegates=new Set<string>();

  function disableDelegates(): void {
    for (const delegate of delegates.values()) {
      try {delegate.disable();} catch { /* Keep ownership until close confirms it. */ }
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

  function slot(key: string): ObserverWorker {
    return {
      observe(input, signal, conversationKey, turnGeneration, onStage): Promise<ObserverResult> {
        const delegate = delegates.get(key);
        if (disabled || !ready || !delegate) return Promise.resolve(unavailable());
        try {return delegate.observe(input, signal, conversationKey, turnGeneration, onStage);}
        catch {return Promise.resolve(unavailable());}
      },
      status() {
        const delegate = delegates.get(key);
        if (!delegate) return {active: false, disabled: true, poisoned: false, setupFailed};
        try {
          const state = delegate.status();
          return disabled || !ready ? {...state, disabled: true} : state;
        }
        catch {return {active: true, disabled: true, poisoned: true};}
      },
      disable() {
        try {delegates.get(key)?.disable();} catch { /* Close retains the failed owner. */ }
      },
      close() {
        try {return delegates.get(key)?.close() ?? Promise.resolve();}
        catch {return Promise.reject(new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED'));}
      },
      provenance() {
        const delegate=delegates.get(key);
        if (disabled || !ready || !delegate) return null;
        try {return delegate.provenance?.() ?? null;}
        catch {return null;}
      },
    };
  }

  const workerSource: ObserverWorkerSource = {
    acquire(conversationKey: string): ObserverWorker {
      if (disabled || !ready || !accounting) throw new Error('OBSERVER_NOT_READY');
      if(releasingDelegates.has(conversationKey))throw new Error('OBSERVER_WORKER_CLOSING');
      const existing = delegates.get(conversationKey);
      if (existing) {
        const state=existing.status();
        if(state.active)throw new Error('OBSERVER_WORKER_CLOSING');
        if(!state.disabled&&!state.poisoned)return existing;
        delegates.delete(conversationKey);
      }
      const owner = accounting;
      if (!owner) throw new Error('OBSERVER_NOT_READY');
      if (persistentWorkerFactory && !persistentReceiptDirectory) throw new Error('PERSISTENT_RECEIPT_REQUIRED');
      const delegate = persistentWorkerFactory ? persistentWorkerFactory({accounting:owner,prepareSession,
        receiptDirectory:persistentReceiptDirectory!,
        authorize:()=>!disabled&&ready&&gate.authorized(),now}) : createAccountedObserverWorker({
        accounting: owner,
        prepare,
        authorize: gate.authorized,
        now,
        ...(contextPreparation?.inputBudgetBytes === undefined ? {} : {inputBudgetBytes: contextPreparation.inputBudgetBytes}),
      });
      const worker = persistentWorkerFactory || contextPreparation === undefined ? delegate : withContextPreparation(delegate,
        scope => contextPreparation.configure(scope, prepareCompression, () => !disabled && ready && gate.authorized(), owner));
      delegates.set(conversationKey, worker);
      return worker;
    },
    async release(conversationKey: string): Promise<void> {
      const delegate = delegates.get(conversationKey);
      if (!delegate) return;
      if(releasingDelegates.has(conversationKey))return;
      releasingDelegates.add(conversationKey);
      try {
        if(delegate.release){
          await delegate.release();
          const state=delegate.status();
          if(!state.active&&!state.disabled&&!state.poisoned)return;
        }
        await delegate.close();
        if(delegate.status().active)throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');
        if(delegates.get(conversationKey)===delegate)delegates.delete(conversationKey);
      }finally{releasingDelegates.delete(conversationKey);}
    },
    all: () => [...delegates.values()],
  };
  // Legacy consumers receive stable handles, while production scheduling uses
  // workerSource directly and therefore has no fixed concurrency ceiling.
  const workers = Object.freeze(Array.from({length: 2}, () => ({
    observe(input: ObserverInput, signal: AbortSignal, conversationKey: string, turnGeneration?: number,onStage?:(stage:ObserverCallStage)=>void): Promise<ObserverResult> {
      if (disabled || !ready) return Promise.resolve(unavailable());
      try { return workerSource.acquire(conversationKey).observe(input, signal, conversationKey, turnGeneration, onStage); }
      catch { return Promise.resolve(unavailable()); }
    },
    status() {
      if (disabled || !ready) return {active: false, disabled: true, poisoned: false, setupFailed};
      const states = workerSource.all().map(worker => worker.status());
      return {active: states.some(state => state.active), disabled: false, poisoned: states.some(state => state.poisoned)};
    },
    disable() { disableDelegates(); },
    async close() { await Promise.all([...delegates.values()].map(delegate => delegate.close())); },
    provenance() { return workerSource.all()[0]?.provenance?.() ?? null; },
  }))) as readonly ObserverWorker[];

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

  function prepareSession(signal:AbortSignal):Promise<{invocation:Invocation;binding:PersistentReceiptBinding}> {
    const queued=serial(metadataTail,async()=>{
      check(signal);
      if(!identity.prepareSession)throw Error('OBSERVER_SESSION_UNAVAILABLE');
      const prepared=await identity.prepareSession(signal);
      check(signal);gate.update(prepared.evidence);
      if(!gate.authorized()||authorizedBinding===undefined||binding(prepared.evidence)!==authorizedBinding){
        disable();throw Error('OBSERVER_IDENTITY_CHANGED');
      }
      return {invocation:prepared.invocation,binding:{accountFingerprint:prepared.evidence.accountFingerprint,
        routeFingerprint:prepared.evidence.routeFingerprint,assetsFingerprint:prepared.evidence.assetsFingerprint}};
    });
    metadataTail=queued.next;return queued.result;
  }

  const prepareCompression: TrustedCompressionPreparation = (request, signal) => {
    const queued = serial(metadataTail, async () => {
      check(signal);
      if (identity.prepareCompression === undefined) throw new Error('OBSERVER_COMPRESSION_UNAVAILABLE');
      const prepared = await identity.prepareCompression(request, signal);
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
  };

  function installDelegates(owner: ReleaseAccountingOwner): void {
    accounting = owner;
  }

  async function rebuildDelegates(): Promise<void> {
    if (disabled || !ready || !accounting) throw new Error('OBSERVER_RECOVERY_DISABLED');
    const old = [...delegates.values()];
    for (const delegate of old) {
      try { delegate?.disable(); } catch { /* close below verifies ownership */ }
    }
    const closed = await Promise.allSettled(old.map(delegate => delegate?.close() ?? Promise.resolve()));
    if (closed.some(result => result.status === 'rejected') || old.some(delegate => {
      if (!delegate) return false;
      try { const state = delegate.status(); return state.active || state.poisoned; }
      catch { return true; }
    })) throw new Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');
    delegates.clear();
    recoveryDelegatesClosed = false;
  }

  async function closeDelegatesForRecovery(): Promise<void> {
    const old = [...delegates.values()];
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

  async function reconcileRecoveredCalls(signal:AbortSignal):Promise<boolean> {
    check(signal);
    if(accounting?.recoveryStatus?.()?.reason!=='unresolved_previous_call')return true;
    if(typeof accounting.reconcileRecoveredPending!=='function')return false;
    let proof:Awaited<ReturnType<typeof inspectRecoveryBootBoundary>>;
    try{proof=await (inspectBootBoundary??(()=>inspectRecoveryBootBoundary({now})))();}
    catch{return false;}
    check(signal);
    // Bind the asynchronous probe to the same authorized account. This helper
    // never starts a trial and never treats companion restart as OS reboot.
    const snapshot=await identity.inspect(signal);
    check(signal);gate.update(snapshot.evidence);
    if(!gate.authorized()||binding(snapshot.evidence)!==authorizedBinding){
      disable();throw Error('OBSERVER_RECOVERY_BINDING_CHANGED');
    }
    try{await accounting.reconcileRecoveredPending(proof);return true;}
    catch{return false;}
  }

  function recoveryBoundary(): RecoveryRuntimeBoundary {
    return {
      enabled: () => !disabled && ready && gate.authorized(),
      async check(signal: AbortSignal): Promise<{binding: string; closureConfirmed: boolean; reason?: 'unresolved_previous_call'}> {
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
        const states = [...delegates.values()].map(delegate => {
          try { return delegate?.status() ?? {active: false, poisoned: false}; }
          catch { return {active: true, poisoned: true}; }
        });
        const closureConfirmed = states.every(state => !state.active && !state.poisoned);
        if (!closureConfirmed) return {binding: current, closureConfirmed: false, reason: 'unresolved_previous_call'};
        if(!await reconcileRecoveredCalls(signal))return {binding:current,closureConfirmed:false,reason:'unresolved_previous_call'};
        return {binding: current, closureConfirmed: true};
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
        let result: ObserverSubscriptionResult;
        try { result = await session.observe(RECOVERY_INPUT, signal); }
        catch { result = {status: 'disabled', interpretation: null, usage: null}; }
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

  async function start(signal: AbortSignal, inlineConsent?: ObserverInlineConsent): Promise<void> {
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
        const inline = inlineConsent !== undefined && inlineConsent.accountFingerprint === snapshot.evidence.accountFingerprint
          ? (() => { const offer = gate.offer(); return offer !== null && gate.accept(offer); })()
          : false;
        const consent = restored ? true : inlineConsent !== undefined ? inline : await waitForSignal(requestObserverConsent(gate, dialog, snapshot.accountLabel), combined);
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
        await reconcileRecoveredCalls(combined);
        check(combined);
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
    // One-step activation must not turn a swallowed setup error into provider ready.
    if (inlineConsent !== undefined && (disabled || !ready)) throw new Error('OBSERVER_SETUP_UNAVAILABLE');
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

        const workerResults = await Promise.allSettled([...delegates.values()].map(delegate => delegate.close()));
      await metadataTail.catch(() => undefined);
      let identityClosed = false;
      try {
        await identity.close();
        identityClosed = true;
      } catch { /* Keep the accounting owner open until identity ownership is confirmed. */ }

      const workersClosed = workerResults.every(result => result.status === 'fulfilled');
      const workersConfirmed = [...delegates.values()].every(delegate => {
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
  return {workers, workerSource, start, disable, close, revokeConsent, recoveryBoundary, recovery,
    schedulerRecovery: {attachScheduler(scheduler: SchedulerRecoveryHandle): void { schedulerRecovery = scheduler; }}};
}
