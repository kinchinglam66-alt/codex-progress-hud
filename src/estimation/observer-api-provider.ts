import type {ApiConfig} from '../desktop/observer-provider-config.js';
import type {ApiAccounting, ApiLimits, ApiProviderBinding, ApiReservation, ApiUsage} from './observer-api-accounting.js';
import type {ObserverInput, ObserverResponse} from './observer-contract.js';
import {observerInputSchema, observerResponseSchema} from './observer-contract.js';
import type {ApiTransport} from '../desktop/observer-api-transport.js';
import type {ObserverResult} from './observer-provider.js';
import {reportObserverStage, type ObserverCallStage} from './observer-provider.js';
import type {ObserverWorker} from './observer-scheduler.js';
import {randomUUID,createHash} from 'node:crypto';
import {createCompressionAdapter, CompressionDispatchError, serializeCompressionTransport, serializeObserverTransport, validateCompressionSummary, type CompressionAdapter, type CompressionDispatchIdentity, type CompressionDispatchResult, type CompressionRequest} from './context-compression.js';
import type {AccountingPurpose} from './subscription-accounting.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOKEN_COUNT = 1_000_000_000;

export interface ObserverApiProviderOptions {
  config: ApiConfig;
  generation: number;
  readKey: () => Promise<string | null>;
  transport: ApiTransport;
  accounting: Pick<ApiAccounting, 'reserve' | 'markDispatch' | 'settle' | 'cancelBeforeDispatch'> &
    Partial<Pick<ApiAccounting, 'bindInvocation' | 'updateInvocation'>>;
  instructions: string;
  schema: unknown;
  /** Optional controller-supplied Task 4 limits; defaults are conservative. */
  limits?: ApiLimits;
  /** One separately admitted retry uses the same packed snapshot. */
  maxAutoRetries?: 0 | 1;
  /** Bounded retry delay policy. */
  maxRetryDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Explicit fixture convenience; false disables the default single retry. */
  retry?: boolean;
}

type FailureCode = NonNullable<NonNullable<ObserverResult['outcomes']>['failureCode']>;
type ParsedResponse = {
  interpretation: ObserverResponse | null;
  usage: ApiUsage | null;
  prediction: 'numeric' | 'unknown' | 'invalid';
  framingValid: boolean;
  failureCode?: FailureCode;
  retryAfterMs?: number;
  retryAfterExceeded?: boolean;
};

function result(status: ObserverResult['status'], failureCode?: FailureCode): ObserverResult {
  return {status, interpretation: null, usage: null,
    ...(failureCode ? {outcomes: {
      prediction: 'invalid', call: status === 'aborted' ? 'cancelled' : 'failed', usage: 'unknown',
      framingValid: false, closureConfirmed: false, dispatch: 'not_started', failureCode,
    }} : {})};
}

function configurationBlocked(code: 'unauthorized' | 'forbidden'): ObserverResult {
  return {status: 'disabled', interpretation: null, usage: null, outcomes: {
    prediction: 'invalid', call: 'failed', usage: 'not_dispatched', framingValid: false,
    closureConfirmed: true, dispatch: 'not_started', failureCode: code,
  }};
}

function responsesUrl(baseUrl: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('responses', root).toString();
}

function retryAfter(headers: Headers, now: () => number, maxDelayMs: number): {delayMs?: number; exceeded: boolean} {
  const value = headers.get('retry-after');
  if (value === null) return {exceeded: false};
  let delayMs: number | undefined;
  if (/^\d+$/u.test(value.trim())) {
    const seconds = Number(value.trim());
    if (Number.isSafeInteger(seconds)) delayMs = seconds * 1000;
  } else {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) delayMs = Math.max(0, timestamp - now());
  }
  if (delayMs === undefined) return {exceeded: false};
  return delayMs > maxDelayMs ? {exceeded: true} : {delayMs, exceeded: false};
}

