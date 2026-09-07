import {z} from 'zod';
import type {AccountedUsage} from './subscription-accounting.js';
import type {ReleaseAccountingSnapshot} from './release-accounting.js';

export const ACCOUNTING_PROTOCOL_VERSION = 1 as const;
export const MAX_ACCOUNTING_PENDING = 128;
export const ACCOUNTING_STARTUP_TIMEOUT_MS = 10_000;
export const ACCOUNTING_OPERATION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_TOKENS_PER_FIELD = 1_000_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const safeClock = z.number().int().nonnegative().safe();
const conversationKey = z.string().min(1).max(512);
const reservationId = z.string().uuid();
const usage = z.object({
  inputTokens: z.number().int().nonnegative().safe().max(MAX_TOKENS_PER_FIELD),
  outputTokens: z.number().int().nonnegative().safe().max(MAX_TOKENS_PER_FIELD),
  cachedInputTokens: z.number().int().nonnegative().safe().max(MAX_TOKENS_PER_FIELD).nullable(),
}).strict().refine(value => value.cachedInputTokens === null || value.cachedInputTokens <= value.inputTokens);

export const accountingSnapshotSchema = z.object({
  starts: z.number().int().nonnegative().safe().max(MAX_SAFE),
  activeStarts: z.number().int().nonnegative().safe().max(MAX_SAFE),
  inFlight: z.number().int().nonnegative().safe().max(MAX_SAFE),
  unresolved: z.number().int().nonnegative().safe().max(MAX_SAFE),
  knownTokens: z.number().int().nonnegative().safe().max(MAX_SAFE),
  unknown: z.number().int().nonnegative().safe().max(MAX_SAFE),
  poisoned: z.boolean(),
}).strict();

const requestBase = {
  kind: z.literal('request'),
  version: z.literal(ACCOUNTING_PROTOCOL_VERSION),
  requestId: reservationId,
} as const;

const reserveRequest = z.object({...requestBase, operation: z.literal('reserve'), conversationKey, clock: safeClock}).strict();
const settleRequest = z.object({...requestBase, operation: z.literal('settle'), conversationKey, clock: safeClock, reservationId, usage: usage.nullable()}).strict();
const cancelRequest=z.object({...requestBase,operation:z.literal('not_dispatched'),conversationKey,clock:safeClock,reservationId}).strict();
const shutdownRequest = z.object({...requestBase, operation: z.literal('shutdown')}).strict();
const requestSchema = z.discriminatedUnion('operation', [reserveRequest, settleRequest, cancelRequest,shutdownRequest]);

const errorCodes = [
  'RELEASE_INVALID_CLOCK',
  'RELEASE_CLOCK_REGRESSION',
  'RELEASE_CONVERSATION_KEY_INVALID',
  'RELEASE_USAGE_INVALID',
  'RELEASE_INVALID_SETTLEMENT',
  'RELEASE_COUNTER_OVERFLOW',
  'RELEASE_PERSIST_FAILED',
  'RELEASE_SCHEMA_INVALID',
  'RELEASE_LEGACY_STATE',
  'RELEASE_RUNTIME_UNSUPPORTED',
  'RELEASE_DATABASE_UNAVAILABLE',
  'RELEASE_CLOSE_FAILED',
  'RELEASE_OWNER_CLOSED',
  'RELEASE_VIEW_CLOSED',
  'RELEASE_WORKER_FAILED',
  'RELEASE_WORKER_EXITED',
  'RELEASE_WORKER_TIMEOUT',
  'RELEASE_PROTOCOL_INVALID',
] as const;
export type AccountingErrorCode = typeof errorCodes[number];
const errorCodeSchema = z.enum(errorCodes);

const responseSchema = z.object({
  kind: z.literal('response'),
  version: z.literal(ACCOUNTING_PROTOCOL_VERSION),
  requestId: reservationId,
  ok: z.boolean(),
  result: reservationId.nullable(),
  snapshot: accountingSnapshotSchema,
  error: errorCodeSchema.optional(),
}).strict().refine(value => value.ok ? value.error === undefined : value.error !== undefined);
const readySchema = z.object({kind: z.literal('ready'), version: z.literal(ACCOUNTING_PROTOCOL_VERSION), snapshot: accountingSnapshotSchema}).strict();
const startupErrorSchema = z.object({kind: z.literal('startup-error'), version: z.literal(ACCOUNTING_PROTOCOL_VERSION), error: errorCodeSchema}).strict();

export type AccountingRequest = z.infer<typeof requestSchema>;
export type AccountingResponse = z.infer<typeof responseSchema>;
export type AccountingReady = z.infer<typeof readySchema>;
export type AccountingStartupError = z.infer<typeof startupErrorSchema>;
export type AccountingWorkerMessage = AccountingResponse | AccountingReady | AccountingStartupError;

export function validateClock(value: unknown): number {
  const parsed = safeClock.safeParse(value);
  if (!parsed.success) throw new Error('RELEASE_INVALID_CLOCK');
  return parsed.data;
}

export function validateConversationKey(value: unknown): string {
  const parsed = conversationKey.safeParse(value);
  if (!parsed.success) throw new Error('RELEASE_CONVERSATION_KEY_INVALID');
  return parsed.data;
}

export function validateReservationId(value: unknown): string {
  const parsed = reservationId.safeParse(value);
  if (!parsed.success) throw new Error('RELEASE_USAGE_INVALID');
  return parsed.data;
}

export function cloneUsage(value: AccountedUsage | null): AccountedUsage | null {
  if (value === null) return null;
  const parsed = usage.safeParse({...value});
  if (!parsed.success) throw new Error('RELEASE_USAGE_INVALID');
  return {...parsed.data};
}

export function sanitizedError(error: unknown): AccountingErrorCode {
  const message = error instanceof Error ? error.message : '';
  return (errorCodes as readonly string[]).includes(message) ? message as AccountingErrorCode : 'RELEASE_DATABASE_UNAVAILABLE';
}

function bounded(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= MAX_MESSAGE_BYTES;
  } catch { return false; }
}

export function parseRequest(value: unknown): AccountingRequest | undefined {
  if (!bounded(value)) return undefined;
  const parsed = requestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseWorkerMessage(value: unknown): AccountingWorkerMessage | undefined {
  if (!bounded(value)) return undefined;
  const parsed = z.discriminatedUnion('kind', [responseSchema, readySchema, startupErrorSchema]).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function snapshotCopy(snapshot: ReleaseAccountingSnapshot): ReleaseAccountingSnapshot {
  const parsed = accountingSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error('RELEASE_PROTOCOL_INVALID');
  return {...parsed.data};
}
