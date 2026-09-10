import {access, open as openFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import type {AccountedUsage, AdmissionKind, SettlementClassification, SubscriptionAccounting} from './subscription-accounting.js';
import {parseRecoveryBootBoundaryProof, RECOVERY_BOOT_BOUNDARY_MARGIN_MS, RECOVERY_BOOT_PROOF_MAX_AGE_MS, type RecoveryBootBoundaryProof} from './recovery-boot-boundary.js';

const HOUR_MS = 3_600_000;
const MAX_IN_FLIGHT = 2;
const MAX_RECOVERY_TRIALS_PER_HOUR = 12;
const MAX_ROWS = 4_096;
const PAGE_SIZE = 4_096;
const MAX_PAGE_COUNT = 2_048;
const MAX_TOKENS_PER_FIELD = 1_000_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SCHEMA_VERSION = 4;
const DB_NAME = 'release-observer-accounting.sqlite';
const LEGACY_FILES = ['release-observer-accounting.jsonl', 'release-observer-accounting.lock'];
const conversationKey = z.string().min(1).max(512);
const recoveryBinding = z.string().min(1).max(512);
const recoveryAttemptId = z.string().uuid();
const counter = z.number().int().nonnegative().max(MAX_TOKENS_PER_FIELD);
const clockValue = z.number().int().nonnegative().safe();
const usageSchema = z.object({
  inputTokens: counter,
  outputTokens: counter,
  cachedInputTokens: counter.nullable(),
}).strict().refine(value => value.cachedInputTokens === null || value.cachedInputTokens <= value.inputTokens);
type Usage = z.infer<typeof usageSchema>;
type Database = import('node:sqlite').DatabaseSync;
interface PendingReservation {id: string; conversation: string}
export type ReleaseRecoveryState = 'normal' | 'warning' | 'cooldown' | 'blocked' | 'awaiting_confirmation' | 'probing' | 'recovered' | 'failed';
export type ReleaseRecoveryReason = 'unresolved_previous_call' | 'unsafe_unknown';
export interface ReleaseRecoveryStatus {
  state: ReleaseRecoveryState;
  revision: number;
  knownTokens: number;
  unknown: number;
  recoveryAllowed: boolean;
  reason?: ReleaseRecoveryReason | undefined;
  nextEligibleAt?: number | null | undefined;
  cooldownUntil?: number | null | undefined;
}
export interface ReleaseRecoveryAdmission {allowed: boolean; kind: 'ordinary' | 'retry' | 'half_open'; nextEligibleAt: number | null; reason?: ReleaseRecoveryReason | 'cooldown' | 'retry_backoff' | 'no_eligible_task' | 'half_open_busy' | 'unsafe_unknown' | undefined}
export type ReleaseRecoveryEvent = {kind: 'recoverable_failure' | 'unknown_usage' | 'known_success' | 'half_open_reserved' | 'half_open_failure' | 'half_open_success'; at: number};
export interface ReleaseRecoveryPreflight extends ReleaseRecoveryStatus {
  allowed: boolean;
}
export interface ReleaseRecoveryConfirmation {
  attemptId: string;
  revision: number;
  binding: string;
}
export interface ReleaseAccountingSnapshot {
  starts: number;
  activeStarts: number;
  inFlight: number;
  unresolved: number;
  knownTokens: number;
  unknown: number;
  poisoned: boolean;
}
export interface ReleaseAccountingOwner {
  forConversation(key: string): SubscriptionAccounting;
  snapshot(): ReleaseAccountingSnapshot;
  recoveryStatus?(): ReleaseRecoveryStatus;
  preflightRecovery?(binding: string): Promise<ReleaseRecoveryPreflight>;
  confirmRecovery?(input: {revision: number; binding: string}): Promise<ReleaseRecoveryConfirmation>;
  reserveRecoveryTrial?(confirmation: ReleaseRecoveryConfirmation): Promise<string | null>;
  settleRecoveryTrial?(attemptId: string, reservationId: string, usage: AccountedUsage | null): Promise<void>;
  finishRecovery?(attemptId: string, result: {success: boolean; closureConfirmed: boolean}): Promise<void>;
  cancelRecoveryTrial?(attemptId: string, reservationId: string): Promise<void>;
  cancelRecovery?(attemptId: string): Promise<void>;
  recoveryAdmission?(now: number, eligibleTask: boolean, conversationKey?: string): Promise<ReleaseRecoveryAdmission>;
  reconcileRecoveredPending?(proof: RecoveryBootBoundaryProof): Promise<number>;
  releaseRecoveryAdmission?(conversationKey: string): Promise<void>;
  recordRecoveryEvent?(event: ReleaseRecoveryEvent): Promise<void>;
  close(): Promise<void>;
}
export interface ReleaseAccountingRecoveryOwner extends ReleaseAccountingOwner {
  recoveryStatus(): ReleaseRecoveryStatus;
  preflightRecovery(binding: string): Promise<ReleaseRecoveryPreflight>;
  confirmRecovery(input: {revision: number; binding: string}): Promise<ReleaseRecoveryConfirmation>;
  reserveRecoveryTrial(confirmation: ReleaseRecoveryConfirmation): Promise<string | null>;
  settleRecoveryTrial(attemptId: string, reservationId: string, usage: AccountedUsage | null): Promise<void>;
  finishRecovery(attemptId: string, result: {success: boolean; closureConfirmed: boolean}): Promise<void>;
  cancelRecoveryTrial(attemptId: string, reservationId: string): Promise<void>;
  cancelRecovery(attemptId: string): Promise<void>;
  recoveryAdmission(now: number, eligibleTask: boolean, conversationKey?: string): Promise<ReleaseRecoveryAdmission>;
  reconcileRecoveredPending(proof: RecoveryBootBoundaryProof): Promise<number>;
  releaseRecoveryAdmission(conversationKey: string): Promise<void>;
  recordRecoveryEvent(event: ReleaseRecoveryEvent): Promise<void>;
}
type Row = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function validateClock(value: number): number { return clockValue.safeParse(value).success ? value : fail('RELEASE_INVALID_CLOCK'); }
function validateRuntimeVersion(): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!match) fail('RELEASE_RUNTIME_UNSUPPORTED');
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < 13)) fail('RELEASE_RUNTIME_UNSUPPORTED');
}
function safeInteger(value: unknown, code = 'RELEASE_SCHEMA_INVALID'): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail(code);
}
function isMissing(path: string): Promise<boolean> {
  return access(path).then(() => false).catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    throw error;
  });
}
function value(row: Row | undefined, key: string): unknown { return row?.[key]; }
function pragmaNumber(db: Database, sql: string, key: string): number { return safeInteger(value(db.prepare(sql).get() as Row, key)); }
function pragmaText(db: Database, sql: string, key: string): string {
  const result = value(db.prepare(sql).get() as Row, key);
  return typeof result === 'string' ? result.toLowerCase() : fail('RELEASE_SCHEMA_INVALID');
}
function begin(db: Database): void { db.exec('BEGIN IMMEDIATE'); }
function rollback(db: Database): void { try { db.exec('ROLLBACK'); } catch { /* The transaction may already be closed. */ } }
function transaction<T>(db: Database, operation: () => T): T {
  begin(db);
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { rollback(db); throw error; }
}

