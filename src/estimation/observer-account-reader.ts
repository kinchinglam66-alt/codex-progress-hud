import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {observerRouteFingerprint} from './observer-route.js';
import {ObserverAccountTimeout} from './observer-call-failure.js';

const MAX_STREAM_BYTES = 512 * 1024;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;
const MAX_PLAN_LENGTH = 64;
const TERMINATION_GRACE_MS = 1_000;
const PLAN_TYPES = new Set([
  'free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_prolite',
  'self_serve_business_usage_based', 'business', 'ent26', 'enterprise_cbp_automation',
  'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro', 'unknown',
]);

export interface ObserverAccount {
  accountId: string;
  email: string | null;
  planType: string;
  routeFingerprint: string;
}

type Ownership = 'idle' | 'reading' | 'termination_failed';
export interface AccountReadDiagnostic {
  reason:'passed'|'login_required'|'timeout'|'cancelled'|'rpc_error'|'read_failed';
  phase:number;elapsedMs:number;
}
type JsonObject = Record<string, unknown>;

const failure = (): Error => new Error('OBSERVER_ACCOUNT_READ_FAILED');
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeText(value: unknown, maxLength: number): value is string;
function safeText(value: unknown, maxLength: number, allowNull: true): value is string | null;
function safeText(value: unknown, maxLength: number, allowNull = false): boolean {
  if (allowNull && value === null) return true;
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function readAccount(result: unknown): {email: string | null; planType: string} | undefined {
  if (!isObject(result) || result.requiresOpenaiAuth !== true || !isObject(result.account)) return undefined;
  const account = result.account;
  if (account.type !== 'chatgpt' || !safeText(account.email, MAX_EMAIL_LENGTH, true) ||
      typeof account.planType !== 'string' || account.planType.length > MAX_PLAN_LENGTH || !PLAN_TYPES.has(account.planType)) return undefined;
  return {email: account.email, planType: account.planType};
}

function readRateLimits(result: unknown): string | undefined {
  if (!isObject(result) || !safeText(result.accountId, MAX_ACCOUNT_ID_LENGTH) || !isObject(result.rateLimits)) return undefined;
  return result.accountId;
}

/** Reads bounded route/account metadata from a trusted isolated app-server child.
 * Explicit logged-out state is not an authorization or a generic transport failure. */
export function createObserverAccountReader(
  launch: () => ChildProcessWithoutNullStreams,
  timeoutMs = 15_000,
  onDiagnostic?: (value:AccountReadDiagnostic)=>void,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid observer account timeout');

  let disabled = false;
  let busy = false;
  let poisoned = false;
  let owned: ChildProcessWithoutNullStreams | undefined;
  let cancel: (() => void) | undefined;

  const terminate = (child: ChildProcessWithoutNullStreams): boolean => {
    try { return child.kill(); }
    catch { return false; }
  };

  const disable = (): void => {
    disabled = true;
    cancel?.();
    if (owned && !terminate(owned)) poisoned = true;
  };

  const ownership = (): Ownership => {
    if (owned === undefined) return 'idle';
    return poisoned ? 'termination_failed' : 'reading';
  };

  async function read(signal: AbortSignal): Promise<ObserverAccount> {
    if (disabled) throw new Error('OBSERVER_ACCOUNT_READER_DISABLED');
    if (poisoned) throw new Error('OBSERVER_ACCOUNT_READER_DISABLED');
    if (busy || signal.aborted) throw busy ? new Error('OBSERVER_ACCOUNT_READER_BUSY') : failure();
    busy = true;

    let child: ChildProcessWithoutNullStreams;
    try { child = launch(); }
    catch { busy = false; throw failure(); }
    owned = child;

    return await new Promise<ObserverAccount>((resolve, reject) => {
      const startedAt=performance.now();
      let diagnosticReason:AccountReadDiagnostic['reason']='read_failed';
      let buffer = '';
      let bytes = 0;
      let phase = 0;
      let done = false;
      let failed = false;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let firstAccount: {email: string | null; planType: string} | undefined;
      let firstAccountId: string | undefined;
      let firstRoute: string | undefined;
      let loginRequired = false;
      let result: ObserverAccount | undefined;

      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        signal.removeEventListener('abort', onAbort);
        if (cancel === onAbort) cancel = undefined;
      };

      const settle = (ok: boolean): void => {
        if (done) return;
        done = true;
        cleanup();
        busy = false;
        try{onDiagnostic?.({reason:ok&&result?'passed':ok&&loginRequired?'login_required':diagnosticReason,phase,elapsedMs:Math.round(performance.now()-startedAt)});}catch{/* Non-authoritative diagnostics. */}
        if (ok && result) resolve(result);
        else if (ok && loginRequired) reject(new Error('OBSERVER_LOGIN_REQUIRED'));
        else reject(diagnosticReason==='timeout' && owned===undefined && !poisoned && !signal.aborted && !disabled
          ?new ObserverAccountTimeout():failure());
      };

      const stop = (isFailure: boolean): void => {
        failed ||= isFailure;
        if (isFailure) {
          if (!terminate(child)) poisoned = true;
          if (terminationTimer) return;
        } else if (terminationTimer) {
          return;
        } else {
          try { child.stdin.end(); }
          catch { failed = true; if (!terminate(child)) poisoned = true; }
        }
        terminationTimer = setTimeout(() => {
          terminate(child);
          poisoned = true;
          settle(false);
        }, TERMINATION_GRACE_MS);
      };

      const onAbort = (): void => {diagnosticReason='cancelled';stop(true);};
      cancel = onAbort;

      const send = (method: string, id?: number, params?: unknown): void => {
        if (failed || done) return;
        const request: JsonObject = {method};
        if (id !== undefined) request.id = id;
        if (params !== undefined) request.params = params;
        try { child.stdin.write(`${JSON.stringify(request)}\n`); }
        catch { stop(true); }
      };

      const handle = (message: JsonObject): void => {
        if (message.method === 'account/updated') { stop(true); return; }
        if (message.id === undefined) return;
        if (message.error !== undefined) { diagnosticReason='rpc_error';stop(true); return; }

        if (phase === 0 && message.id === 1 && isObject(message.result)) {
          phase = 10;
          send('initialized');
          send('config/read', 10, {includeLayers: false});
        } else if (phase === 10 && message.id === 10 && isObject(message.result)) {
          try { firstRoute = observerRouteFingerprint(message.result.config); }
          catch { stop(true); return; }
          phase = 1;
          send('account/read', 2, {refreshToken: false});
        } else if (phase === 1 && message.id === 2) {
          if(isObject(message.result) && message.result.account===null && message.result.requiresOpenaiAuth===true) {
            loginRequired=true;phase=5;stop(false);return;
          }
          const account = readAccount(message.result);
          if (!account) { stop(true); return; }
          firstAccount = account;
          phase = 2;
          send('account/rateLimits/read', 3);
        } else if (phase === 2 && message.id === 3) {
          const accountId = readRateLimits(message.result);
          if (!accountId || !firstAccount) { stop(true); return; }
          firstAccountId = accountId;
          phase = 3;
          send('account/read', 4, {refreshToken: false});
        } else if (phase === 3 && message.id === 4) {
          const account = readAccount(message.result);
          if (!account || !firstAccount || account.email !== firstAccount.email || account.planType !== firstAccount.planType) {
            stop(true); return;
          }
          phase = 4;
          send('account/rateLimits/read', 5);
        } else if (phase === 4 && message.id === 5) {
          const accountId = readRateLimits(message.result);
          if (!accountId || accountId !== firstAccountId || !firstAccount || !firstRoute) { stop(true); return; }
          result = {accountId, email: firstAccount.email, planType: firstAccount.planType, routeFingerprint:firstRoute};
          phase = 6;
          send('config/read', 11, {includeLayers:false});
        } else if (phase === 6 && message.id === 11 && isObject(message.result)) {
          try { if(observerRouteFingerprint(message.result.config)!==firstRoute) throw failure(); }
          catch { stop(true); return; }
          phase = 5;
          stop(false);
        } else {
          stop(true);
        }
      };

      child.stdin.on('error', () => stop(true));
      child.stdout.on('error', () => stop(true));
      child.stderr.on('error', () => stop(true));
      child.once('error', () => stop(true));
      child.once('close', code => {
        if (owned === child) owned = undefined;
        busy = false;
        settle(code === 0 && phase === 5 && !failed && !signal.aborted && !disabled && buffer.trim() === '');
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failed || done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_STREAM_BYTES) { stop(true); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0 && !failed && !done) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: unknown;
          try { message = JSON.parse(line); }
          catch { stop(true); return; }
          if (!isObject(message)) { stop(true); return; }
          handle(message);
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (failed || done) return;
        bytes += Buffer.byteLength(chunk.toString());
        if (bytes > MAX_STREAM_BYTES) stop(true);
      });
      signal.addEventListener('abort', onAbort, {once: true});
      timeoutTimer = setTimeout(() => {if(!failed&&!done){diagnosticReason='timeout';stop(true);}}, timeoutMs);
      if (signal.aborted) onAbort();
      else send('initialize', 1, {clientInfo: {name: 'codex_progress_hud_observer_account', version: '0.2.1'}});
    });
  }

  return {read, disable, ownership};
}
