import {parentPort, workerData} from 'node:worker_threads';
import {openReleaseAccounting, type ReleaseAccountingOwner, type ReleaseAccountingRecoveryOwner} from './release-accounting.js';
import {
  ACCOUNTING_PROTOCOL_VERSION,
  parseRequest,
  sanitizedError,
  recoveryStatusCopy,
  snapshotCopy,
  validateClock,
  type AccountingRequest,
} from './accounting-worker-protocol.js';
import type {InvocationRecordPatch} from './invocation-ownership.js';

if (!parentPort) throw new Error('RELEASE_WORKER_FAILED');
const port = parentPort;
const data = workerData as {directory: unknown; initialNow: unknown};
const initialNow = validateClock(data.initialNow);
let clock = initialNow;
let clockAnchor = performance.now();
let owner: ReleaseAccountingOwner | undefined;
type RecoveryPolicyOwner = ReleaseAccountingRecoveryOwner & Required<Pick<ReleaseAccountingRecoveryOwner, 'recoveryAdmission' | 'recordRecoveryEvent' | 'reconcileAutomatic'>>;
const recoveryOwner = (): RecoveryPolicyOwner => {
  if (!owner || typeof owner.recoveryStatus !== 'function' || typeof owner.preflightRecovery !== 'function' ||
      typeof owner.confirmRecovery !== 'function' || typeof owner.reserveRecoveryTrial !== 'function' ||
      typeof owner.settleRecoveryTrial !== 'function' || typeof owner.finishRecovery !== 'function' ||
      typeof owner.cancelRecoveryTrial !== 'function' || typeof owner.cancelRecovery !== 'function' ||
      typeof owner.recoveryAdmission !== 'function' || typeof owner.recordRecoveryEvent !== 'function' || typeof owner.reconcileAutomatic !== 'function') throw new Error('RELEASE_PROTOCOL_INVALID');
  return owner as RecoveryPolicyOwner;
};
let confirmedSnapshot: ReturnType<typeof snapshotCopy> | undefined;

function post(message: unknown): void {
  port.postMessage(message);
}

function currentSnapshot(): ReturnType<typeof snapshotCopy> | undefined {
  try { return owner ? snapshotCopy(owner.snapshot()) : undefined; }
  catch { return confirmedSnapshot; }
}

function responseSnapshot(): ReturnType<typeof snapshotCopy> {
  const snapshot = currentSnapshot();
  if (!snapshot) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
  confirmedSnapshot = snapshot;
  return snapshot;
}
function responseRecovery(): ReturnType<typeof recoveryStatusCopy> {
  const status = owner ? recoveryStatusCopy(recoveryOwner().recoveryStatus()) : undefined;
  if (!status) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
  return status;
}

async function start(): Promise<void> {
  try {
    if (typeof data.directory !== 'string' || data.directory.length === 0 || data.directory.length > 4_096) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
    owner = await openReleaseAccounting(data.directory, () => clock, undefined, undefined,
      () => clock + Math.floor(performance.now() - clockAnchor));
    confirmedSnapshot = snapshotCopy(owner.snapshot());
    post({kind: 'ready', version: ACCOUNTING_PROTOCOL_VERSION, snapshot: confirmedSnapshot, recovery: responseRecovery()});
  } catch (error) {
    post({kind: 'startup-error', version: ACCOUNTING_PROTOCOL_VERSION, error: sanitizedError(error)});
    port.close();
  }
}

async function run(request: AccountingRequest): Promise<void> {
  if (!owner) return;
  if (request.operation === 'shutdown') {
    const snapshot = responseSnapshot();
    const recovery = responseRecovery();
    try {
      await owner.close();
      post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: null, snapshot, recovery});
    } catch (error) {
      post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: sanitizedError(error), snapshot, recovery});
    } finally { port.close(); }
    return;
  }

  if (request.clock < clock) {
    post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: 'RELEASE_CLOCK_REGRESSION', snapshot: responseSnapshot(), recovery: responseRecovery()});
    return;
  }
  if(request.clock > clock) {
    clock = request.clock;
    clockAnchor = performance.now();
  }
  let result: unknown = null;
  let failure: unknown;
  try {
    if (request.operation === 'recovery_status') result = recoveryOwner().recoveryStatus();
    else if (request.operation === 'recovery_preflight') result = await recoveryOwner().preflightRecovery(request.binding);
    else if (request.operation === 'recovery_confirm') result = await recoveryOwner().confirmRecovery({revision: request.revision, binding: request.binding});
    else if (request.operation === 'recovery_trial_reserve') result = await recoveryOwner().reserveRecoveryTrial({attemptId: request.attemptId, revision: request.revision, binding: request.binding});
    else if (request.operation === 'recovery_trial_settle') await recoveryOwner().settleRecoveryTrial(request.attemptId, request.reservationId, request.usage);
    else if (request.operation === 'recovery_finish') await recoveryOwner().finishRecovery(request.attemptId, {success: request.success, closureConfirmed: request.closureConfirmed});
    else if (request.operation === 'recovery_cancel_trial') await recoveryOwner().cancelRecoveryTrial(request.attemptId, request.reservationId);
    else if (request.operation === 'recovery_cancel') await recoveryOwner().cancelRecovery(request.attemptId);
    else if (request.operation === 'recovery_reconcile_pending') result = await recoveryOwner().reconcileRecoveredPending(request.proof);
    else if (request.operation === 'recovery_reconcile_automatic') result = await recoveryOwner().reconcileAutomatic();
    else if (request.operation === 'recovery_admission') result = await recoveryOwner().recoveryAdmission(request.clock, request.eligibleTask, request.conversationKey);
    else if (request.operation === 'recovery_admission_release') await owner.forConversation(request.conversationKey).releaseRecoveryAdmission?.();
    else if (request.operation === 'recovery_event') await recoveryOwner().recordRecoveryEvent({kind: request.eventKind, at: request.clock, ...(request.conversationKey === undefined ? {} : {conversationKey: request.conversationKey})});
    else if (request.operation === 'invocation_bind') await owner.forConversation(request.conversationKey).bindInvocation?.(request.reservationId, request.record);
    else if (request.operation === 'invocation_update') await owner.forConversation(request.conversationKey).updateInvocation?.(request.reservationId, request.patch as InvocationRecordPatch);
    else {
      const view = owner.forConversation(request.conversationKey);
      if (request.operation === 'reserve') result = await view.reserve(request.admissionKind, request.purpose);
      else if(request.operation==='not_dispatched') await view.cancelBeforeDispatch(request.reservationId);
      else await view.settle(request.reservationId, request.usage, request.settlement);
      await view.close().catch(error => { if (!failure) failure = error; });
    }
  } catch (error) { failure = error; }

  const snapshot = responseSnapshot();
  const recovery = responseRecovery();
  if (failure) post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: sanitizedError(failure), snapshot, recovery});
  else post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result, snapshot, recovery});
}

let serial: Promise<void> = start();
await serial;
if (owner) {
  port.on('message', value => {
    const request = parseRequest(value);
    if (!request) {
      port.close();
      return;
    }
    serial = serial.then(() => run(request), () => run(request)).catch(error => {
      try {
        if (confirmedSnapshot) post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: sanitizedError(error), snapshot: confirmedSnapshot, recovery: {state: 'blocked', revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false}});
      } catch { port.close(); }
    });
  });
}
