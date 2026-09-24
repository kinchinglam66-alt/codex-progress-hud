import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ApiUsage} from './observer-api-accounting.js';
import type {SubscriptionUsage} from './codex-output.js';
import {packObserverInput} from './observer-input.js';
import {bindProgressReviewOutputSchema} from './progress-review-output-schema.js';

/** The planner-facing request. Conversation text is untrusted and is never
 * interpreted as observer instructions by this module. */
export interface CompressionRequest {
  text: string;
  firstOrdinal: number;
  lastOrdinal: number;
}

/** A validated, lossy representation of exactly one requested interval. */
export interface CompressionSummary {
  text: string;
  firstOrdinal: number;
  lastOrdinal: number;
}

export interface CompressionAdapter {
  summarize(request: CompressionRequest, signal: AbortSignal): Promise<CompressionSummary>;
}

export type CompressionUsage = SubscriptionUsage | ApiUsage;

export interface CompressionDispatchIdentity {
  conversationKey: string;
  turnGeneration: number;
  /** Optional source epoch; a controller should create a new binding per epoch. */
  sourceEpoch?: number;
}

export interface CompressionDispatchResult {
  summary: CompressionSummary;
  /** Usage is deliberately kept out of CompressionSummary. */
  usage: CompressionUsage | null;
}

export class CompressionDispatchError extends Error {
  readonly usage: CompressionUsage | null;
  constructor(message: string, usage: CompressionUsage | null = null) {
    super(message);
    this.name = 'CompressionDispatchError';
    this.usage = usage;
  }
}

export interface CompressionAdapterOptions extends CompressionDispatchIdentity {
  authorize: () => boolean;
  dispatch: (
    request: CompressionRequest,
    signal: AbortSignal,
    identity: CompressionDispatchIdentity,
  ) => Promise<CompressionDispatchResult>;
  /** Accounting/diagnostic seam. It receives null for unknown usage. */
  onSettled?: (usage: CompressionUsage | null) => void;
}

export interface TransportSerializationOptions {
  model: string;
  instructions: string;
  schema: unknown;
  maxOutputTokens: number;
  reasoningEffort?: 'low'|'medium'|'high'|undefined;
}

export interface SubscriptionTransportSerialization {
  stdin: string;
  instructions: string;
  schema: string;
  commandEnvelope: string;
  byteCounts: {
    stdin: number;
    instructions: number;
    schema: number;
    commandEnvelope: number;
    total: number;
  };
}

/** Keep JSON framing below the existing 16,384-character event-line bound.
 * This is an output bound, not a conversation input bound. */
export const COMPRESSION_OUTPUT_TEXT_LIMIT = 12_000;
export const MAX_COMPRESSION_IN_FLIGHT = 1;

/** Serialize the complete Responses request used by the ETA API path. The
 * returned string is suitable for capacity sizing, including instructions,
 * schema, model, output reserve and JSON envelope. */
export function serializeObserverTransport(input: unknown, options: TransportSerializationOptions): string {
  return JSON.stringify({model: options.model,
    ...(options.reasoningEffort === undefined ? {} : {reasoning: {effort: options.reasoningEffort}}),
    instructions: options.instructions, input: packObserverInput(input), store: false,
    max_output_tokens: options.maxOutputTokens,
    text: {format: {type: 'json_schema', name: 'observer_response', strict: true, schema: bindProgressReviewOutputSchema(options.schema,input)}}});
}

/** Serialize the complete Responses request used by compression. Passing this
 * exact function to the preparation planner accounts all static overhead. */
export function serializeCompressionTransport(request: CompressionRequest, options: TransportSerializationOptions): string {
  validateCompressionRequest(request);
  return JSON.stringify({model: options.model,
    ...(options.reasoningEffort === undefined ? {} : {reasoning: {effort: options.reasoningEffort}}),
    instructions: options.instructions, input: JSON.stringify(request), store: false,
    max_output_tokens: options.maxOutputTokens,
    text: {format: {type: 'json_schema', name: 'context_summary', strict: true, schema: options.schema}}});
}

/** Subscription CLI capacity is not the API HTTP body. The instruction and
 * schema files are model input, while the command envelope is trusted host
 * overhead and must never be derived from task text. Keep each component
 * visible so the planner can count it with its selected tokenizer/byte policy.
 */
export function serializeSubscriptionTransport(
  input: unknown,
  options: {instructions: string; schema: unknown; commandEnvelope: string; compression?: boolean},
): SubscriptionTransportSerialization {
  const stdin = options.compression ? JSON.stringify(validateCompressionRequest(input)) : packObserverInput(input);
  const instructions = options.instructions;
  const schema = JSON.stringify(options.schema);
  const commandEnvelope = options.commandEnvelope;
  if ([instructions, schema, commandEnvelope].some(value => typeof value !== 'string')) throw new Error('SUBSCRIPTION_SERIALIZATION_INVALID');
  const byteCounts = {
    stdin: Buffer.byteLength(stdin, 'utf8'),
    instructions: Buffer.byteLength(instructions, 'utf8'),
    schema: Buffer.byteLength(schema, 'utf8'),
    commandEnvelope: Buffer.byteLength(commandEnvelope, 'utf8'),
    total: Buffer.byteLength(stdin, 'utf8') + Buffer.byteLength(instructions, 'utf8') +
      Buffer.byteLength(schema, 'utf8') + Buffer.byteLength(commandEnvelope, 'utf8'),
  };
  return Object.freeze({stdin, instructions, schema, commandEnvelope, byteCounts: Object.freeze(byteCounts)});
}

