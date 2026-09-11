import {z} from 'zod';
import type {AccountedUsage, AdmissionKind, SettlementClassification} from './subscription-accounting.js';
import type {ReleaseAccountingSnapshot, ReleaseRecoveryAdmission, ReleaseRecoveryConfirmation, ReleaseRecoveryPreflight, ReleaseRecoveryStatus} from './release-accounting.js';
import {recoveryBootBoundaryProofSchema} from './recovery-boot-boundary.js';
import {invocationRecordSchema} from './invocation-ownership.js';

export const ACCOUNTING_PROTOCOL_VERSION = 1 as const;
export const MAX_ACCOUNTING_PENDING = 128;
export const ACCOUNTING_STARTUP_TIMEOUT_MS = 10_000;
export const ACCOUNTING_OPERATION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_TOKENS_PER_FIELD = 1_000_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const safeClock = z.number().int().nonnegative().safe();
const conversationKey = z.string().min(1).max(512);
const recoveryBinding = z.string().min(1).max(512);
const recoveryAttemptId = z.string().uuid();
const reservationId = z.string().uuid();
const usage = z.object({
  inputTokens: z.number().int().nonnegative().safe().max(MAX_TOKENS_PER_FIELD),
  outputTokens: z.number().int().nonnegative().safe().max(MAX_TOKENS_PER_FIELD),
  cachedInputTokens: z.number().int().nonnegative().safe().max(MAX_TOKENS_PER_FIELD).nullable(),
}).strict().refine(value => value.cachedInputTokens === null || value.cachedInputTokens <= value.inputTokens);
const admissionKind = z.enum(['ordinary', 'retry', 'half_open']);
const settlementClassification = z.enum(['known_success', 'known_non_success', 'safe_unknown', 'unsafe_unknown']);

export const accountingSnapshotSchema = z.object({
  starts: z.number().int().nonnegative().safe().max(MAX_SAFE),
  activeStarts: z.number().int().nonnegative().safe().max(MAX_SAFE),
  inFlight: z.number().int().nonnegative().safe().max(MAX_SAFE),
  unresolved: z.number().int().nonnegative().safe().max(MAX_SAFE),
  knownTokens: z.number().int().nonnegative().safe().max(MAX_SAFE),
  unknown: z.number().int().nonnegative().safe().max(MAX_SAFE),
  poisoned: z.boolean(),
}).strict();
export const recoveryStatusSchema = z.object({
  state: z.enum(['normal', 'warning', 'cooldown', 'blocked', 'awaiting_confirmation', 'probing', 'recovered', 'failed']),
  revision: z.number().int().nonnegative().safe().max(MAX_SAFE),
  knownTokens: z.number().int().nonnegative().safe().max(MAX_SAFE),
  unknown: z.number().int().nonnegative().safe().max(MAX_SAFE),
  recoveryAllowed: z.boolean(),
  reason: z.enum(['unresolved_previous_call', 'unsafe_unknown']).optional(),
  nextEligibleAt: safeClock.nullable().optional(),
  cooldownUntil: safeClock.nullable().optional(),
}).strict();
export const recoveryPreflightSchema = recoveryStatusSchema.extend({allowed: z.boolean()}).strict();
export const recoveryAdmissionSchema = z.object({allowed: z.boolean(), kind: z.enum(['ordinary', 'retry', 'half_open']), nextEligibleAt: safeClock.nullable(), reason: z.enum(['unresolved_previous_call', 'cooldown', 'retry_backoff', 'no_eligible_task', 'half_open_busy', 'unsafe_unknown']).optional()}).strict();
export const automaticReconcileSchema = z.object({released: z.number().int().nonnegative().safe().max(MAX_SAFE), nextCheckAt: safeClock.nullable()}).strict();
export const recoveryConfirmationSchema = z.object({attemptId: recoveryAttemptId, revision: z.number().int().nonnegative().safe().max(MAX_SAFE), binding: recoveryBinding}).strict();