function parseUsage(value: unknown): ApiUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const details = record.input_tokens_details;
  if (typeof details !== 'object' || details === null) return null;
  const cached = (details as Record<string, unknown>).cached_tokens;
  const values = [record.input_tokens, record.output_tokens, cached];
  if (!values.every(token => typeof token === 'number' && Number.isSafeInteger(token) &&
    token >= 0 && token <= MAX_TOKEN_COUNT)) return null;
  if (Number(cached) > Number(record.input_tokens)) return null;
  return {kind: 'api-tokens', inputTokens: Number(record.input_tokens),
    outputTokens: Number(record.output_tokens), cachedInputTokens: Number(cached)};
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error('body_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {complete = true; break;}
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
      chunks.push(part.value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {output.set(chunk, offset); offset += chunk.byteLength;}
    return output;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseResponse(value: unknown, status: number, retryPolicy: {delayMs?: number; exceeded: boolean} = {exceeded: false}): ParsedResponse {
  if (status < 200 || status >= 300) {
    const failureCode = statusFailureCode(status);
    return {interpretation: null, usage: null, prediction: 'invalid', framingValid: false, failureCode,
      ...(retryPolicy.delayMs === undefined ? {} : {retryAfterMs: retryPolicy.delayMs}),
      ...(retryPolicy.exceeded ? {retryAfterExceeded: true} : {})};
  }
  if (typeof value !== 'object' || value === null) return {interpretation: null, usage: null, prediction: 'invalid', framingValid: false, failureCode: 'invalid_response'};
  const record = value as Record<string, unknown>;
  const usage = parseUsage(record.usage);
  if (record.status !== 'completed') {
    return {interpretation: null, usage, prediction: 'invalid', framingValid: false,
      failureCode: usage === null ? 'missing_usage' : 'invalid_output'};
  }
  if (!Array.isArray(record.output)) {
    return {interpretation: null, usage, prediction: 'invalid', framingValid: false,
      failureCode: usage === null ? 'missing_usage' : 'invalid_output'};
  }
  const output = record.output as unknown[];
  const messages = output.filter(item => typeof item === 'object' && item !== null &&
    (item as Record<string, unknown>).type === 'message');
  if (messages.length !== 1 || output.some(item => typeof item !== 'object' || item === null ||
    !['reasoning', 'message'].includes(String((item as Record<string, unknown>).type)))) {
    return {interpretation: null, usage, prediction: 'invalid', framingValid: false,
      failureCode: usage === null ? 'missing_usage' : 'invalid_output'};
  }
  const message = messages[0] as Record<string, unknown>;
  if (message.role !== 'assistant') {
    return {interpretation: null, usage, prediction: 'invalid', framingValid: false,
      failureCode: usage === null ? 'missing_usage' : 'invalid_output'};
  }
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1 || typeof content[0] !== 'object' || content[0] === null ||
    (content[0] as Record<string, unknown>).type !== 'output_text' ||
    typeof (content[0] as Record<string, unknown>).text !== 'string') {
    return {interpretation: null, usage, prediction: 'invalid', framingValid: false,
      failureCode: usage === null ? 'missing_usage' : 'invalid_output'};
  }
  let decoded: unknown;
  try {decoded = JSON.parse((content[0] as Record<string, unknown>).text as string);}
  catch {return {interpretation: null, usage, prediction: 'invalid', framingValid: true, failureCode: 'invalid_output'};}
  const parsed = observerResponseSchema.safeParse(decoded);
  if (!parsed.success) return {interpretation: null, usage, prediction: 'invalid', framingValid: true, failureCode: 'invalid_output'};
  return {interpretation: Object.freeze(parsed.data), usage,
    prediction: parsed.data.estimate === null ? 'unknown' : 'numeric', framingValid: true,
    ...(usage === null ? {failureCode: 'missing_usage' as const} : {})};
}

function statusFailureCode(status: number): FailureCode {
  return status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' :
    status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' :
    status >= 300 && status < 400 ? 'redirect' : 'invalid_response';
}

function retryable(code: FailureCode | undefined): boolean {
  return code === 'rate_limited' || code === 'server_error' || code === 'network_error' || code === 'timeout';
}

/** API-owned request/parser lifecycle. Durable reservation ownership remains in Task 4. */
export function createObserverApiProvider(options: ObserverApiProviderOptions): ObserverWorker {
  const ownerUuid = randomUUID();
  const binding: ApiProviderBinding = {kind: 'api', profileId: options.config.profileId, generation: options.generation};
  const limits: ApiLimits = options.limits ?? {
    dailyCallLimit: options.config.dailyCallLimit,
    maxInputTokens: MAX_TOKEN_COUNT,
    maxOutputTokens: options.config.maxOutputTokens,
  };
  const maxRetries = options.retry === false ? 0 : (options.maxAutoRetries ?? 1);
  const maxRetryDelayMs = Number.isFinite(options.maxRetryDelayMs) && (options.maxRetryDelayMs ?? 0) >= 0
    ? options.maxRetryDelayMs as number : 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {reject(new Error('sleep_aborted')); return;}
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => {clearTimeout(timer); reject(new Error('sleep_aborted'));}, {once: true});
  }));
  let active = false;
  let disabled = false;
  let configurationFailure: 'unauthorized' | 'forbidden' | undefined;
  let pending: Promise<ObserverResult> | undefined;
  let closing: Promise<void> | undefined;
  let abortController: AbortController | undefined;

  const disable = () => {disabled = true; abortController?.abort();};

  async function attempt(body: string, key: string, signal: AbortSignal, conversationKey: string, turnGeneration: number,onStage?: (stage:ObserverCallStage)=>void): Promise<{value: ObserverResult; retry: boolean; retryDelayMs: number}> {
    const accountScope=createHash('sha256').update(JSON.stringify([options.config.baseUrl,key])).digest('hex');
    const ownership={conversationKey,turnGeneration,ownerUuid,accountScope,providerKind:'api' as const,phase:'prepared' as const,deadline:now()+REQUEST_TIMEOUT_MS,cleanupOutcome:'pending' as const};
    reportObserverStage(onStage,'reservation');
    const reservation: ApiReservation | null = await options.accounting.reserve(binding, limits, ownership);
    if (reservation === null) return {value: result('admission_denied'), retry: false, retryDelayMs: 0};
    let dispatched = false;
    let settled = false;
    let ownershipBound = reservation.ownershipBound===true;
    let cleanupWritten = false;
    const closeLocal = async () => {
      reportObserverStage(onStage,'cleanup');
      if (ownershipBound && !cleanupWritten) {
        // Only the local HTTP request has ended; provider-side cancellation is unknown.
        await options.accounting.updateInvocation!(reservation.id, {phase: 'closed', cleanupOutcome: 'confirmed'});
        cleanupWritten = true;
      }
    };
    let usage: ApiUsage | null = null;
    let failureCode: FailureCode | undefined;
    let retryPolicy: {delayMs?: number; exceeded: boolean} = {exceeded: false};
    try {
      if (!ownershipBound && options.accounting.bindInvocation && options.accounting.updateInvocation) {
        await options.accounting.bindInvocation(reservation.id, {
          admissionId: reservation.id,...ownership,
        });
        ownershipBound = true;
      }
      if (signal.aborted) {
        await closeLocal();
        await options.accounting.cancelBeforeDispatch(reservation.id);
        return {value: {status: 'aborted', interpretation: null, usage: null, outcomes: {
          prediction: 'invalid', call: 'cancelled', usage: 'not_dispatched', framingValid: false,
          closureConfirmed: true, dispatch: 'not_started', accounting: 'pre_dispatch_cancelled', failureCode: 'cancelled',
        }}, retry: false, retryDelayMs: 0};
      }
      await options.accounting.markDispatch(reservation.id);
      dispatched = true;
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = AbortSignal.any([signal, timeout]);
      let response: Response;
      reportObserverStage(onStage,'dispatch');
      try {
        response = await options.transport(responsesUrl(options.config.baseUrl), {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body,
        });
      } catch {
        failureCode = signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network_error';
        throw new Error('transport_failed');
      }
      let raw: Uint8Array;
      try {raw = await readBounded(response);}
      catch (error) {
        failureCode = error instanceof Error && error.message === 'response_too_large' ? 'response_too_large' : 'invalid_response';
        throw new Error('response_body_failed');
      }
      reportObserverStage(onStage,'provider_returned');
      retryPolicy = retryAfter(response.headers, now, maxRetryDelayMs);
      let decoded: unknown;
      try {const text = new TextDecoder('utf-8', {fatal: true}).decode(raw); decoded = JSON.parse(text);}
      catch {failureCode = response.status < 200 || response.status >= 300 ? statusFailureCode(response.status) : 'invalid_response'; throw new Error('response_json_failed');}
      const parsed = parseResponse(decoded, response.status, retryPolicy);
      usage = parsed.usage; failureCode = parsed.failureCode;
      await closeLocal();
      reportObserverStage(onStage,'settlement');
      await options.accounting.settle(reservation.id, usage); settled = true;
      if (failureCode === 'unauthorized' || failureCode === 'forbidden') configurationFailure = failureCode;
      const outcomes = {
        prediction: parsed.prediction, call: 'success' as const, usage: usage ? 'known' as const : 'unknown' as const,
        framingValid: parsed.framingValid, closureConfirmed: true, dispatch: 'started' as const,
        accounting: 'durably_settled' as const, ...(failureCode ? {failureCode} : {}),
      };
      if (signal.aborted || disabled) return {value: {status: 'aborted', interpretation: null, usage,
        outcomes: {...outcomes, call: 'cancelled', failureCode: 'cancelled'}}, retry: false, retryDelayMs: 0};
      return {value: parsed.interpretation === null
        ? {status: 'process_error', interpretation: null, usage, outcomes}
        : {status: 'interpreted', interpretation: parsed.interpretation, usage, outcomes},
      retry: retryable(failureCode) && !parsed.retryAfterExceeded,
      retryDelayMs: parsed.retryAfterMs ?? 1_000};
    } catch {
      if (!dispatched) {
        // No transport was called; release only this reservation and retain its start.
        await closeLocal();
        await options.accounting.cancelBeforeDispatch(reservation.id);
        throw new Error('accounting_error');
      }
      if (!settled) {
        try {await closeLocal(); reportObserverStage(onStage,'settlement'); await options.accounting.settle(reservation.id, usage); settled = true;}
        catch {return {value: result('accounting_error', 'accounting_error'), retry: false, retryDelayMs: 0};}
      }
      const code = failureCode ?? 'network_error';
      if (code === 'unauthorized' || code === 'forbidden') configurationFailure = code;
      return {value: {status: code === 'cancelled' ? 'aborted' : 'process_error', interpretation: null, usage,
        outcomes: {prediction: 'invalid', call: code === 'timeout' ? 'timeout' : code === 'cancelled' ? 'cancelled' : 'failed',
          usage: usage ? 'known' : 'unknown', framingValid: false, closureConfirmed: true, dispatch: 'unknown',
          accounting: 'durably_settled', failureCode: code}}, retry: retryable(code) && !retryPolicy.exceeded,
        retryDelayMs: retryPolicy.delayMs ?? 1_000};
    }
  }

  async function observeImpl(input: ObserverInput, signal: AbortSignal, conversationKey: string, turnGeneration: number,onStage?: (stage:ObserverCallStage)=>void): Promise<ObserverResult> {
    reportObserverStage(onStage,'preparation');
    if (configurationFailure) return configurationBlocked(configurationFailure);
    if (disabled) return result('disabled');
    if (signal.aborted) return result('aborted', 'cancelled');
    let body: string;
    try {
      if (!observerInputSchema.safeParse(input).success) return result('invalid_input');
      body = serializeObserverTransport(input, {
        model: options.config.model, instructions: options.instructions, schema: options.schema,
        maxOutputTokens: options.config.maxOutputTokens, reasoningEffort: options.config.reasoningEffort,
      });
    } catch {return result('invalid_input');}
    const key = await options.readKey().catch(() => null);
    if (!key) return result('process_error', 'credential_unavailable');
    let current: {value: ObserverResult; retry: boolean; retryDelayMs: number} = {value: result('process_error'), retry: false, retryDelayMs: 0};
    for (let index = 0; index <= maxRetries; index++) {
      if (index > 0) {
        try {await sleep(current.retryDelayMs, signal);}
        catch {return current.value;}
      }
      const previous=current;
      try {current = await attempt(body, key, signal, conversationKey, turnGeneration,onStage);}
      catch {return result('accounting_error', 'accounting_error');}
      if(index>0&&current.value.status==='admission_denied')return previous.value;
      if (!current.retry || index === maxRetries) return current.value;
    }
    return current.value;
  }

  return {
    observe(input, signal, conversationKey, turnGeneration=options.generation,onStage) {
      if (disabled) return Promise.resolve(result('disabled'));
      if (active) return Promise.resolve(result('busy'));
      active = true; abortController = new AbortController();
      pending = observeImpl(input, AbortSignal.any([signal, abortController.signal]), conversationKey, turnGeneration,onStage)
        .finally(() => {active = false; abortController = undefined;reportObserverStage(onStage,'finished');});
      return pending;
    },
    status: () => ({active, disabled, poisoned: false}),
    disable,
    close() {
      if (closing) return closing;
      disable(); closing = (pending ?? Promise.resolve()).then(() => undefined);
      return closing;
    },
  };
}

