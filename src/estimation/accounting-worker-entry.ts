import {parentPort, workerData} from 'node:worker_threads';
import {openReleaseAccounting, type ReleaseAccountingOwner} from './release-accounting.js';
import {
  ACCOUNTING_PROTOCOL_VERSION,
  parseRequest,
  sanitizedError,
  snapshotCopy,
  validateClock,
  type AccountingRequest,
} from './accounting-worker-protocol.js';

if (!parentPort) throw new Error('RELEASE_WORKER_FAILED');
const port = parentPort;
const data = workerData as {directory: unknown; initialNow: unknown};
const initialNow = validateClock(data.initialNow);
let clock = initialNow;
let owner: ReleaseAccountingOwner | undefined;
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

async function start(): Promise<void> {
  try {
    if (typeof data.directory !== 'string' || data.directory.length === 0 || data.directory.length > 4_096) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
    owner = await openReleaseAccounting(data.directory, () => clock);
    confirmedSnapshot = snapshotCopy(owner.snapshot());
    post({kind: 'ready', version: ACCOUNTING_PROTOCOL_VERSION, snapshot: confirmedSnapshot});
  } catch (error) {
    post({kind: 'startup-error', version: ACCOUNTING_PROTOCOL_VERSION, error: sanitizedError(error)});
    port.close();
  }
}

async function run(request: AccountingRequest): Promise<void> {
  if (!owner) return;
  if (request.operation === 'shutdown') {
    const snapshot = responseSnapshot();
    try {
      await owner.close();
      post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: null, snapshot});
    } catch (error) {
      post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: sanitizedError(error), snapshot});
    } finally { port.close(); }
    return;
  }

  if (request.clock < clock) {
    post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: 'RELEASE_CLOCK_REGRESSION', snapshot: responseSnapshot()});
    return;
  }
  clock = request.clock;
  const view = owner.forConversation(request.conversationKey);
  let result: string | null = null;
  let failure: unknown;
  try {
    if (request.operation === 'reserve') result = await view.reserve();
    else if(request.operation==='not_dispatched')await view.cancelBeforeDispatch(request.reservationId);
    else await view.settle(request.reservationId, request.usage);
  } catch (error) { failure = error; }
  finally { await view.close().catch(error => { if (!failure) failure = error; }); }

  const snapshot = responseSnapshot();
  if (failure) post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: sanitizedError(failure), snapshot});
  else post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result, snapshot});
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
        if (confirmedSnapshot) post({kind: 'response', version: ACCOUNTING_PROTOCOL_VERSION, requestId: request.requestId, ok: false, result: null, error: sanitizedError(error), snapshot: confirmedSnapshot});
      } catch { port.close(); }
    });
  });
}