const requestBase = {
  kind: z.literal('request'),
  version: z.literal(ACCOUNTING_PROTOCOL_VERSION),
  requestId: reservationId,
} as const;

const reserveRequest = z.object({...requestBase, operation: z.literal('reserve'), conversationKey, clock: safeClock, admissionKind: admissionKind.optional()}).strict();
const settleRequest = z.object({...requestBase, operation: z.literal('settle'), conversationKey, clock: safeClock, reservationId, usage: usage.nullable(), settlement: settlementClassification.optional()}).strict();
const cancelRequest=z.object({...requestBase,operation:z.literal('not_dispatched'),conversationKey,clock:safeClock,reservationId}).strict();
const shutdownRequest = z.object({...requestBase, operation: z.literal('shutdown')}).strict();
const recoveryStatusRequest = z.object({...requestBase, operation: z.literal('recovery_status'), clock: safeClock}).strict();
const recoveryPreflightRequest = z.object({...requestBase, operation: z.literal('recovery_preflight'), clock: safeClock, binding: recoveryBinding}).strict();
const recoveryConfirmRequest = z.object({...requestBase, operation: z.literal('recovery_confirm'), clock: safeClock, revision: safeClock, binding: recoveryBinding}).strict();
const recoveryTrialReserveRequest = z.object({...requestBase, operation: z.literal('recovery_trial_reserve'), clock: safeClock, attemptId: recoveryAttemptId, revision: safeClock, binding: recoveryBinding}).strict();
const recoveryTrialSettleRequest = z.object({...requestBase, operation: z.literal('recovery_trial_settle'), clock: safeClock, attemptId: recoveryAttemptId, reservationId, usage: usage.nullable()}).strict();
const recoveryFinishRequest = z.object({...requestBase, operation: z.literal('recovery_finish'), clock: safeClock, attemptId: recoveryAttemptId, success: z.boolean(), closureConfirmed: z.boolean()}).strict();
const recoveryCancelRequest = z.object({...requestBase, operation: z.literal('recovery_cancel_trial'), clock: safeClock, attemptId: recoveryAttemptId, reservationId}).strict();
const recoveryAbortRequest = z.object({...requestBase, operation: z.literal('recovery_cancel'), clock: safeClock, attemptId: recoveryAttemptId}).strict();
const recoveryAdmissionRequest = z.object({...requestBase, operation: z.literal('recovery_admission'), clock: safeClock, eligibleTask: z.boolean(), conversationKey}).strict();
const recoveryAdmissionReleaseRequest = z.object({...requestBase, operation: z.literal('recovery_admission_release'), clock: safeClock, conversationKey}).strict();
const recoveryEventRequest = z.object({...requestBase, operation: z.literal('recovery_event'), clock: safeClock, eventKind: z.enum(['recoverable_failure', 'unknown_usage', 'known_success', 'half_open_reserved', 'half_open_failure', 'half_open_success']), conversationKey: conversationKey.optional()}).strict();
const invocationBindRequest = z.object({...requestBase, operation: z.literal('invocation_bind'), clock: safeClock, conversationKey, reservationId, record: invocationRecordSchema}).strict();
const invocationUpdateRequest = z.object({...requestBase, operation: z.literal('invocation_update'), clock: safeClock, conversationKey, reservationId, patch: invocationRecordSchema.partial().pick({phase: true, deadline: true, pid: true, creationIdentity: true, cleanupOutcome: true}).strict()}).strict();
const recoveryReconcileRequest = z.object({...requestBase, operation: z.literal('recovery_reconcile_pending'), clock: safeClock, proof: recoveryBootBoundaryProofSchema}).strict();
const automaticReconcileRequest = z.object({...requestBase, operation: z.literal('recovery_reconcile_automatic'), clock: safeClock}).strict();
const requestSchema = z.discriminatedUnion('operation', [reserveRequest, settleRequest, cancelRequest, shutdownRequest,
  recoveryStatusRequest, recoveryPreflightRequest, recoveryConfirmRequest, recoveryTrialReserveRequest,
  recoveryTrialSettleRequest, recoveryFinishRequest, recoveryCancelRequest, recoveryAbortRequest, recoveryAdmissionRequest, recoveryAdmissionReleaseRequest, recoveryEventRequest, recoveryReconcileRequest, automaticReconcileRequest, invocationBindRequest, invocationUpdateRequest]);

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
  'RELEASE_PENDING_LIMIT',
  'RELEASE_RECOVERY_INVALID',
  'RELEASE_RECOVERY_NOT_ALLOWED',
  'RELEASE_RECOVERY_STALE',
  'RELEASE_RECOVERY_FAILED',
  'RELEASE_INVOCATION_INVALID',
] as const;
export type AccountingErrorCode = typeof errorCodes[number];
const errorCodeSchema = z.enum(errorCodes);
const resultSchema = z.union([reservationId, z.number().int().nonnegative().safe().max(MAX_SAFE), z.null(), recoveryStatusSchema, recoveryPreflightSchema, recoveryAdmissionSchema, recoveryConfirmationSchema, automaticReconcileSchema]);