const ordinal = z.number().int().nonnegative().safe();
const requestSchema = z.object({
  text: z.string().min(1),
  firstOrdinal: ordinal,
  lastOrdinal: ordinal,
}).strict().refine(value => value.lastOrdinal >= value.firstOrdinal);
const summarySchema = z.object({
  text: z.string().trim().min(1).max(COMPRESSION_OUTPUT_TEXT_LIMIT),
  firstOrdinal: ordinal,
  lastOrdinal: ordinal,
}).strict();

function requestCopy(value: CompressionRequest): CompressionRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new Error('COMPRESSION_REQUEST_INVALID');
  return {...parsed.data};
}

export function validateCompressionRequest(value: unknown): CompressionRequest {
  return requestCopy(value as CompressionRequest);
}

export function validateCompressionSummary(
  value: unknown,
  request: CompressionRequest,
): CompressionSummary {
  const parsedRequest = requestSchema.safeParse(request);
  const parsed = summarySchema.safeParse(value);
  if (!parsedRequest.success || !parsed.success ||
      parsed.data.firstOrdinal !== parsedRequest.data.firstOrdinal ||
      parsed.data.lastOrdinal !== parsedRequest.data.lastOrdinal) {
    throw new Error('COMPRESSION_COVERAGE_INVALID');
  }
  return Object.freeze({...parsed.data});
}

function authorized(authorize: () => boolean): boolean {
  try { return authorize() === true; }
  catch { return false; }
}

function cacheKey(request: CompressionRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

/**
 * Bind a provider dispatch to the verified conversation and current turn.
 * Provider-specific dispatchers own admission, process/API transport, and
 * durable settlement; this adapter only fences identity, validates the
 * untrusted answer, and provides exact-prefix single-flight/cache behavior.
 */
export function createCompressionAdapter(options: CompressionAdapterOptions): CompressionAdapter {
  if (typeof options.conversationKey !== 'string' || options.conversationKey.length < 1 || options.conversationKey.length > 512 ||
      !Number.isSafeInteger(options.turnGeneration) || options.turnGeneration < 0 ||
      (options.sourceEpoch !== undefined && (!Number.isSafeInteger(options.sourceEpoch) || options.sourceEpoch < 0)) ||
      typeof options.dispatch !== 'function') {
    throw new Error('COMPRESSION_BINDING_INVALID');
  }
  const identity = Object.freeze({conversationKey: options.conversationKey, turnGeneration: options.turnGeneration,
    ...(options.sourceEpoch === undefined ? {} : {sourceEpoch: options.sourceEpoch})});
  const inFlight = new Map<string, Promise<CompressionSummary>>();

  return {
    summarize(input: CompressionRequest, signal: AbortSignal): Promise<CompressionSummary> {
      let request: CompressionRequest;
      try { request = requestCopy(input); }
      catch { return Promise.reject(new Error('COMPRESSION_REQUEST_INVALID')); }
      if (signal.aborted) return Promise.reject(new Error('COMPRESSION_ABORTED'));
      if (!authorized(options.authorize)) return Promise.reject(new Error('COMPRESSION_UNAUTHORIZED'));

      const key = `${options.sourceEpoch ?? 'no-epoch'}:${cacheKey(request)}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing.then(value => ({...value}));
      if (inFlight.size >= MAX_COMPRESSION_IN_FLIGHT) return Promise.reject(new Error('COMPRESSION_BUSY'));

      const operation = Promise.resolve().then(async () => {
        if (signal.aborted) throw new Error('COMPRESSION_ABORTED');
        if (!authorized(options.authorize)) throw new Error('COMPRESSION_UNAUTHORIZED');
        let result: CompressionDispatchResult;
        try { result = await options.dispatch(request, signal, identity); }
        catch (error) {
          if (error instanceof CompressionDispatchError) {
            try { options.onSettled?.(error.usage); } catch { /* Metadata only. */ }
          }
          throw error;
        }
        // Report accounting before structural validation so malformed answers
        // cannot erase valid usage evidence.
        try { options.onSettled?.(result.usage ?? null); } catch { /* Metadata only. */ }
        const validated = validateCompressionSummary(result.summary, request);
        return validated;
      });
      inFlight.set(key, operation);
      operation.finally(() => {
        if (inFlight.get(key) === operation) inFlight.delete(key);
      }).catch(() => undefined);
      return operation.then(value => ({...value}));
    },
  };
}