function configureNewDatabase(db: Database): void {
  db.exec(`PRAGMA page_size=${PAGE_SIZE}; PRAGMA max_page_count=${MAX_PAGE_COUNT}; PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA;`);
  if (pragmaText(db, 'PRAGMA journal_mode=DELETE', 'journal_mode') !== 'delete') fail('RELEASE_SCHEMA_INVALID');
  if (pragmaText(db, 'PRAGMA locking_mode=EXCLUSIVE', 'locking_mode') !== 'exclusive') fail('RELEASE_SCHEMA_INVALID');
  if (pragmaNumber(db, 'PRAGMA page_size', 'page_size') !== PAGE_SIZE ||
      pragmaNumber(db, 'PRAGMA max_page_count', 'max_page_count') !== MAX_PAGE_COUNT ||
      pragmaNumber(db, 'PRAGMA synchronous', 'synchronous') !== 3 ||
      pragmaNumber(db, 'PRAGMA busy_timeout', 'timeout') !== 0) fail('RELEASE_SCHEMA_INVALID');
}
function configureExistingDatabase(db: Database): void {
  if (pragmaText(db, 'PRAGMA journal_mode', 'journal_mode') !== 'delete') fail('RELEASE_SCHEMA_INVALID');
  if (pragmaNumber(db, 'PRAGMA page_size', 'page_size') !== PAGE_SIZE ||
      pragmaNumber(db, 'PRAGMA page_count', 'page_count') > MAX_PAGE_COUNT) fail('RELEASE_SCHEMA_INVALID');
  db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA;');
  if (pragmaNumber(db, `PRAGMA max_page_count=${MAX_PAGE_COUNT}`, 'max_page_count') !== MAX_PAGE_COUNT ||
      pragmaText(db, 'PRAGMA locking_mode=EXCLUSIVE', 'locking_mode') !== 'exclusive' ||
      pragmaNumber(db, 'PRAGMA synchronous', 'synchronous') !== 3 ||
      pragmaNumber(db, 'PRAGMA busy_timeout', 'timeout') !== 0) fail('RELEASE_SCHEMA_INVALID');
}
function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = ${SCHEMA_VERSION}),
      cumulative_starts INTEGER NOT NULL CHECK (cumulative_starts >= 0),
      known_tokens INTEGER NOT NULL CHECK (known_tokens >= 0),
      unknown_count INTEGER NOT NULL CHECK (unknown_count >= 0),
      unknown_admission_ceiling INTEGER, last_admission INTEGER,
      recovery_revision INTEGER NOT NULL CHECK (recovery_revision >= 0),
      recovery_covered_revision INTEGER NOT NULL CHECK (recovery_covered_revision >= 0),
      recovery_sequence INTEGER NOT NULL CHECK (recovery_sequence >= 0)
    );
    CREATE TABLE admissions (
      id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal > 0), conversation TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'unknown', 'not_dispatched', 'recovery_trial')),
      input_tokens INTEGER NOT NULL CHECK (input_tokens BETWEEN 0 AND 1000000000),
      output_tokens INTEGER NOT NULL CHECK (output_tokens BETWEEN 0 AND 1000000000),
      cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens BETWEEN 0 AND 1000000000 AND cached_input_tokens <= input_tokens),
      settlement_classification TEXT NOT NULL DEFAULT 'legacy',
      recovery_attempt_id TEXT
    );
    CREATE INDEX admissions_conversation_time ON admissions(conversation, admitted_at);
    CREATE INDEX admissions_state_time ON admissions(state, admitted_at);
    CREATE TABLE recovery_attempts (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      binding TEXT NOT NULL CHECK (length(binding) BETWEEN 1 AND 512),
      status TEXT NOT NULL CHECK (status IN ('confirmed', 'trial_reserved', 'trial_settled', 'succeeded', 'failed')),
      trial_reservation_id TEXT UNIQUE,
      usage_state TEXT NOT NULL CHECK (usage_state IN ('none', 'known', 'unknown')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    );
    CREATE TABLE recovery_events (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      event TEXT NOT NULL CHECK (event IN ('confirmed', 'trial_reserved', 'trial_settled', 'succeeded', 'failed', 'interrupted', 'cancelled')),
      recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0)
    );
    INSERT INTO metadata VALUES (1, ${SCHEMA_VERSION}, 0, 0, 0, NULL, NULL, 0, 0, 0);
    PRAGMA user_version=${SCHEMA_VERSION};
  `);
  ensureRecoveryPolicy(db);
  ensureRecoverySafety(db);
  ensureSettlementClassification(db);
}
function ensureRecoveryPolicy(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 0 AND 3),
    next_eligible INTEGER,
    cooldown_until INTEGER,
    cooldown_level INTEGER NOT NULL CHECK (cooldown_level BETWEEN 0 AND 2),
    half_open INTEGER NOT NULL CHECK (half_open IN (0, 1)),
    half_open_conversation TEXT,
    half_open_claim_after_ordinal INTEGER
  );`);
  const columns = new Set<string>();
  for (const row of db.prepare('PRAGMA table_info(recovery_policy)').iterate() as Iterable<Row>) if (typeof row.name === 'string') columns.add(row.name);
  if (!columns.has('half_open_conversation')) db.exec('ALTER TABLE recovery_policy ADD COLUMN half_open_conversation TEXT');
  if (!columns.has('half_open_claim_after_ordinal')) db.exec('ALTER TABLE recovery_policy ADD COLUMN half_open_claim_after_ordinal INTEGER');
  db.prepare("INSERT OR IGNORE INTO recovery_policy (id, failure_count, next_eligible, cooldown_until, cooldown_level, half_open, half_open_conversation, half_open_claim_after_ordinal) VALUES (1, 0, NULL, NULL, 0, 0, NULL, NULL)").run();
  validateExactColumns(db, 'recovery_policy', ['id', 'failure_count', 'next_eligible', 'cooldown_until', 'cooldown_level', 'half_open', 'half_open_conversation', 'half_open_claim_after_ordinal']);
  const row = db.prepare('SELECT id, failure_count, next_eligible, cooldown_until, cooldown_level, half_open, half_open_conversation, half_open_claim_after_ordinal FROM recovery_policy WHERE id = 1').get() as Row | undefined;
  const cumulativeStarts = safeInteger((db.prepare('SELECT cumulative_starts FROM metadata WHERE id = 1').get() as Row | undefined)?.cumulative_starts);
  if (!row || row.id !== 1 || !Number.isSafeInteger(row.failure_count) || Number(row.failure_count) < 0 || Number(row.failure_count) > 3 ||
      row.next_eligible !== null && !Number.isSafeInteger(row.next_eligible) || row.cooldown_until !== null && !Number.isSafeInteger(row.cooldown_until) ||
      !Number.isSafeInteger(row.cooldown_level) || Number(row.cooldown_level) < 0 || Number(row.cooldown_level) > 2 ||
      !Number.isSafeInteger(row.half_open) || ![0, 1].includes(Number(row.half_open)) ||
      (row.half_open_conversation !== null && !conversationKey.safeParse(row.half_open_conversation).success) ||
      (row.half_open_claim_after_ordinal !== null && (!Number.isSafeInteger(row.half_open_claim_after_ordinal) || Number(row.half_open_claim_after_ordinal) < 0 || Number(row.half_open_claim_after_ordinal) > cumulativeStarts))) fail('RELEASE_SCHEMA_INVALID');
}
function ensureRecoverySafety(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_safety (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    unsafe_unknown INTEGER NOT NULL CHECK (unsafe_unknown IN (0, 1))
  ); INSERT OR IGNORE INTO recovery_safety VALUES (1, 0);`);
  validateExactColumns(db, 'recovery_safety', ['id', 'unsafe_unknown']);
  const row = db.prepare('SELECT id, unsafe_unknown FROM recovery_safety WHERE id = 1').get() as Row | undefined;
  if (!row || row.id !== 1 || !Number.isSafeInteger(row.unsafe_unknown) || ![0, 1].includes(Number(row.unsafe_unknown))) fail('RELEASE_SCHEMA_INVALID');
}
function ensureSettlementClassification(db: Database): void {
  const columns = new Set<string>();
  for (const row of db.prepare('PRAGMA table_info(admissions)').iterate() as Iterable<Row>) if (typeof row.name === 'string') columns.add(row.name);
  if (!columns.has('settlement_classification')) db.exec("ALTER TABLE admissions ADD COLUMN settlement_classification TEXT NOT NULL DEFAULT 'legacy'");
  const invalid = db.prepare("SELECT COUNT(*) AS count FROM admissions WHERE settlement_classification NOT IN ('legacy', 'known_success', 'known_non_success', 'safe_unknown', 'unsafe_unknown', 'not_dispatched')").get() as Row;
  if (safeInteger(invalid.count) > 0) fail('RELEASE_SCHEMA_INVALID');
  const legacyUnknown = db.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'unknown' AND settlement_classification = 'legacy'").get() as Row;
  if (safeInteger(legacyUnknown.count) > 0) db.prepare('UPDATE recovery_safety SET unsafe_unknown = 1 WHERE id = 1').run();
}
function validateColumns(db: Database, table: string, expected: readonly string[]): void {
  const actual = new Set<string>();
  for (const row of db.prepare(`PRAGMA table_info(${table})`).iterate() as Iterable<Row>) if (typeof row.name === 'string') actual.add(row.name);
  if (expected.some(column => !actual.has(column))) fail('RELEASE_SCHEMA_INVALID');
}
function validateExactColumns(db: Database, table: string, expected: readonly string[]): void {
  const actual = new Set<string>();
  for (const row of db.prepare(`PRAGMA table_info(${table})`).iterate() as Iterable<Row>) if (typeof row.name === 'string') actual.add(row.name);
  if (actual.size !== expected.length || expected.some(column => !actual.has(column))) fail('RELEASE_SCHEMA_INVALID');
}
type StoredAdmission = {state: string; recoveryAttemptId: string | null; ordinal: number; conversation: string; settlementClassification: string};
function validateRecoveryEvidence(db: Database, initialNow: number, recoveryRevision: number, coveredRevision: number,
  recoverySequence: number, unknownCount: number, admissions: Map<string, StoredAdmission>): void {
  validateExactColumns(db, 'recovery_attempts', ['id', 'revision', 'binding', 'status', 'trial_reservation_id', 'usage_state', 'created_at', 'updated_at']);
  validateExactColumns(db, 'recovery_events', ['id', 'attempt_id', 'sequence', 'revision', 'event', 'recorded_at']);
  const attempts = new Map<string, {revision: number; status: string; trialReservationId: string | null; usageState: string}>();
  const attemptRows = db.prepare('SELECT id, revision, binding, status, trial_reservation_id, usage_state, created_at, updated_at FROM recovery_attempts ORDER BY rowid').all() as Row[];
  if (attemptRows.length > MAX_ROWS) fail('RELEASE_SCHEMA_INVALID');
  for (const row of attemptRows) {
    const id = recoveryAttemptId.safeParse(row.id), revision = clockValue.safeParse(row.revision), binding = recoveryBinding.safeParse(row.binding);
    const status = String(row.status), usageState = String(row.usage_state);
    const reservation = row.trial_reservation_id === null ? null : recoveryAttemptId.safeParse(row.trial_reservation_id);
    const createdAt = clockValue.safeParse(row.created_at), updatedAt = clockValue.safeParse(row.updated_at);
    if (!id.success || !revision.success || !binding.success || !['confirmed', 'trial_reserved', 'trial_settled', 'succeeded', 'failed'].includes(status) ||
        (reservation !== null && !reservation.success) || !['none', 'known', 'unknown'].includes(usageState) || !createdAt.success || !updatedAt.success ||
        updatedAt.data < createdAt.data || updatedAt.data > initialNow || attempts.has(id.data)) fail('RELEASE_SCHEMA_INVALID');
    const trialReservationId = reservation === null ? null : reservation.data;
    if ((status === 'confirmed' && (trialReservationId !== null || usageState !== 'none')) ||
        (status === 'trial_reserved' && (trialReservationId === null || usageState !== 'none')) ||
        (status === 'trial_settled' && (trialReservationId === null || !['known', 'unknown'].includes(usageState))) ||
        (status === 'succeeded' && (trialReservationId === null || usageState !== 'known'))) fail('RELEASE_SCHEMA_INVALID');
    attempts.set(id.data, {revision: revision.data, status, trialReservationId, usageState});
  }
  const eventRows = db.prepare('SELECT id, attempt_id, sequence, revision, event, recorded_at FROM recovery_events ORDER BY sequence').all() as Row[];
  if (eventRows.length !== recoverySequence || eventRows.length > MAX_ROWS * 8) fail('RELEASE_SCHEMA_INVALID');
  const events = new Map<string, Array<{sequence: number; revision: number; event: string}>>();
  for (let index = 0; index < eventRows.length; index++) {
    const row = eventRows[index]!;
    const id = recoveryAttemptId.safeParse(row.id), attemptId = recoveryAttemptId.safeParse(row.attempt_id);
    const sequence = clockValue.safeParse(row.sequence), revision = clockValue.safeParse(row.revision);
    const event = String(row.event), recordedAt = clockValue.safeParse(row.recorded_at);
    if (!id.success || !attemptId.success || !sequence.success || sequence.data !== index + 1 || !revision.success ||
        !['confirmed', 'trial_reserved', 'trial_settled', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(event) ||
        !recordedAt.success || recordedAt.data > initialNow || !attempts.has(attemptId.data)) fail('RELEASE_SCHEMA_INVALID');
    const list = events.get(attemptId.data) ?? [];
    list.push({sequence: sequence.data, revision: revision.data, event});
    events.set(attemptId.data, list);
  }
  const succeeded: Array<{revision: number; reservationId: string}> = [];
  // Reservation events and admission ordinals are allocated in the same
  // transaction. Their strict global order binds legacy terminal rows (whose
  // recovery_attempt_id is null) to the attempt that originally reserved them.
  let previousTrialOrdinal = 0;
  for (const event of eventRows) {
    if (event.event !== 'trial_reserved') continue;
    const attempt = attempts.get(String(event.attempt_id));
    const admission = attempt?.trialReservationId ? admissions.get(attempt.trialReservationId) : undefined;
    if (!admission || admission.ordinal <= previousTrialOrdinal) fail('RELEASE_SCHEMA_INVALID');
    previousTrialOrdinal = admission.ordinal;
  }
  for (const [attemptId, attempt] of attempts) {
    const list = events.get(attemptId) ?? [];
    const names = list.map(event => event.event);
    if (names[0] !== 'confirmed' || names.filter(event => event === 'confirmed').length !== 1) fail('RELEASE_SCHEMA_INVALID');
    // Confirmation is bound to a revision; settlement records the current
    // ledger revision, including an increment when trial usage is unknown.
    // Other in-flight admissions may also settle unknown before finalization.
    if (list.some((event, index) => event.revision < attempt.revision || event.revision > recoveryRevision ||
        event.revision < (list[index - 1]?.revision ?? attempt.revision) ||
        (['confirmed', 'trial_reserved', 'cancelled', 'succeeded'].includes(event.event) && event.revision !== attempt.revision) ||
        (event.event === 'trial_settled' && attempt.usageState === 'unknown' && event.revision <= attempt.revision))) fail('RELEASE_SCHEMA_INVALID');
    const expected = attempt.status === 'confirmed' ? ['confirmed']
      : attempt.status === 'trial_reserved' ? ['confirmed', 'trial_reserved']
        : attempt.status === 'trial_settled' ? ['confirmed', 'trial_reserved', 'trial_settled']
          : attempt.status === 'succeeded' ? ['confirmed', 'trial_reserved', 'trial_settled', 'succeeded'] :
            (names.includes('cancelled') ? names.includes('trial_reserved') ? ['confirmed', 'trial_reserved', 'cancelled'] : ['confirmed', 'cancelled']
              : names.includes('interrupted') ? names.includes('trial_settled') ? ['confirmed', 'trial_reserved', 'trial_settled', 'interrupted'] : names.includes('trial_reserved') ? ['confirmed', 'trial_reserved', 'interrupted'] : ['confirmed', 'interrupted'] : ['confirmed', 'trial_reserved', 'trial_settled', 'failed']);
    if (names.length !== expected.length || names.some((event, index) => event !== expected[index])) fail('RELEASE_SCHEMA_INVALID');
    if (names.includes('trial_reserved') !== (attempt.trialReservationId !== null) ||
        names.includes('trial_settled') !== (attempt.usageState !== 'none')) fail('RELEASE_SCHEMA_INVALID');
    if (attempt.trialReservationId === null) continue;
    const admission = admissions.get(attempt.trialReservationId);
    if (!admission || admission.conversation !== '__recovery_trial__' || admission.recoveryAttemptId !== null && admission.recoveryAttemptId !== attemptId) fail('RELEASE_SCHEMA_INVALID');
    if (attempt.status === 'trial_reserved' && (admission.state !== 'recovery_trial' || admission.recoveryAttemptId !== attemptId)) fail('RELEASE_SCHEMA_INVALID');
    if (attempt.status !== 'trial_reserved' && !['settled', 'unknown', 'not_dispatched'].includes(admission.state)) fail('RELEASE_SCHEMA_INVALID');
    if ((attempt.usageState === 'known' && admission.state !== 'settled') ||
        (attempt.usageState === 'unknown' && admission.state !== 'unknown') ||
        (names.includes('cancelled') && admission.state !== 'not_dispatched') ||
        (names.includes('interrupted') && !names.includes('trial_settled') && admission.state !== 'unknown')) fail('RELEASE_SCHEMA_INVALID');
    if (attempt.status === 'succeeded') {
      if (attempt.usageState !== 'known' || admission.state !== 'settled') fail('RELEASE_SCHEMA_INVALID');
      succeeded.push({revision: attempt.revision, reservationId: attempt.trialReservationId});
    }
  }
  if (recoveryRevision !== unknownCount || (unknownCount === 0 && (recoveryRevision !== 0 || coveredRevision !== 0))) fail('RELEASE_SCHEMA_INVALID');
  if (coveredRevision === 0) {
    if (succeeded.length > 0) fail('RELEASE_SCHEMA_INVALID');
  } else {
    const matching = succeeded.filter(attempt => attempt.revision === coveredRevision);
    if (matching.length !== 1) fail('RELEASE_SCHEMA_INVALID');
  }
}
function validateStoredDatabase(db: Database, initialNow: number,expectedVersion=SCHEMA_VERSION): PendingReservation[] {
  if (pragmaNumber(db, 'PRAGMA user_version', 'user_version') !== expectedVersion || pragmaNumber(db, 'PRAGMA page_count', 'page_count') > MAX_PAGE_COUNT) fail('RELEASE_SCHEMA_INVALID');
  if (value(db.prepare('PRAGMA integrity_check').get() as Row, 'integrity_check') !== 'ok') fail('RELEASE_SCHEMA_INVALID');
  validateColumns(db, 'metadata', ['id', 'version', 'cumulative_starts', 'known_tokens', 'unknown_count', 'unknown_admission_ceiling', 'last_admission', ...(expectedVersion >= 4 ? ['recovery_revision', 'recovery_covered_revision', 'recovery_sequence'] : []), ...(expectedVersion >= 5 ? ['recovery_failure_count', 'recovery_next_eligible', 'recovery_cooldown_until', 'recovery_cooldown_level', 'recovery_half_open'] : [])]);
  validateColumns(db, 'admissions', ['id', 'ordinal', 'conversation', 'admitted_at', 'state', 'input_tokens', 'output_tokens', 'cached_input_tokens', ...(expectedVersion >= 4 ? ['recovery_attempt_id', 'settlement_classification'] : [])]);
  const metadata = db.prepare(`SELECT id, version, cumulative_starts, known_tokens, unknown_count, unknown_admission_ceiling, last_admission${expectedVersion >= 4 ? ', recovery_revision, recovery_covered_revision, recovery_sequence' : ''}${expectedVersion >= 5 ? ', recovery_failure_count, recovery_next_eligible, recovery_cooldown_until, recovery_cooldown_level, recovery_half_open' : ''} FROM metadata`).all() as Row[];
  if (metadata.length !== 1 || metadata[0]!.id !== 1 || metadata[0]!.version !== expectedVersion) fail('RELEASE_SCHEMA_INVALID');
  const cumulativeStarts = safeInteger(metadata[0]!.cumulative_starts);
  const knownTokens = safeInteger(metadata[0]!.known_tokens);
  const unknownCount = safeInteger(metadata[0]!.unknown_count);
  const unknownCeiling = metadata[0]!.unknown_admission_ceiling === null ? null : safeInteger(metadata[0]!.unknown_admission_ceiling);
  const lastAdmission = metadata[0]!.last_admission === null ? null : safeInteger(metadata[0]!.last_admission);
  const recoveryRevision = expectedVersion >= 4 ? safeInteger(metadata[0]!.recovery_revision) : 0;
  const recoveryCoveredRevision = expectedVersion >= 4 ? safeInteger(metadata[0]!.recovery_covered_revision) : 0;
  const recoverySequence = expectedVersion >= 4 ? safeInteger(metadata[0]!.recovery_sequence) : 0;
  if (expectedVersion >= 5) {
    const failureCount = safeInteger(metadata[0]!.recovery_failure_count);
    const nextEligible = metadata[0]!.recovery_next_eligible === null ? null : safeInteger(metadata[0]!.recovery_next_eligible);
    const cooldownUntil = metadata[0]!.recovery_cooldown_until === null ? null : safeInteger(metadata[0]!.recovery_cooldown_until);
    const cooldownLevel = safeInteger(metadata[0]!.recovery_cooldown_level);
    const halfOpen = safeInteger(metadata[0]!.recovery_half_open);
    if (failureCount > 3 || cooldownLevel > 2 || halfOpen > 1) fail('RELEASE_SCHEMA_INVALID');
  }
  if (recoveryCoveredRevision > recoveryRevision) fail('RELEASE_SCHEMA_INVALID');
  if (lastAdmission !== null && initialNow < lastAdmission) fail('RELEASE_CLOCK_REGRESSION');
  const pending: PendingReservation[] = [];
  const pendingConversations = new Set<string>();
  const admissions = new Map<string, StoredAdmission>();
  let rowCount = 0, unknownRows = 0, rowKnownTokens = 0, maximumAdmission: number | null = null, maximumOrdinal = 0, maximumUnknownOrdinal = 0;
  const admissionSelect = expectedVersion >= 4
    ? 'SELECT id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens, settlement_classification, recovery_attempt_id FROM admissions ORDER BY ordinal'
    : 'SELECT id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens FROM admissions ORDER BY ordinal';
  for (const row of db.prepare(admissionSelect).iterate() as Iterable<Row>) {
    rowCount++;
    if (rowCount > MAX_ROWS) fail('RELEASE_SCHEMA_INVALID');
    const id = z.string().uuid().safeParse(row.id), ordinal = clockValue.safeParse(row.ordinal), conversation = conversationKey.safeParse(row.conversation), admittedAt = clockValue.safeParse(row.admitted_at);
    if (!id.success || !ordinal.success || !conversation.success || !admittedAt.success || !['pending', 'settled', 'unknown',...(expectedVersion>=3?['not_dispatched']:[]),...(expectedVersion>=4?['recovery_trial']:[])].includes(String(row.state))) fail('RELEASE_SCHEMA_INVALID');
    if (ordinal.data > maximumOrdinal) maximumOrdinal = ordinal.data;
    const inputTokens = safeInteger(row.input_tokens), outputTokens = safeInteger(row.output_tokens), cachedInputTokens = safeInteger(row.cached_input_tokens);
    if (inputTokens > MAX_TOKENS_PER_FIELD || outputTokens > MAX_TOKENS_PER_FIELD || cachedInputTokens > MAX_TOKENS_PER_FIELD || cachedInputTokens > inputTokens) fail('RELEASE_SCHEMA_INVALID');
    const state = String(row.state);
    const settlementClassification = expectedVersion >= 4 ? String(row.settlement_classification) : 'legacy';
    if (expectedVersion >= 4 && !['legacy', 'known_success', 'known_non_success', 'safe_unknown', 'unsafe_unknown', 'not_dispatched'].includes(settlementClassification)) fail('RELEASE_SCHEMA_INVALID');
    if (expectedVersion >= 4 && state === 'unknown' && !['legacy', 'safe_unknown', 'unsafe_unknown'].includes(settlementClassification)) fail('RELEASE_SCHEMA_INVALID');
    if (expectedVersion >= 4 && state === 'not_dispatched' && !['legacy', 'not_dispatched'].includes(settlementClassification)) fail('RELEASE_SCHEMA_INVALID');
    if (state !== 'settled' && (inputTokens !== MAX_TOKENS_PER_FIELD || outputTokens !== MAX_TOKENS_PER_FIELD || cachedInputTokens !== MAX_TOKENS_PER_FIELD)) fail('RELEASE_SCHEMA_INVALID');
    const attemptId = expectedVersion >= 4 && row.recovery_attempt_id !== null ? recoveryAttemptId.safeParse(row.recovery_attempt_id) : {success: row.recovery_attempt_id === undefined || row.recovery_attempt_id === null};
    if (!attemptId.success || (state === 'recovery_trial' ? row.recovery_attempt_id === null : row.recovery_attempt_id !== null && row.recovery_attempt_id !== undefined)) fail('RELEASE_SCHEMA_INVALID');
    admissions.set(id.data, {state, recoveryAttemptId: row.recovery_attempt_id === null || row.recovery_attempt_id === undefined ? null : String(row.recovery_attempt_id), ordinal: ordinal.data, conversation: conversation.data, settlementClassification});
    if (state === 'pending' || state === 'recovery_trial') {
      if (pending.length >= MAX_IN_FLIGHT || pendingConversations.has(conversation.data)) fail('RELEASE_SCHEMA_INVALID');
      pending.push({id: id.data, conversation: conversation.data}); pendingConversations.add(conversation.data);
    } else if (state === 'unknown') { unknownRows++; maximumUnknownOrdinal = Math.max(maximumUnknownOrdinal, ordinal.data); }
    else if(state==='settled')rowKnownTokens += inputTokens + outputTokens;
    if (maximumAdmission === null || admittedAt.data > maximumAdmission) maximumAdmission = admittedAt.data;
  }
  if (cumulativeStarts < rowCount || unknownCount !== unknownRows || knownTokens < rowKnownTokens ||
      maximumOrdinal > cumulativeStarts ||
      (unknownCount === 0 ? unknownCeiling !== null : unknownCeiling === null || unknownCeiling < maximumUnknownOrdinal || (expectedVersion < 4 && unknownCeiling !== cumulativeStarts)) ||
      (cumulativeStarts === 0 ? lastAdmission !== null : lastAdmission === null) ||
      (maximumAdmission !== null && lastAdmission !== null && maximumAdmission > lastAdmission)) fail('RELEASE_SCHEMA_INVALID');
  if (expectedVersion < 4 && unknownCeiling !== null && safeInteger((db.prepare('SELECT COUNT(*) AS count FROM admissions WHERE ordinal > ?').get(unknownCeiling) as Row).count) > 0) fail('RELEASE_SCHEMA_INVALID');
  const unsafeUnknownRows = [...admissions.values()].filter(admission => admission.state === 'unknown' && ['legacy', 'unsafe_unknown'].includes(admission.settlementClassification)).length;
  if (expectedVersion >= 4 && unsafeUnknownRows > 0 && recoveryCoveredRevision === 0 && unknownCeiling !== cumulativeStarts &&
      safeInteger((db.prepare('SELECT COUNT(*) AS count FROM recovery_attempts').get() as Row).count) === 0) fail('RELEASE_SCHEMA_INVALID');
  const expectedPending = db.prepare(`SELECT COUNT(*) AS count FROM admissions WHERE state = 'pending'${expectedVersion >= 4 ? " OR state = 'recovery_trial'" : ''}`).get() as Row;
  if (safeInteger(expectedPending.count) !== pending.length) fail('RELEASE_SCHEMA_INVALID');
  if (expectedVersion >= 4) validateRecoveryEvidence(db, initialNow, recoveryRevision, recoveryCoveredRevision, recoverySequence, unknownCount, admissions);
  return pending;
}
function errorCode(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.startsWith('RELEASE_')) return error;
  return new Error(fallback);
}

/** Rebuild legacy CHECK constraints under one exclusive transaction. */
function migrateLegacyVersion(db:Database,initialNow:number,version:2|3):void {
  validateStoredDatabase(db,initialNow,version);
  db.exec(`ALTER TABLE metadata RENAME TO metadata_v2;
    ALTER TABLE admissions RENAME TO admissions_v2;
    DROP INDEX admissions_conversation_time;DROP INDEX admissions_state_time;`);
  createSchema(db);
  db.exec(`DELETE FROM metadata;
    INSERT INTO metadata (id,version,cumulative_starts,known_tokens,unknown_count,unknown_admission_ceiling,last_admission,recovery_revision,recovery_covered_revision,recovery_sequence)
      SELECT id,${SCHEMA_VERSION},cumulative_starts,known_tokens,unknown_count,unknown_admission_ceiling,last_admission,
        CASE WHEN unknown_count = 0 THEN 0 ELSE unknown_count END,0,0 FROM metadata_v2;
    INSERT INTO admissions (id,ordinal,conversation,admitted_at,state,input_tokens,output_tokens,cached_input_tokens)
      SELECT id,ordinal,conversation,admitted_at,state,input_tokens,output_tokens,cached_input_tokens FROM admissions_v2;
    DROP TABLE admissions_v2;DROP TABLE metadata_v2;`);
  ensureSettlementClassification(db);
  validateStoredDatabase(db,initialNow);
}

function appendRecoveryEvent(db: Database, attemptId: string, revision: number, event: string, at: number): void {
  const row = db.prepare('SELECT recovery_sequence FROM metadata WHERE id = 1').get() as Row | undefined;
  const sequence = safeInteger(row?.recovery_sequence) + 1;
  db.prepare('UPDATE metadata SET recovery_sequence = ? WHERE id = 1').run(sequence);
  db.prepare('INSERT INTO recovery_events (id, attempt_id, sequence, revision, event, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), attemptId, sequence, revision, event, at);
}

/** A restart never replays an authorized probe. An interrupted probe becomes a
 * durable unknown result before the new owner is allowed to report status. */
function recoverInterruptedRecovery(db: Database, initialNow: number): void {
  const attempts = db.prepare("SELECT id, revision, status, trial_reservation_id FROM recovery_attempts WHERE status IN ('confirmed', 'trial_reserved', 'trial_settled') ORDER BY rowid").all() as Row[];
  for (const attempt of attempts) {
    const attemptId = recoveryAttemptId.parse(attempt.id);
    let currentRevision = safeInteger((db.prepare('SELECT recovery_revision FROM metadata WHERE id = 1').get() as Row).recovery_revision);
    const reservationId = attempt.trial_reservation_id === null ? null : recoveryAttemptId.parse(attempt.trial_reservation_id);
    if (attempt.status === 'trial_reserved' && reservationId !== null) {
      const admission = db.prepare('SELECT state FROM admissions WHERE id = ? AND recovery_attempt_id = ?').get(reservationId, attemptId) as Row | undefined;
      if (admission?.state === 'recovery_trial') {
        const stored = db.prepare('SELECT unknown_count, cumulative_starts FROM metadata WHERE id = 1').get() as Row;
        const unknown = safeInteger(stored.unknown_count);
        if (unknown >= MAX_SAFE) fail('RELEASE_COUNTER_OVERFLOW');
        currentRevision++;
        db.prepare("UPDATE admissions SET state = 'unknown', settlement_classification = 'unsafe_unknown', recovery_attempt_id = NULL WHERE id = ?").run(reservationId);
        db.prepare('UPDATE metadata SET unknown_count = ?, recovery_revision = ?, unknown_admission_ceiling = ? WHERE id = 1')
          .run(unknown + 1, currentRevision, safeInteger(stored.cumulative_starts));
        db.prepare('UPDATE recovery_safety SET unsafe_unknown = 1 WHERE id = 1').run();
      }
    }
    const current = db.prepare('SELECT recovery_revision FROM metadata WHERE id = 1').get() as Row;
    currentRevision = safeInteger(current.recovery_revision);
    db.prepare("UPDATE recovery_attempts SET status = 'failed', updated_at = ? WHERE id = ?").run(initialNow, attemptId);
    appendRecoveryEvent(db, attemptId, currentRevision, 'interrupted', initialNow);
  }
}
function recoverInterruptedHalfOpen(db: Database): void {
  const policy = db.prepare('SELECT half_open, half_open_conversation, half_open_claim_after_ordinal FROM recovery_policy WHERE id = 1').get() as Row;
  if (safeInteger(policy.half_open) !== 1) return;
  const key = typeof policy.half_open_conversation === 'string' ? policy.half_open_conversation : null;
  const claimAfter = policy.half_open_claim_after_ordinal === null ? null : safeInteger(policy.half_open_claim_after_ordinal);
  if (key !== null && claimAfter !== null) {
    const postClaim = db.prepare('SELECT id, state FROM admissions WHERE conversation = ? AND ordinal > ? ORDER BY ordinal LIMIT 1').get(key, claimAfter) as Row | undefined;
    if (postClaim === undefined) {
      db.prepare('UPDATE recovery_policy SET half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run();
      return;
    }
    const pending = postClaim.state === 'pending' ? postClaim : undefined;
    if (pending?.id !== undefined) {
    const stored = db.prepare('SELECT unknown_count, cumulative_starts, recovery_revision FROM metadata WHERE id = 1').get() as Row;
    const unknown = safeInteger(stored.unknown_count), revision = safeInteger(stored.recovery_revision);
    if (unknown >= MAX_SAFE || revision >= MAX_SAFE) fail('RELEASE_COUNTER_OVERFLOW');
    db.prepare("UPDATE admissions SET state = 'unknown', settlement_classification = 'unsafe_unknown' WHERE id = ?").run(z.string().uuid().parse(pending.id));
    db.prepare('UPDATE metadata SET unknown_count = ?, recovery_revision = ?, unknown_admission_ceiling = ? WHERE id = 1')
      .run(unknown + 1, revision + 1, safeInteger(stored.cumulative_starts));
    }
  }
  db.prepare('UPDATE recovery_safety SET unsafe_unknown = 1 WHERE id = 1').run();
  db.prepare('UPDATE recovery_policy SET half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL, next_eligible = NULL, cooldown_until = NULL WHERE id = 1').run();
}

export async function openReleaseAccounting(directory: string, now: () => number): Promise<ReleaseAccountingRecoveryOwner> {
  if (typeof now !== 'function') fail('RELEASE_INVALID_CLOCK');
  validateRuntimeVersion();
  const initialNow = validateClock(now());
  for (const legacy of LEGACY_FILES) if (!await isMissing(join(directory, legacy))) fail('RELEASE_LEGACY_STATE');
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try { ({DatabaseSync} = await import('node:sqlite')); } catch { fail('RELEASE_RUNTIME_UNSUPPORTED'); }
  const databasePath = join(directory, DB_NAME);
  let newDatabase = false;
  try {
    const created = await openFile(databasePath, 'wx', 0o600);
    await created.close();
    newDatabase = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw errorCode(error, 'RELEASE_DATABASE_UNAVAILABLE');
  }
  let db: Database | undefined;
  let recoveredPendingIds: string[] = [];
  try {
    for (const legacy of LEGACY_FILES) if (!await isMissing(join(directory, legacy))) fail('RELEASE_LEGACY_STATE');
    db = new DatabaseSync(databasePath, {timeout: 0});
    if (newDatabase) { configureNewDatabase(db); transaction(db, () => createSchema(db!)); }
      else { configureExistingDatabase(db); transaction(db, () => {
        const version = pragmaNumber(db!, 'PRAGMA user_version', 'user_version');
        if (version === 2 || version === 3) migrateLegacyVersion(db!, initialNow, version);
        else if (version === 4) { ensureRecoveryPolicy(db!); ensureRecoverySafety(db!); ensureSettlementClassification(db!); validateStoredDatabase(db!, initialNow); }
        else validateStoredDatabase(db!, initialNow);
      recoverInterruptedRecovery(db!, initialNow);
      recoverInterruptedHalfOpen(db!);
      validateStoredDatabase(db!, initialNow);
    }); }
    recoveredPendingIds = validateStoredDatabase(db, initialNow).map(row => row.id);
  } catch (error) {
    try { db?.close(); } catch { /* Preserve failed database evidence. */ }
    throw errorCode(error, 'RELEASE_DATABASE_UNAVAILABLE');
  }
  const database = db;
  const recoveredPending = new Set(recoveredPendingIds);
  let lastClock = initialNow, closed = false, poisoned = false;
  let queue: Promise<unknown> = Promise.resolve(), closing: Promise<void> | undefined;
  function serial<T>(operation: () => Promise<T>): Promise<T> { const result = queue.then(operation); queue = result.catch(() => undefined); return result; }
  function time(): number { const current = validateClock(now()); if (current < lastClock) fail('RELEASE_CLOCK_REGRESSION'); lastClock = current; return current; }
  function markPersistenceFailure(error: unknown): never { poisoned = true; throw errorCode(error, 'RELEASE_PERSIST_FAILED'); }
  function isLogicalSettlementError(error: unknown): boolean {
    return error instanceof Error && error.message === 'RELEASE_INVALID_SETTLEMENT';
  }
  function metadata(): Row {
    const row = database.prepare('SELECT cumulative_starts, known_tokens, unknown_count, unknown_admission_ceiling, last_admission, recovery_revision, recovery_covered_revision, recovery_sequence FROM metadata WHERE id = 1').get() as Row | undefined;
    if (!row) fail('RELEASE_SCHEMA_INVALID'); return row;
  }
  function latestRecovery(): Row | undefined {
    return database.prepare('SELECT id, revision, binding, status, trial_reservation_id, usage_state FROM recovery_attempts ORDER BY rowid DESC LIMIT 1').get() as Row | undefined;
  }
  function recoveryStatusFromDatabase(): ReleaseRecoveryStatus {
    const stored = metadata();
    const policy = database.prepare('SELECT failure_count, next_eligible, cooldown_until, cooldown_level, half_open FROM recovery_policy WHERE id = 1').get() as Row | undefined;
    if (!policy) fail('RELEASE_SCHEMA_INVALID');
    const safety = database.prepare('SELECT unsafe_unknown FROM recovery_safety WHERE id = 1').get() as Row | undefined;
    if (!safety) fail('RELEASE_SCHEMA_INVALID');
    const unsafeUnknown = safeInteger(safety.unsafe_unknown) === 1;
    const revision = safeInteger(stored.recovery_revision);
    const covered = safeInteger(stored.recovery_covered_revision);
    const latest = latestRecovery();
    const nextEligibleAt = policy.next_eligible === null ? null : safeInteger(policy.next_eligible);
    const cooldownUntil = policy.cooldown_until === null ? null : safeInteger(policy.cooldown_until);
    const recentUnknown = safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'unknown' AND admitted_at > ?").get(lastClock - HOUR_MS) as Row).count);
    const active = latest !== undefined && latest.revision === revision && ['confirmed', 'trial_reserved', 'trial_settled'].includes(String(latest.status));
    const failed = latest !== undefined && latest.revision === revision && latest.status === 'failed';
    const inCooldown = cooldownUntil !== null && lastClock < cooldownUntil;
    const needsRecovery = recoveredPending.size > 0 || (safeInteger(stored.unknown_count) > 0 && covered < revision) || active || failed;
    const state: ReleaseRecoveryState = unsafeUnknown ? 'blocked' : active
      ? (latest?.status === 'confirmed' ? 'awaiting_confirmation' : 'probing')
      : failed ? 'failed'
        : inCooldown ? 'cooldown'
          : recentUnknown > 0 && needsRecovery ? 'warning'
        : needsRecovery ? 'blocked'
          : latest?.status === 'succeeded' && latest.revision === revision ? 'recovered' : 'normal';
    return {
      state,
      revision,
      knownTokens: safeInteger(stored.known_tokens),
      unknown: safeInteger(stored.unknown_count),
      recoveryAllowed: state === 'warning' || state === 'blocked' || state === 'failed',
      ...(recoveredPending.size > 0 ? {reason: 'unresolved_previous_call' as const} : unsafeUnknown ? {reason: 'unsafe_unknown' as const} : {}),
      nextEligibleAt: inCooldown ? cooldownUntil : nextEligibleAt,
      cooldownUntil,
    };
  }
  function pendingCount(): number { return safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state IN ('pending', 'recovery_trial')").get() as Row).count); }
  function ordinaryAdmissionBlocked(halfOpenAdmission = false): boolean {
    const status = recoveryStatusFromDatabase();
    const policy = database.prepare('SELECT cooldown_until, half_open FROM recovery_policy WHERE id = 1').get() as Row;
    const unresolvedCooldown = policy.cooldown_until !== null && safeInteger(metadata().unknown_count) > safeInteger(metadata().recovery_covered_revision);
    const safety = database.prepare('SELECT unsafe_unknown FROM recovery_safety WHERE id = 1').get() as Row;
    if (safeInteger(safety.unsafe_unknown) === 1) return true;
    if (unresolvedCooldown && !halfOpenAdmission) return true;
    return ['blocked', 'awaiting_confirmation', 'probing', 'failed'].includes(status.state);
  }
  function activeStartCount(): number { return safeInteger((database.prepare('SELECT COUNT(*) AS count FROM admissions WHERE admitted_at > ?').get(lastClock - HOUR_MS) as Row).count); }
  function reserveInTransaction(key: string, current: number, admissionKind: AdmissionKind): string | null {
    database.prepare("DELETE FROM admissions WHERE state IN ('settled','not_dispatched') AND admitted_at <= ? AND id NOT IN (SELECT trial_reservation_id FROM recovery_attempts WHERE trial_reservation_id IS NOT NULL)").run(current - HOUR_MS);
    const stored = metadata(), starts = safeInteger(stored.cumulative_starts), known = safeInteger(stored.known_tokens);
    const policy = database.prepare('SELECT next_eligible, cooldown_until, half_open, half_open_conversation FROM recovery_policy WHERE id = 1').get() as Row;
    const nextEligible = policy.next_eligible === null ? null : safeInteger(policy.next_eligible);
    const cooldownUntil = policy.cooldown_until === null ? null : safeInteger(policy.cooldown_until);
    if (nextEligible !== null && current < nextEligible) return null;
    if (admissionKind === 'half_open' && (safeInteger(policy.half_open) !== 1 || policy.half_open_conversation !== key)) return null;
    if (admissionKind !== 'half_open' && safeInteger(policy.half_open) === 1) return null;
    if (ordinaryAdmissionBlocked(admissionKind === 'half_open') || recoveredPending.size > 0 || pendingCount() >= MAX_IN_FLIGHT || starts >= MAX_SAFE || known > MAX_SAFE - MAX_TOKENS_PER_FIELD * 2 * MAX_IN_FLIGHT) return null;
    if (safeInteger((database.prepare('SELECT COUNT(*) AS count FROM admissions').get() as Row).count) >= MAX_ROWS) return null;
    if (safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'pending' AND conversation = ?").get(key) as Row).count) > 0) return null;
    const id = randomUUID();
    database.prepare("INSERT INTO admissions (id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens, settlement_classification) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 'legacy')").run(id, starts + 1, key, current, MAX_TOKENS_PER_FIELD, MAX_TOKENS_PER_FIELD, MAX_TOKENS_PER_FIELD);
    const unresolvedUnknown = safeInteger(stored.unknown_count) > safeInteger(stored.recovery_covered_revision);
    const unknownCeiling = unresolvedUnknown ? starts + 1 : stored.unknown_admission_ceiling === null ? null : safeInteger(stored.unknown_admission_ceiling);
    database.prepare('UPDATE metadata SET cumulative_starts = ?, last_admission = ?, unknown_admission_ceiling = ? WHERE id = 1')
      .run(starts + 1, current, unknownCeiling);
    return id;
  }
  function createView(key: string): SubscriptionAccounting {
    const view = {key, closed: false, pending: new Set<Promise<unknown>>(), closing: undefined as Promise<void> | undefined};
    function track<T>(operation: Promise<T>): Promise<T> { view.pending.add(operation); operation.finally(() => view.pending.delete(operation)).catch(() => undefined); return operation; }
    return {
      reserve(admissionKind: AdmissionKind = 'ordinary'): Promise<string | null> {
        if (closed || view.closed) return Promise.resolve(null);
        return track(serial(async () => {
          if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
          const current = time();
          try { const id = transaction(database, () => reserveInTransaction(key, current, admissionKind)); if (id) recoveredPending.delete(id); return id; }
          catch (error) { return markPersistenceFailure(error); }
        }));
      },
      settle(id: string, inputUsage: AccountedUsage | null, classification: SettlementClassification = inputUsage === null ? 'unsafe_unknown' : 'known_success'): Promise<void> {
        if (closed) return Promise.reject(new Error('RELEASE_OWNER_CLOSED'));
        if (view.closed) return Promise.reject(new Error('RELEASE_VIEW_CLOSED'));
        let copiedId: string, copiedUsage: Usage | null;
        try {
          copiedId = z.string().uuid().parse(id);
          copiedUsage = inputUsage === null ? null : usageSchema.parse({...inputUsage});
          if (!['known_success', 'known_non_success', 'safe_unknown', 'unsafe_unknown'].includes(classification)) fail('RELEASE_USAGE_INVALID');
          if (copiedUsage === null && !['safe_unknown', 'unsafe_unknown'].includes(classification)) fail('RELEASE_USAGE_INVALID');
          if (copiedUsage !== null && !['known_success', 'known_non_success'].includes(classification)) fail('RELEASE_USAGE_INVALID');
        }
        catch { return Promise.reject(new Error('RELEASE_USAGE_INVALID')); }
        return track(serial(async () => {
          if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
          try {
            transaction(database, () => {
              const row = database.prepare('SELECT conversation, state FROM admissions WHERE id = ?').get(copiedId) as Row | undefined;
              if (!row || row.state !== 'pending' || row.conversation !== key) fail('RELEASE_INVALID_SETTLEMENT');
              if (copiedUsage === null) {
                database.prepare("UPDATE admissions SET state = 'unknown', settlement_classification = ? WHERE id = ?").run(classification, copiedId);
                const stored = metadata(), current = safeInteger(stored.unknown_count), starts = safeInteger(stored.cumulative_starts), revision = safeInteger(stored.recovery_revision);
                if (current >= MAX_SAFE || starts <= 0 || revision >= MAX_SAFE) fail('RELEASE_COUNTER_OVERFLOW');
                database.prepare('UPDATE metadata SET unknown_count = ?, recovery_revision = ?, unknown_admission_ceiling = ? WHERE id = 1').run(current + 1, revision + 1, starts);
                const at = time();
                const recentUnknown = safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'unknown' AND admitted_at > ?").get(at - HOUR_MS) as Row).count);
                const policy = database.prepare('SELECT cooldown_level, half_open FROM recovery_policy WHERE id = 1').get() as Row;
                if (classification === 'unsafe_unknown') {
                  database.prepare('UPDATE recovery_safety SET unsafe_unknown = 1 WHERE id = 1').run();
                  database.prepare('UPDATE recovery_policy SET next_eligible = NULL, cooldown_until = NULL, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run();
                } else if (safeInteger(policy.half_open) === 1) {
                  const level = Math.min(2, safeInteger(policy.cooldown_level) + 1);
                  const delay = [300_000, 900_000, 3_600_000][level]!;
                  database.prepare('UPDATE recovery_policy SET cooldown_until = ?, next_eligible = ?, cooldown_level = ?, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run(at + delay, at + delay, level);
                } else if (recentUnknown >= 3) database.prepare('UPDATE recovery_policy SET cooldown_until = ?, next_eligible = ?, cooldown_level = 0, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run(at + 300_000, at + 300_000);
              } else {
                const current = safeInteger(metadata().known_tokens), total = copiedUsage.inputTokens + copiedUsage.outputTokens;
                if (current > MAX_SAFE - total) fail('RELEASE_COUNTER_OVERFLOW');
                database.prepare("UPDATE admissions SET state = 'settled', settlement_classification = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ? WHERE id = ?").run(classification, copiedUsage.inputTokens, copiedUsage.outputTokens, copiedUsage.cachedInputTokens ?? 0, copiedId);
                database.prepare('UPDATE metadata SET known_tokens = ? WHERE id = 1').run(current + total);
                const policy = database.prepare('SELECT half_open, cooldown_level FROM recovery_policy WHERE id = 1').get() as Row;
                if (classification === 'known_success') {
                  if (safeInteger(policy.half_open) === 1) database.prepare('UPDATE recovery_policy SET failure_count = 0, next_eligible = NULL, cooldown_until = NULL, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run();
                  else database.prepare('UPDATE recovery_policy SET failure_count = 0, next_eligible = NULL WHERE id = 1').run();
                } else if (safeInteger(policy.half_open) === 1) {
                  const level = Math.min(2, safeInteger(policy.cooldown_level) + 1);
                  const delay = [300_000, 900_000, 3_600_000][level]!;
                  database.prepare('UPDATE recovery_policy SET cooldown_until = ?, next_eligible = ?, cooldown_level = ?, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run(time() + delay, time() + delay, level);
                }
              }
            });
            recoveredPending.delete(copiedId);
          } catch (error) {
            if (isLogicalSettlementError(error)) throw error;
            markPersistenceFailure(error);
          }
        }));
      },
      cancelBeforeDispatch(id:string):Promise<void> {
        if(closed)return Promise.reject(new Error('RELEASE_OWNER_CLOSED'));
        if(view.closed)return Promise.reject(new Error('RELEASE_VIEW_CLOSED'));
        let copiedId:string;try{copiedId=z.string().uuid().parse(id);}catch{return Promise.reject(new Error('RELEASE_USAGE_INVALID'));}
        return track(serial(async()=>{
          if(poisoned)throw new Error('RELEASE_DATABASE_UNAVAILABLE');
          try{transaction(database,()=>{
            const row=database.prepare('SELECT conversation,state FROM admissions WHERE id=?').get(copiedId) as Row|undefined;
            if(!row||row.state!=='pending'||row.conversation!==key||recoveredPending.has(copiedId))fail('RELEASE_INVALID_SETTLEMENT');
            database.prepare("UPDATE admissions SET state='not_dispatched', settlement_classification='not_dispatched' WHERE id=?").run(copiedId);
            const policy = database.prepare('SELECT half_open, half_open_conversation FROM recovery_policy WHERE id = 1').get() as Row;
            if (safeInteger(policy.half_open) === 1 && policy.half_open_conversation === key)
              database.prepare('UPDATE recovery_policy SET half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run();
          });}catch(error){if(isLogicalSettlementError(error))throw error;markPersistenceFailure(error);}
        }));
      },
      releaseRecoveryAdmission(): Promise<void> {
        if (closed) return Promise.reject(new Error('RELEASE_OWNER_CLOSED'));
        if (view.closed) return Promise.reject(new Error('RELEASE_VIEW_CLOSED'));
        return track(serial(async () => {
          if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
          try {
            transaction(database, () => {
              const policy = database.prepare('SELECT half_open, half_open_conversation, half_open_claim_after_ordinal FROM recovery_policy WHERE id = 1').get() as Row | undefined;
              if (!policy || safeInteger(policy.half_open) !== 1 || policy.half_open_conversation !== key || policy.half_open_claim_after_ordinal === null) return;
              const claimAfterOrdinal = safeInteger(policy.half_open_claim_after_ordinal);
              const postClaim = database.prepare('SELECT id FROM admissions WHERE conversation = ? AND ordinal > ? LIMIT 1').get(key, claimAfterOrdinal) as Row | undefined;
              if (postClaim !== undefined) return;
              database.prepare('UPDATE recovery_policy SET half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run();
            });
          } catch (error) { markPersistenceFailure(error); }
        }));
      },
      close(): Promise<void> { if (view.closing) return view.closing; view.closed = true; view.closing = Promise.all([...view.pending]).then(() => undefined); return view.closing; },
    };
  }
  function copyBinding(value: unknown): string {
    const parsed = recoveryBinding.safeParse(value);
    if (!parsed.success) fail('RELEASE_RECOVERY_INVALID');
    return parsed.data;
  }
  function copyAttempt(value: unknown): string {
    const parsed = recoveryAttemptId.safeParse(value);
    if (!parsed.success) fail('RELEASE_RECOVERY_INVALID');
    return parsed.data;
  }
  function recoveryOperationError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('RELEASE_RECOVERY_');
  }
  async function preflightRecovery(bindingValue: string): Promise<ReleaseRecoveryPreflight> {
    const binding = copyBinding(bindingValue);
    return serial(async () => {
      const status = recoveryStatusFromDatabase();
      return {...status, allowed: (status.recoveryAllowed || status.state === 'warning') && binding.length > 0};
    });
  }
  async function confirmRecovery(input: {revision: number; binding: string}): Promise<ReleaseRecoveryConfirmation> {
    const revision = safeInteger(input?.revision, 'RELEASE_RECOVERY_INVALID');
    const binding = copyBinding(input?.binding);
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        const result = transaction(database, () => {
          const status = recoveryStatusFromDatabase();
          if (status.revision !== revision) fail('RELEASE_RECOVERY_STALE');
          if (!status.recoveryAllowed && status.state !== 'warning') fail('RELEASE_RECOVERY_NOT_ALLOWED');
          const attemptId = randomUUID();
          const now = time();
          database.prepare('INSERT INTO recovery_attempts (id, revision, binding, status, trial_reservation_id, usage_state, created_at, updated_at) VALUES (?, ?, ?, \'confirmed\', NULL, \'none\', ?, ?)')
            .run(attemptId, revision, binding, now, now);
          appendRecoveryEvent(database, attemptId, revision, 'confirmed', now);
          return {attemptId, revision, binding};
        });
        return result;
      } catch (error) {
        if (recoveryOperationError(error)) throw error;
        return markPersistenceFailure(error);
      }
    });
  }
  async function reserveRecoveryTrial(confirmation: ReleaseRecoveryConfirmation): Promise<string | null> {
    const attemptId = copyAttempt(confirmation?.attemptId);
    const revision = safeInteger(confirmation?.revision, 'RELEASE_RECOVERY_INVALID');
    const binding = copyBinding(confirmation?.binding);
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        return transaction(database, () => {
          const attempt = database.prepare('SELECT revision, binding, status, trial_reservation_id FROM recovery_attempts WHERE id = ?').get(attemptId) as Row | undefined;
          const stored = metadata();
          if (!attempt || safeInteger(attempt.revision) !== revision || attempt.binding !== binding || safeInteger(stored.recovery_revision) !== revision) fail('RELEASE_RECOVERY_STALE');
          if (attempt.status !== 'confirmed') return null;
          if (pendingCount() >= MAX_IN_FLIGHT || safeInteger(stored.cumulative_starts) >= MAX_SAFE) return null;
          if (safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE conversation = '__recovery_trial__' AND admitted_at > ?").get(time() - HOUR_MS) as Row).count) >= MAX_RECOVERY_TRIALS_PER_HOUR) return null;
          if (safeInteger((database.prepare('SELECT COUNT(*) AS count FROM admissions').get() as Row).count) >= MAX_ROWS) return null;
          const reservationId = randomUUID();
          const now = time();
          const starts = safeInteger(stored.cumulative_starts);
          database.prepare("INSERT INTO admissions (id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens, settlement_classification, recovery_attempt_id) VALUES (?, ?, ?, ?, 'recovery_trial', ?, ?, ?, 'legacy', ?)")
            .run(reservationId, starts + 1, '__recovery_trial__', now, MAX_TOKENS_PER_FIELD, MAX_TOKENS_PER_FIELD, MAX_TOKENS_PER_FIELD, attemptId);
          database.prepare('UPDATE metadata SET cumulative_starts = ?, last_admission = ? WHERE id = 1').run(starts + 1, now);
          database.prepare("UPDATE recovery_attempts SET status = 'trial_reserved', trial_reservation_id = ?, updated_at = ? WHERE id = ?")
            .run(reservationId, now, attemptId);
          appendRecoveryEvent(database, attemptId, revision, 'trial_reserved', now);
          return reservationId;
        });
      } catch (error) {
        if (recoveryOperationError(error)) throw error;
        return markPersistenceFailure(error);
      }
    });
  }
  async function settleRecoveryTrial(attemptValue: string, reservationValue: string, inputUsage: AccountedUsage | null): Promise<void> {
    const attemptId = copyAttempt(attemptValue);
    const reservationId = copyAttempt(reservationValue);
    let copiedUsage: Usage | null;
    try { copiedUsage = inputUsage === null ? null : usageSchema.parse({...inputUsage}); }
    catch { throw new Error('RELEASE_USAGE_INVALID'); }
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        transaction(database, () => {
          const attempt = database.prepare('SELECT revision, status, trial_reservation_id FROM recovery_attempts WHERE id = ?').get(attemptId) as Row | undefined;
          const row = database.prepare('SELECT state, recovery_attempt_id FROM admissions WHERE id = ?').get(reservationId) as Row | undefined;
          if (!attempt || attempt.status !== 'trial_reserved' || attempt.trial_reservation_id !== reservationId || !row || row.state !== 'recovery_trial' || row.recovery_attempt_id !== attemptId) fail('RELEASE_RECOVERY_INVALID');
          const currentRevision = safeInteger((metadata()).recovery_revision);
          if (copiedUsage === null) {
            const stored = metadata(), unknown = safeInteger(stored.unknown_count);
            if (unknown >= MAX_SAFE || currentRevision >= MAX_SAFE) fail('RELEASE_COUNTER_OVERFLOW');
            database.prepare("UPDATE admissions SET state = 'unknown', settlement_classification = 'unsafe_unknown', recovery_attempt_id = NULL WHERE id = ?").run(reservationId);
            database.prepare('UPDATE metadata SET unknown_count = ?, recovery_revision = ?, unknown_admission_ceiling = ? WHERE id = 1')
              .run(unknown + 1, currentRevision + 1, safeInteger(stored.cumulative_starts));
            const now = time();
            database.prepare("UPDATE recovery_attempts SET status = 'trial_settled', usage_state = 'unknown', updated_at = ? WHERE id = ?").run(now, attemptId);
            appendRecoveryEvent(database, attemptId, currentRevision + 1, 'trial_settled', now);
          } else {
            const currentKnown = safeInteger(metadata().known_tokens), total = copiedUsage.inputTokens + copiedUsage.outputTokens;
            if (currentKnown > MAX_SAFE - total) fail('RELEASE_COUNTER_OVERFLOW');
            database.prepare("UPDATE admissions SET state = 'settled', settlement_classification = 'known_success', input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, recovery_attempt_id = NULL WHERE id = ?")
              .run(copiedUsage.inputTokens, copiedUsage.outputTokens, copiedUsage.cachedInputTokens ?? 0, reservationId);
            database.prepare('UPDATE metadata SET known_tokens = ? WHERE id = 1').run(currentKnown + total);
            const now = time();
            database.prepare("UPDATE recovery_attempts SET status = 'trial_settled', usage_state = 'known', updated_at = ? WHERE id = ?").run(now, attemptId);
            appendRecoveryEvent(database, attemptId, currentRevision, 'trial_settled', now);
          }
        });
      } catch (error) {
        if (recoveryOperationError(error)) throw error;
        return markPersistenceFailure(error);
      }
    });
  }
  async function finishRecovery(attemptValue: string, result: {success: boolean; closureConfirmed: boolean}): Promise<void> {
    const attemptId = copyAttempt(attemptValue);
    const success = result?.success === true;
    const closureConfirmed = result?.closureConfirmed === true;
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      let failure: string | undefined;
      try {
        transaction(database, () => {
          const attempt = database.prepare('SELECT revision, status, usage_state FROM recovery_attempts WHERE id = ?').get(attemptId) as Row | undefined;
          const stored = metadata();
          const revision = safeInteger(stored.recovery_revision);
          const now = time();
          if (!attempt || attempt.status !== 'trial_settled') fail('RELEASE_RECOVERY_INVALID');
          if (!success) {
            database.prepare("UPDATE recovery_attempts SET status = 'failed', updated_at = ? WHERE id = ?").run(now, attemptId);
            appendRecoveryEvent(database, attemptId, revision, 'failed', now);
            return;
          }
          if (!closureConfirmed || attempt.usage_state !== 'known' || safeInteger(attempt.revision) !== revision) {
            database.prepare("UPDATE recovery_attempts SET status = 'failed', updated_at = ? WHERE id = ?").run(now, attemptId);
            appendRecoveryEvent(database, attemptId, revision, 'failed', now);
            failure = 'RELEASE_RECOVERY_FAILED';
            return;
          }
          database.prepare("UPDATE recovery_attempts SET status = 'succeeded', updated_at = ? WHERE id = ?").run(now, attemptId);
          database.prepare('UPDATE metadata SET recovery_covered_revision = ? WHERE id = 1').run(revision);
          database.prepare('UPDATE recovery_safety SET unsafe_unknown = 0 WHERE id = 1').run();
          appendRecoveryEvent(database, attemptId, revision, 'succeeded', now);
        });
      } catch (error) {
        if (recoveryOperationError(error)) throw error;
        return markPersistenceFailure(error);
      }
      if (failure) throw new Error(failure);
    });
  }
  async function cancelRecoveryTrial(attemptValue: string, reservationValue: string): Promise<void> {
    const attemptId = copyAttempt(attemptValue);
    const reservationId = copyAttempt(reservationValue);
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        transaction(database, () => {
          const attempt = database.prepare('SELECT revision, status, trial_reservation_id FROM recovery_attempts WHERE id = ?').get(attemptId) as Row | undefined;
          const row = database.prepare('SELECT state, recovery_attempt_id FROM admissions WHERE id = ?').get(reservationId) as Row | undefined;
          if (!attempt || attempt.status !== 'trial_reserved' || attempt.trial_reservation_id !== reservationId || row?.state !== 'recovery_trial' || row.recovery_attempt_id !== attemptId) fail('RELEASE_RECOVERY_INVALID');
          const now = time();
          database.prepare("UPDATE admissions SET state = 'not_dispatched', settlement_classification = 'not_dispatched', recovery_attempt_id = NULL WHERE id = ?").run(reservationId);
          database.prepare("UPDATE recovery_attempts SET status = 'failed', updated_at = ? WHERE id = ?").run(now, attemptId);
          appendRecoveryEvent(database, attemptId, safeInteger(attempt.revision), 'cancelled', now);
        });
      } catch (error) {
        if (recoveryOperationError(error)) throw error;
        return markPersistenceFailure(error);
      }
    });
  }
  async function cancelRecovery(attemptValue: string): Promise<void> {
    const attemptId = copyAttempt(attemptValue);
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        transaction(database, () => {
          const attempt = database.prepare('SELECT revision, status FROM recovery_attempts WHERE id = ?').get(attemptId) as Row | undefined;
          if (!attempt || attempt.status !== 'confirmed') fail('RELEASE_RECOVERY_INVALID');
          const now = time();
          database.prepare("UPDATE recovery_attempts SET status = 'failed', updated_at = ? WHERE id = ?").run(now, attemptId);
          appendRecoveryEvent(database, attemptId, safeInteger(attempt.revision), 'cancelled', now);
        });
      } catch (error) {
        if (recoveryOperationError(error)) throw error;
        return markPersistenceFailure(error);
      }
    });
  }
  async function recoveryAdmission(currentValue: number, eligibleTask: boolean, conversationValue?: string): Promise<ReleaseRecoveryAdmission> {
    const current = validateClock(currentValue);
    const conversation = conversationValue === undefined ? undefined : conversationKey.safeParse(conversationValue).success ? conversationValue : fail('RELEASE_CONVERSATION_KEY_INVALID');
    return serial(async () => {
      if (!eligibleTask) return {allowed: false, kind: 'ordinary', nextEligibleAt: null, reason: 'no_eligible_task'};
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        return transaction(database, () => {
          if (recoveredPending.size > 0) return {allowed: false, kind: 'ordinary', nextEligibleAt: null, reason: 'unresolved_previous_call' as const};
          const safety = database.prepare('SELECT unsafe_unknown FROM recovery_safety WHERE id = 1').get() as Row;
          if (safeInteger(safety.unsafe_unknown) === 1) return {allowed: false, kind: 'ordinary', nextEligibleAt: null, reason: 'unsafe_unknown'};
          const policy = database.prepare('SELECT failure_count, next_eligible, cooldown_until, cooldown_level, half_open FROM recovery_policy WHERE id = 1').get() as Row;
          const cooldownUntil = policy.cooldown_until === null ? null : safeInteger(policy.cooldown_until);
          const nextEligibleAt = policy.next_eligible === null ? null : safeInteger(policy.next_eligible);
          if (safeInteger(policy.half_open) === 1) return {allowed: false, kind: 'half_open', nextEligibleAt: cooldownUntil, reason: 'half_open_busy'};
          if (cooldownUntil !== null) {
            if (current < cooldownUntil) return {allowed: false, kind: 'half_open', nextEligibleAt: cooldownUntil, reason: 'cooldown'};
            if (safeInteger(metadata().unknown_count) > safeInteger(metadata().recovery_covered_revision) && conversation !== undefined) {
              const claimAfterOrdinal = safeInteger(metadata().cumulative_starts);
              database.prepare('UPDATE recovery_policy SET half_open = 1, half_open_conversation = ?, half_open_claim_after_ordinal = ? WHERE id = 1').run(conversation, claimAfterOrdinal);
              return {allowed: true, kind: 'half_open', nextEligibleAt: null};
            }
            if (safeInteger(metadata().unknown_count) > safeInteger(metadata().recovery_covered_revision)) return {allowed: false, kind: 'half_open', nextEligibleAt: cooldownUntil, reason: 'no_eligible_task'};
          }
          if (nextEligibleAt !== null && current < nextEligibleAt) return {allowed: false, kind: 'retry', nextEligibleAt, reason: 'retry_backoff'};
          return {allowed: true, kind: safeInteger(policy.failure_count) > 0 ? 'retry' : 'ordinary', nextEligibleAt: null};
        });
      } catch (error) { return markPersistenceFailure(error); }
    });
  }
  async function reconcileRecoveredPending(inputProof: RecoveryBootBoundaryProof): Promise<number> {
    const proof = parseRecoveryBootBoundaryProof(inputProof);
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        const current = time();
        const reconciled = transaction(database, () => {
          if (proof.observedAt > current || current - proof.observedAt > RECOVERY_BOOT_PROOF_MAX_AGE_MS) fail('RELEASE_RECOVERY_INVALID');
          if (recoveredPending.size === 0) return 0;
          const ids = [...recoveredPending];
          const rows = database.prepare(`SELECT id, admitted_at, state FROM admissions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
          if (rows.length !== ids.length || rows.some(row => typeof row.id !== 'string' || row.state !== 'pending' || !recoveredPending.has(row.id))) fail('RELEASE_RECOVERY_INVALID');
          if (rows.some(row => !Number.isSafeInteger(row.admitted_at) || Number(row.admitted_at) >= proof.bootAt - RECOVERY_BOOT_BOUNDARY_MARGIN_MS)) fail('RELEASE_RECOVERY_INVALID');
          const stored = metadata();
          const unknown = safeInteger(stored.unknown_count), revision = safeInteger(stored.recovery_revision), starts = safeInteger(stored.cumulative_starts);
          if (unknown > MAX_SAFE - rows.length || revision > MAX_SAFE - rows.length) fail('RELEASE_COUNTER_OVERFLOW');
          for (const row of rows) database.prepare("UPDATE admissions SET state = 'unknown', settlement_classification = 'safe_unknown', recovery_attempt_id = NULL WHERE id = ?").run(String(row.id));
          database.prepare('UPDATE metadata SET unknown_count = ?, recovery_revision = ?, unknown_admission_ceiling = ? WHERE id = 1')
            .run(unknown + rows.length, revision + rows.length, starts);
          database.prepare('UPDATE recovery_safety SET unsafe_unknown = 1 WHERE id = 1').run();
          return rows.length;
        });
        if (reconciled > 0) for (const id of recoveredPending) recoveredPending.delete(id);
        return reconciled;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('RELEASE_RECOVERY_')) throw error;
        return markPersistenceFailure(error);
      }
    });
  }
  async function recordRecoveryEvent(event: ReleaseRecoveryEvent): Promise<void> {
    const at = validateClock(event?.at);
    return serial(async () => {
      if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
      try {
        transaction(database, () => {
          const policy = database.prepare('SELECT failure_count, next_eligible, cooldown_level, half_open FROM recovery_policy WHERE id = 1').get() as Row;
          const failures = safeInteger(policy.failure_count), level = safeInteger(policy.cooldown_level), halfOpen = safeInteger(policy.half_open) === 1;
          if (event.kind === 'known_success' || event.kind === 'half_open_success') {
            database.prepare('UPDATE recovery_policy SET failure_count = 0, next_eligible = NULL, cooldown_until = NULL, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run();
          } else if (event.kind === 'recoverable_failure' || event.kind === 'half_open_failure') {
            const nextLevel = Math.min(2, level + 1);
            if (event.kind === 'half_open_failure' || halfOpen || failures >= 2) {
              const delay = event.kind === 'half_open_failure' ? [300_000, 900_000, 3_600_000][nextLevel]! : 300_000;
              const cooldownLevel = event.kind === 'half_open_failure' ? nextLevel : 0;
              database.prepare('UPDATE recovery_policy SET failure_count = ?, next_eligible = NULL, cooldown_until = ?, cooldown_level = ?, half_open = 0, half_open_conversation = NULL, half_open_claim_after_ordinal = NULL WHERE id = 1').run(Math.min(3, failures + 1), at + delay, cooldownLevel);
            } else {
              const delay = failures === 0 ? 10_000 : 30_000;
              database.prepare('UPDATE recovery_policy SET failure_count = ?, next_eligible = ?, half_open = 0 WHERE id = 1').run(failures + 1, at + delay);
            }
          }
        });
      } catch (error) { return markPersistenceFailure(error); }
    });
  }
  return {
    forConversation(key: string): SubscriptionAccounting { const parsed = conversationKey.safeParse(key); if (!parsed.success || parsed.data === '__recovery_trial__') fail('RELEASE_CONVERSATION_KEY_INVALID'); return createView(parsed.data); },
    snapshot(): ReleaseAccountingSnapshot { const stored = metadata(); return {starts: safeInteger(stored.cumulative_starts), activeStarts: activeStartCount(), inFlight: pendingCount(), unresolved: pendingCount(), knownTokens: safeInteger(stored.known_tokens), unknown: safeInteger(stored.unknown_count), poisoned}; },
    recoveryStatus(): ReleaseRecoveryStatus { return recoveryStatusFromDatabase(); },
    preflightRecovery,
    confirmRecovery,
    reserveRecoveryTrial,
    settleRecoveryTrial,
    finishRecovery,
    cancelRecoveryTrial,
    cancelRecovery,
    recoveryAdmission,
    reconcileRecoveredPending,
    releaseRecoveryAdmission(conversationKeyValue: string): Promise<void> {
      const parsed = conversationKey.safeParse(conversationKeyValue);
      if (!parsed.success || parsed.data === '__recovery_trial__') fail('RELEASE_CONVERSATION_KEY_INVALID');
      return createView(parsed.data).releaseRecoveryAdmission!();
    },
    recordRecoveryEvent,
    close(): Promise<void> { if (closing) return closing; closed = true; closing = queue.then(() => { try { database.close(); } catch { throw new Error('RELEASE_CLOSE_FAILED'); } }); return closing; },
  } satisfies ReleaseAccountingOwner;
}