const responseSchema = z.object({
  kind: z.literal('response'),
  version: z.literal(ACCOUNTING_PROTOCOL_VERSION),
  requestId: reservationId,
  ok: z.boolean(),
  result: resultSchema,
  snapshot: accountingSnapshotSchema,
  recovery: recoveryStatusSchema,
  error: errorCodeSchema.optional(),
}).strict().refine(value => value.ok ? value.error === undefined : value.error !== undefined);
const readySchema = z.object({kind: z.literal('ready'), version: z.literal(ACCOUNTING_PROTOCOL_VERSION), snapshot: accountingSnapshotSchema, recovery: recoveryStatusSchema}).strict();
const startupErrorSchema = z.object({kind: z.literal('startup-error'), version: z.literal(ACCOUNTING_PROTOCOL_VERSION), error: errorCodeSchema}).strict();

export type AccountingRequest = z.infer<typeof requestSchema>;
export type AccountingResponse = z.infer<typeof responseSchema>;
export type AccountingReady = z.infer<typeof readySchema>;
export type AccountingStartupError = z.infer<typeof startupErrorSchema>;
export type AccountingWorkerMessage = AccountingResponse | AccountingReady | AccountingStartupError;
export type RecoveryStatusMessage = z.infer<typeof recoveryStatusSchema>;
export type RecoveryPreflightMessage = z.infer<typeof recoveryPreflightSchema>;
export type RecoveryAdmissionMessage = z.infer<typeof recoveryAdmissionSchema>;
export type RecoveryConfirmationMessage = z.infer<typeof recoveryConfirmationSchema>;

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

export function recoveryStatusCopy(status: ReleaseRecoveryStatus): ReleaseRecoveryStatus {
  const parsed = recoveryStatusSchema.safeParse(status);
  if (!parsed.success) throw new Error('RELEASE_PROTOCOL_INVALID');
  return {...parsed.data};
}

export function recoveryPreflightCopy(preflight: ReleaseRecoveryPreflight): ReleaseRecoveryPreflight {
  const parsed = recoveryPreflightSchema.safeParse(preflight);
  if (!parsed.success) throw new Error('RELEASE_PROTOCOL_INVALID');
  return {...parsed.data};
}

export function recoveryConfirmationCopy(confirmation: ReleaseRecoveryConfirmation): ReleaseRecoveryConfirmation {
  const parsed = recoveryConfirmationSchema.safeParse(confirmation);
  if (!parsed.success) throw new Error('RELEASE_PROTOCOL_INVALID');
  return {...parsed.data};
}

export function recoveryAdmissionCopy(admission: ReleaseRecoveryAdmission): ReleaseRecoveryAdmission {
  const parsed = recoveryAdmissionSchema.safeParse(admission);
  if (!parsed.success) throw new Error('RELEASE_PROTOCOL_INVALID');
  return {...parsed.data};
}
