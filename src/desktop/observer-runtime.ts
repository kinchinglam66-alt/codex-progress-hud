import {createObserverConsentGate, type ObserverAttestation} from '../estimation/observer-consent.js';
import {createAccountedObserverWorker, type ObserverWorker} from '../estimation/observer-worker.js';
import type {ObserverInput} from '../estimation/observer-contract.js';
import type {Invocation} from '../estimation/owned-process.js';
import type {ReleaseAccountingOwner} from '../estimation/release-accounting.js';
import type {ForecastVersions} from '../estimation/forecast-record.js';
import {requestObserverConsent, type ObserverConsentDialog} from './observer-consent-dialog.js';

const SLOT_COUNT = 2;
const REFRESH_MS = 120000;

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
}

type ObserverResult = Awaited<ReturnType<ObserverWorker['observe']>>;

const unavailable = (): ObserverResult => ({status: 'disabled', interpretation: null, usage: null});

function binding(evidence: ObserverAttestation): string {
  return `${evidence.accountFingerprint}:${evidence.routeFingerprint}:${evidence.assetsFingerprint}`;
}

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
export function createDesktopObserverRuntime({identity, openAccounting, dialog, now = Date.now}: DesktopObserverRuntimeOptions) {
  let disabled = false;
  let ready = false;
  let setupFailed = false;
  let setup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let setupController: AbortController | undefined;
  let externalSignal: AbortSignal | undefined;
  let externalAbort: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let metadataTail: Promise<void> = Promise.resolve();
  let accounting: ReleaseAccountingOwner | undefined;
  let accountingOpen: Promise<ReleaseAccountingOwner> | undefined;
  let lateAccountingOwner: ReleaseAccountingOwner | undefined;
  let ledgerOpening = false;
  let openingCancelled = false;
  let authorizedBinding: string | undefined;
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
    try {identity.disable();} catch { /* Identity close reports uncertain ownership. */ }
    disableDelegates();
    gate.revoke();
  }

  const gate = createObserverConsentGate({now, onInvalidate: disable});

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

  function refresh(): void {
    const queued = serial(metadataTail, async () => {
      if (disabled || !ready || !gate.authorized()) return;
      try {
        const snapshot = await identity.inspect(new AbortController().signal);
        if (disabled) return;
        gate.update(snapshot.evidence);
        if (!gate.authorized() || authorizedBinding === undefined || binding(snapshot.evidence) !== authorizedBinding) disable();
      } catch {
        disable();
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
        const consent = await waitForSignal(requestObserverConsent(gate, dialog, snapshot.accountLabel), combined);
        if (!consent || !gate.authorized()) throw new Error('OBSERVER_CONSENT_REQUIRED');

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
        for (let index = 0; index < SLOT_COUNT; index++) {
          delegates[index] = createAccountedObserverWorker({
            accounting: owner,
            prepare,
            authorize: () => !disabled && ready && gate.authorized(),
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

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      disable();
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

  return {workers, start, disable, close};
}
