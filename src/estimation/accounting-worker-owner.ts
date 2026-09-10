import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import type {AccountedUsage, AdmissionKind, SettlementClassification, SubscriptionAccounting} from './subscription-accounting.js';
import type {ReleaseAccountingOwner, ReleaseAccountingSnapshot, ReleaseRecoveryEvent} from './release-accounting.js';
import {
  ACCOUNTING_OPERATION_TIMEOUT_MS,
  ACCOUNTING_PROTOCOL_VERSION,
  ACCOUNTING_STARTUP_TIMEOUT_MS,
  MAX_ACCOUNTING_PENDING,
  cloneUsage,
  parseWorkerMessage,
  recoveryConfirmationCopy,
  recoveryAdmissionCopy,
  recoveryPreflightCopy,
  recoveryStatusCopy,
  sanitizedError,
  snapshotCopy,
  validateClock,
  validateConversationKey,
  validateReservationId,
  type AccountingErrorCode,
  type AccountingResponse,
} from './accounting-worker-protocol.js';
import type {ReleaseRecoveryConfirmation, ReleaseRecoveryPreflight, ReleaseRecoveryStatus} from './release-accounting.js';

type Pending = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function error(code: string): Error { return new Error(code); }

export async function openThreadedReleaseAccounting(directory: string, now: () => number): Promise<ReleaseAccountingOwner> {
  if (typeof now !== 'function') throw error('RELEASE_INVALID_CLOCK');
  let initialNow: number;
  try { initialNow = validateClock(now()); }
  catch (initialError) { throw error(sanitizedError(initialError)); }
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 4_096) throw error('RELEASE_DATABASE_UNAVAILABLE');

  // The desktop's first launch has no ledger directory yet. SQLite creates a
  // database file, not its parent; retain all existing accounting state.
  try { await mkdir(directory, {recursive: true, mode: 0o700}); }
  catch { throw error('RELEASE_DATABASE_UNAVAILABLE'); }

  const worker = new Worker(new URL('./accounting-worker-entry.js', import.meta.url), {workerData: {directory: String(directory), initialNow}});
  const pending = new Map<string, Pending>();
  const operations = new Set<Promise<unknown>>();
  let confirmed: ReleaseAccountingSnapshot = {starts: 0, activeStarts: 0, inFlight: 0, unresolved: 0, knownTokens: 0, unknown: 0, poisoned: false};
  let confirmedRecovery: ReleaseRecoveryStatus = {state: 'normal', revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false};
  let failed = false;
  let ownerClosed = false;
  let closePromise: Promise<void> | undefined;
  let closeRequested = false;
  let submissionQueue: Promise<void> = Promise.resolve();
  let exitResolve!: () => void;
  let exitReject!: (reason?: unknown) => void;
  const exited = new Promise<void>((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
  void exited.catch(() => undefined);
  let readySeen = false;
  let startupSettled = false;
  let startupResolve!: () => void;
  let startupReject!: (reason?: unknown) => void;
  const startup = new Promise<void>((resolve, reject) => { startupResolve = resolve; startupReject = reject; });

  function updateConfirmed(snapshot: ReleaseAccountingSnapshot): void {
    const checked = snapshotCopy(snapshot);
    if (checked.starts < confirmed.starts || checked.knownTokens < confirmed.knownTokens || checked.unknown < confirmed.unknown) throw error('RELEASE_PROTOCOL_INVALID');
    confirmed = checked;
  }
  function updateConfirmedRecovery(status: ReleaseRecoveryStatus): void {
    const checked = recoveryStatusCopy(status);
    if (checked.revision < confirmedRecovery.revision || checked.knownTokens < confirmedRecovery.knownTokens || checked.unknown < confirmedRecovery.unknown) throw error('RELEASE_PROTOCOL_INVALID');
    confirmedRecovery = checked;
  }

  function settleStartupFailure(reason: Error): void {
    if (startupSettled) return;
    startupSettled = true;
    startupReject(reason);
  }

  function poison(code: AccountingErrorCode | 'RELEASE_WORKER_TIMEOUT' = 'RELEASE_WORKER_FAILED'): void {
    if (failed) return;
    failed = true;
    confirmed = {...confirmed, poisoned: true};
    const failure = error(code);
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
      entry.reject(failure);
    }
  }

  function responseError(response: AccountingResponse): Error { return error(response.error ?? 'RELEASE_PROTOCOL_INVALID'); }

  async function terminateWorkerBounded(): Promise<void> {
    const termination = worker.terminate().then(() => undefined).catch(() => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([termination, new Promise<void>(resolve => { deadline = setTimeout(resolve, ACCOUNTING_OPERATION_TIMEOUT_MS); })]);
    } finally { if (deadline) clearTimeout(deadline); }
  }

  worker.on('message', value => {
    const message = parseWorkerMessage(value);
    if (!message) { poison('RELEASE_PROTOCOL_INVALID'); return; }
    if (message.kind === 'ready') {
      if (readySeen || failed) { poison('RELEASE_PROTOCOL_INVALID'); return; }
      readySeen = true;
      try { updateConfirmed(message.snapshot); }
      catch { poison('RELEASE_PROTOCOL_INVALID'); settleStartupFailure(error('RELEASE_PROTOCOL_INVALID')); return; }
      try { updateConfirmedRecovery(message.recovery); }
      catch { poison('RELEASE_PROTOCOL_INVALID'); settleStartupFailure(error('RELEASE_PROTOCOL_INVALID')); return; }
      if (!startupSettled) { startupSettled = true; startupResolve(); }
      return;
    }
    if (message.kind === 'startup-error') { poison(message.error); settleStartupFailure(error(message.error)); return; }
    if (!readySeen || failed) { poison('RELEASE_PROTOCOL_INVALID'); return; }
    const entry = pending.get(message.requestId);
    if (!entry) { poison('RELEASE_PROTOCOL_INVALID'); return; }
    try { updateConfirmed(message.snapshot); }
    catch { poison('RELEASE_PROTOCOL_INVALID'); return; }
    try { updateConfirmedRecovery(message.recovery); }
    catch { poison('RELEASE_PROTOCOL_INVALID'); return; }
    clearTimeout(entry.timer);
    pending.delete(message.requestId);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(responseError(message));
  });
  worker.on('error', () => { poison('RELEASE_WORKER_FAILED'); settleStartupFailure(error('RELEASE_WORKER_FAILED')); });
  worker.on('exit', code => {
    if (code === 0 && closeRequested) exitResolve();
    else if (code !== 0 || !closeRequested) {
      poison('RELEASE_WORKER_EXITED');
      exitReject(error('RELEASE_WORKER_EXITED'));
      settleStartupFailure(error('RELEASE_WORKER_EXITED'));
    }
  });

  const startupTimer = setTimeout(() => { poison('RELEASE_WORKER_TIMEOUT'); settleStartupFailure(error('RELEASE_WORKER_TIMEOUT')); }, ACCOUNTING_STARTUP_TIMEOUT_MS);
  try { await startup; }
  catch (startupError) { clearTimeout(startupTimer); await terminateWorkerBounded(); throw error(sanitizedError(startupError)); }
  clearTimeout(startupTimer);

  function track<T>(promise: Promise<T>): Promise<T> {
    operations.add(promise);
    promise.finally(() => operations.delete(promise)).catch(() => undefined);
    return promise;
  }

  type NonShutdownOperation = Exclude<import('./accounting-worker-protocol.js').AccountingRequest['operation'], 'shutdown'>;
  function send(operation: NonShutdownOperation, payload: Record<string, unknown>): Promise<unknown> {
    if (failed) return Promise.reject(error('RELEASE_DATABASE_UNAVAILABLE'));
    if (pending.size >= MAX_ACCOUNTING_PENDING) return Promise.reject(error('RELEASE_PENDING_LIMIT'));
    const requestId = randomUUID();
    let resolveRequest!: (value: unknown) => void;
    let rejectRequest!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const timer = setTimeout(() => poison('RELEASE_WORKER_TIMEOUT'), ACCOUNTING_OPERATION_TIMEOUT_MS);
    pending.set(requestId, {promise, resolve: resolveRequest, reject: rejectRequest, timer});
    submissionQueue = submissionQueue.then(() => {
      if (failed) throw error('RELEASE_DATABASE_UNAVAILABLE');
      const clock = validateClock(now());
      const message = {kind: 'request' as const, version: ACCOUNTING_PROTOCOL_VERSION, requestId, operation, ...payload, clock};
      try { worker.postMessage(message); }
      catch (postError) { poison('RELEASE_WORKER_FAILED'); throw postError; }
    }).catch(reason => {
      const entry = pending.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(requestId);
      entry.reject(error(sanitizedError(reason)));
    });
    return track(promise);
  }

  function createView(key: string): SubscriptionAccounting {
    let viewClosed = false;
    let closingPromise: Promise<void> | undefined;
    const viewOperations = new Set<Promise<unknown>>();
    function viewTrack<T>(promise: Promise<T>): Promise<T> {
      viewOperations.add(promise);
      promise.finally(() => viewOperations.delete(promise)).catch(() => undefined);
      return promise;
    }
    return {
      reserve(admissionKind: AdmissionKind = 'ordinary'): Promise<string | null> {
        if (viewClosed || ownerClosed) return Promise.resolve(null);
        return viewTrack(send('reserve', {conversationKey: key, admissionKind}) as Promise<string | null>);
      },
      settle(id: string, inputUsage: AccountedUsage | null, classification: SettlementClassification = inputUsage === null ? 'unsafe_unknown' : 'known_success'): Promise<void> {
        if (ownerClosed) return Promise.reject(error('RELEASE_OWNER_CLOSED'));
        if (viewClosed) return Promise.reject(error('RELEASE_VIEW_CLOSED'));
        let copiedId: string;
        let copiedUsage: AccountedUsage | null;
        try { copiedId = validateReservationId(id); copiedUsage = cloneUsage(inputUsage); }
        catch (validationError) { return Promise.reject(validationError); }
        return viewTrack(send('settle', {conversationKey: key, reservationId: copiedId, usage: copiedUsage, settlement: classification}).then(() => undefined));
      },
      cancelBeforeDispatch(id:string):Promise<void>{
        if(ownerClosed)return Promise.reject(error('RELEASE_OWNER_CLOSED'));
        if(viewClosed)return Promise.reject(error('RELEASE_VIEW_CLOSED'));
        let copiedId:string;try{copiedId=validateReservationId(id);}catch(validationError){return Promise.reject(validationError);}
        return viewTrack(send('not_dispatched', {conversationKey: key, reservationId: copiedId}).then(()=>undefined));
      },
      releaseRecoveryAdmission(): Promise<void> {
        if (ownerClosed) return Promise.reject(error('RELEASE_OWNER_CLOSED'));
        if (viewClosed) return Promise.reject(error('RELEASE_VIEW_CLOSED'));
        return viewTrack(send('recovery_admission_release', {conversationKey: key}).then(() => undefined));
      },
      close(): Promise<void> {
        if (closingPromise) return closingPromise;
        viewClosed = true;
        closingPromise = Promise.allSettled([...viewOperations]).then(() => undefined);
        return closingPromise;
      },
    };
  }

  function recoverySend(operation: NonShutdownOperation, payload: Record<string, unknown>): Promise<unknown> {
    return send(operation, payload);
  }

  async function stopAfterClose(): Promise<void> {
    await Promise.allSettled([...operations]);
    if (failed) { await terminateWorkerBounded(); return; }
    closeRequested = true;
    const requestId = randomUUID();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { poison('RELEASE_WORKER_TIMEOUT'); reject(error('RELEASE_WORKER_TIMEOUT')); }, ACCOUNTING_OPERATION_TIMEOUT_MS);
        pending.set(requestId, {promise: Promise.resolve(), resolve: value => { clearTimeout(timer); resolve(value as void); }, reject: reason => { clearTimeout(timer); reject(reason); }, timer});
        try { worker.postMessage({kind: 'request', version: ACCOUNTING_PROTOCOL_VERSION, requestId, operation: 'shutdown'}); }
        catch (postError) { clearTimeout(timer); poison('RELEASE_WORKER_FAILED'); reject(error(sanitizedError(postError))); }
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(error('RELEASE_WORKER_TIMEOUT')), ACCOUNTING_OPERATION_TIMEOUT_MS);
        exited.then(() => { clearTimeout(timer); resolve(); }, reason => { clearTimeout(timer); reject(reason); });
      });
    } catch (shutdownError) {
      await terminateWorkerBounded();
      throw error(sanitizedError(shutdownError));
    }
  }

  const owner: ReleaseAccountingOwner = {
    forConversation(key: string): SubscriptionAccounting {
      return createView(validateConversationKey(key));
    },
    snapshot(): ReleaseAccountingSnapshot { return {...confirmed}; },
    recoveryStatus(): ReleaseRecoveryStatus {
      return {...confirmedRecovery};
    },
    preflightRecovery(binding: string): Promise<ReleaseRecoveryPreflight> {
      return recoverySend('recovery_preflight', {binding}).then(value => recoveryPreflightCopy(value as ReleaseRecoveryPreflight));
    },
    confirmRecovery(input: {revision: number; binding: string}): Promise<ReleaseRecoveryConfirmation> {
      return recoverySend('recovery_confirm', input as unknown as Record<string, unknown>).then(value => recoveryConfirmationCopy(value as ReleaseRecoveryConfirmation));
    },
    reserveRecoveryTrial(confirmation: ReleaseRecoveryConfirmation): Promise<string | null> {
      return recoverySend('recovery_trial_reserve', confirmation as unknown as Record<string, unknown>) as Promise<string | null>;
    },
    settleRecoveryTrial(attemptId: string, reservationId: string, inputUsage: AccountedUsage | null): Promise<void> {
      return recoverySend('recovery_trial_settle', {attemptId, reservationId, usage: cloneUsage(inputUsage)}).then(() => undefined);
    },
    finishRecovery(attemptId: string, result: {success: boolean; closureConfirmed: boolean}): Promise<void> {
      return recoverySend('recovery_finish', {attemptId, ...result}).then(() => undefined);
    },
    cancelRecoveryTrial(attemptId: string, reservationId: string): Promise<void> {
      return recoverySend('recovery_cancel_trial', {attemptId, reservationId}).then(() => undefined);
    },
    cancelRecovery(attemptId: string): Promise<void> {
      return recoverySend('recovery_cancel', {attemptId}).then(() => undefined);
    },
    recoveryAdmission(_current: number, eligibleTask: boolean, conversationKey?: string) {
      if (!conversationKey) return Promise.resolve({allowed: false, kind: 'ordinary' as const, nextEligibleAt: null, reason: 'no_eligible_task' as const});
      return recoverySend('recovery_admission', {eligibleTask, conversationKey}).then(value => recoveryAdmissionCopy(value as import('./release-accounting.js').ReleaseRecoveryAdmission));
    },
    releaseRecoveryAdmission(conversationKey: string): Promise<void> {
      return recoverySend('recovery_admission_release', {conversationKey}).then(() => undefined);
    },
    recordRecoveryEvent(event: ReleaseRecoveryEvent) {
      return recoverySend('recovery_event', {eventKind: event.kind}).then(() => undefined);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      ownerClosed = true;
      closePromise = stopAfterClose();
      return closePromise;
    },
  };
  return owner;
}