export interface ObserverApiCompressionAdapterOptions extends Omit<ObserverApiProviderOptions, 'maxAutoRetries'|'maxRetryDelayMs'|'retry'>, CompressionDispatchIdentity {
  authorize: () => boolean;
}

interface ParsedCompressionResponse {
  summary: CompressionRequest|{text: string; firstOrdinal: number; lastOrdinal: number}|null;
  usage: ApiUsage|null;
  failureCode?: FailureCode;
}

function parseCompressionResponse(value: unknown, status: number): ParsedCompressionResponse {
  if (status < 200 || status >= 300) return {summary: null, usage: null, failureCode: statusFailureCode(status)};
  if (typeof value !== 'object' || value === null) return {summary: null, usage: null, failureCode: 'invalid_response'};
  const record = value as Record<string, unknown>;
  const usage = parseUsage(record.usage);
  const invalid = (failureCode: FailureCode = usage === null ? 'missing_usage' : 'invalid_output'): ParsedCompressionResponse => ({summary: null, usage, failureCode});
  if (record.status !== 'completed' || !Array.isArray(record.output)) return invalid();
  const output = record.output as unknown[];
  if (output.some(item => typeof item !== 'object' || item === null || !['reasoning', 'message'].includes(String((item as Record<string, unknown>).type)))) return invalid('invalid_output');
  const messages = output.filter(item => (item as Record<string, unknown>).type === 'message');
  if (messages.length !== 1) return invalid();
  const message = messages[0] as Record<string, unknown>;
  if (message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length !== 1 ||
      typeof message.content[0] !== 'object' || message.content[0] === null ||
      (message.content[0] as Record<string, unknown>).type !== 'output_text' ||
      typeof (message.content[0] as Record<string, unknown>).text !== 'string') return invalid();
  let decoded: unknown;
  try { decoded = JSON.parse((message.content[0] as Record<string, unknown>).text as string); }
  catch { return invalid('invalid_output'); }
  const parsed = typeof decoded === 'object' && decoded !== null ? decoded as Record<string, unknown> : null;
  const firstOrdinal = parsed?.firstOrdinal, lastOrdinal = parsed?.lastOrdinal;
  if (parsed === null || typeof parsed.text !== 'string' || typeof firstOrdinal !== 'number' || !Number.isSafeInteger(firstOrdinal) ||
      firstOrdinal < 0 || typeof lastOrdinal !== 'number' || !Number.isSafeInteger(lastOrdinal) || lastOrdinal < firstOrdinal) return invalid();
  return {summary: {text: parsed.text, firstOrdinal, lastOrdinal}, usage,
    ...(usage === null ? {failureCode: 'missing_usage' as const} : {})};
}

/** API counterpart to the subscription compression session. The same
 * Responses transport and accounting owner are used, but the response schema
 * is summary-only and cannot be selected by task text. */
export function createObserverApiCompressionAdapter(options: ObserverApiCompressionAdapterOptions): CompressionAdapter {
  const binding: ApiProviderBinding = {kind: 'api', profileId: options.config.profileId, generation: options.generation};
  const limits: ApiLimits = options.limits ?? {
    dailyCallLimit: options.config.dailyCallLimit, maxInputTokens: MAX_TOKEN_COUNT,
    maxOutputTokens: options.config.maxOutputTokens,
  };
  const ownerUuid = randomUUID();
  const now = options.now ?? Date.now;
  const dispatch = async (request: CompressionRequest, signal: AbortSignal, identity: CompressionDispatchIdentity): Promise<CompressionDispatchResult> => {
    if (signal.aborted) throw new CompressionDispatchError('COMPRESSION_ABORTED');
    try { if (options.authorize() !== true) throw new CompressionDispatchError('COMPRESSION_UNAUTHORIZED'); } catch (error) {
      if (error instanceof CompressionDispatchError) throw error;
      throw new CompressionDispatchError('COMPRESSION_UNAUTHORIZED');
    }
    const key = await options.readKey().catch(() => null);
    if (!key) throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED');
    const body = serializeCompressionTransport(request, {
      model: options.config.model, instructions: options.instructions, schema: options.schema,
      maxOutputTokens: options.config.maxOutputTokens, reasoningEffort: options.config.reasoningEffort,
    });
    const accountScope = createHash('sha256').update(JSON.stringify([options.config.baseUrl, key])).digest('hex');
    const ownership = {conversationKey: identity.conversationKey, turnGeneration: identity.turnGeneration, ownerUuid,
      accountScope, providerKind: 'api' as const, phase: 'prepared' as const, deadline: now() + REQUEST_TIMEOUT_MS,
      cleanupOutcome: 'pending' as const, purpose: 'context_compression' as const};
    let reservation: ApiReservation|null;
    try { reservation = await options.accounting.reserve(binding, limits, ownership, 'context_compression' satisfies AccountingPurpose); }
    catch { throw new CompressionDispatchError('COMPRESSION_ACCOUNTING_FAILED'); }
    if (reservation === null) throw new CompressionDispatchError('COMPRESSION_ADMISSION_DENIED');
    let dispatched = false, settled = false, bound = reservation.ownershipBound === true;
    let usage: ApiUsage|null = null;
    const closeLocal = async () => {
      if (bound && options.accounting.updateInvocation) {
        await options.accounting.updateInvocation(reservation.id, {phase: 'closed', cleanupOutcome: 'confirmed'});
        bound = false;
      }
    };
    try {
      if (!bound && options.accounting.bindInvocation && options.accounting.updateInvocation) {
        await options.accounting.bindInvocation(reservation.id, {admissionId: reservation.id, ...ownership});
        bound = true;
      }
      if (signal.aborted) {
        await closeLocal(); await options.accounting.cancelBeforeDispatch(reservation.id);
        throw new CompressionDispatchError('COMPRESSION_ABORTED');
      }
      await options.accounting.markDispatch(reservation.id); dispatched = true;
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = AbortSignal.any([signal, timeout]);
      let response: Response;
      try { response = await options.transport(responsesUrl(options.config.baseUrl), {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body,
      }); } catch { throw new CompressionDispatchError(signal.aborted ? 'COMPRESSION_ABORTED' : 'COMPRESSION_PROVIDER_FAILED'); }
      let raw: Uint8Array;
      try { raw = await readBounded(response); } catch { throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED'); }
      let decoded: unknown;
      try { decoded = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)); }
      catch { throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED'); }
      const parsed = parseCompressionResponse(decoded, response.status); usage = parsed.usage;
      await closeLocal();
      await options.accounting.settle(reservation.id, usage); settled = true;
      if (parsed.summary === null) throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED', usage);
      const summary = validateCompressionSummary(parsed.summary, request);
      return {summary, usage};
    } catch (error) {
      if (!dispatched) {
        await closeLocal().catch(() => undefined);
        await options.accounting.cancelBeforeDispatch(reservation.id).catch(() => undefined);
        if (error instanceof CompressionDispatchError) throw error;
        throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED');
      }
      if (!settled) { await closeLocal().catch(() => undefined); await options.accounting.settle(reservation.id, usage).catch(() => undefined); settled = true; }
      if (error instanceof CompressionDispatchError) throw new CompressionDispatchError(error.message, usage);
      throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED', usage);
    }
  };
  return createCompressionAdapter({
    conversationKey: options.conversationKey, turnGeneration: options.turnGeneration,
    ...(options.sourceEpoch === undefined ? {} : {sourceEpoch: options.sourceEpoch}),
    authorize: options.authorize, dispatch,
  });
}
