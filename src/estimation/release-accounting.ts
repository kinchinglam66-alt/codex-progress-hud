import {access, open as openFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import type {AccountedUsage, SubscriptionAccounting} from './subscription-accounting.js';

const HOUR_MS = 3_600_000;
const MAX_IN_FLIGHT = 2;
const MAX_STARTS_PER_CONVERSATION = 12;
const MAX_ROWS = 4_096;
const PAGE_SIZE = 4_096;
const MAX_PAGE_COUNT = 2_048;
const MAX_TOKENS_PER_FIELD = 1_000_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SCHEMA_VERSION = 3;
const DB_NAME = 'release-observer-accounting.sqlite';
const LEGACY_FILES = ['release-observer-accounting.jsonl', 'release-observer-accounting.lock'];
const conversationKey = z.string().min(1).max(512);
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
  close(): Promise<void>;
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
      unknown_admission_ceiling INTEGER, last_admission INTEGER
    );
    CREATE TABLE admissions (
      id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal > 0), conversation TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'unknown', 'not_dispatched')),
      input_tokens INTEGER NOT NULL CHECK (input_tokens BETWEEN 0 AND 1000000000),
      output_tokens INTEGER NOT NULL CHECK (output_tokens BETWEEN 0 AND 1000000000),
      cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens BETWEEN 0 AND 1000000000 AND cached_input_tokens <= input_tokens)
    );
    CREATE INDEX admissions_conversation_time ON admissions(conversation, admitted_at);
    CREATE INDEX admissions_state_time ON admissions(state, admitted_at);
    INSERT INTO metadata VALUES (1, ${SCHEMA_VERSION}, 0, 0, 0, NULL, NULL);
    PRAGMA user_version=${SCHEMA_VERSION};
  `);
}
function validateColumns(db: Database, table: string, expected: readonly string[]): void {
  const actual = new Set<string>();
  for (const row of db.prepare(`PRAGMA table_info(${table})`).iterate() as Iterable<Row>) if (typeof row.name === 'string') actual.add(row.name);
  if (expected.some(column => !actual.has(column))) fail('RELEASE_SCHEMA_INVALID');
}
function validateStoredDatabase(db: Database, initialNow: number,expectedVersion=SCHEMA_VERSION): PendingReservation[] {
  if (pragmaNumber(db, 'PRAGMA user_version', 'user_version') !== expectedVersion || pragmaNumber(db, 'PRAGMA page_count', 'page_count') > MAX_PAGE_COUNT) fail('RELEASE_SCHEMA_INVALID');
  if (value(db.prepare('PRAGMA integrity_check').get() as Row, 'integrity_check') !== 'ok') fail('RELEASE_SCHEMA_INVALID');
  validateColumns(db, 'metadata', ['id', 'version', 'cumulative_starts', 'known_tokens', 'unknown_count', 'unknown_admission_ceiling', 'last_admission']);
  validateColumns(db, 'admissions', ['id', 'ordinal', 'conversation', 'admitted_at', 'state', 'input_tokens', 'output_tokens', 'cached_input_tokens']);
  const metadata = db.prepare('SELECT id, version, cumulative_starts, known_tokens, unknown_count, unknown_admission_ceiling, last_admission FROM metadata').all() as Row[];
  if (metadata.length !== 1 || metadata[0]!.id !== 1 || metadata[0]!.version !== expectedVersion) fail('RELEASE_SCHEMA_INVALID');
  const cumulativeStarts = safeInteger(metadata[0]!.cumulative_starts);
  const knownTokens = safeInteger(metadata[0]!.known_tokens);
  const unknownCount = safeInteger(metadata[0]!.unknown_count);
  const unknownCeiling = metadata[0]!.unknown_admission_ceiling === null ? null : safeInteger(metadata[0]!.unknown_admission_ceiling);
  const lastAdmission = metadata[0]!.last_admission === null ? null : safeInteger(metadata[0]!.last_admission);
  if (lastAdmission !== null && initialNow < lastAdmission) fail('RELEASE_CLOCK_REGRESSION');
  const pending: PendingReservation[] = [];
  const pendingConversations = new Set<string>();
  const recentCounts = new Map<string, number>();
  let rowCount = 0, unknownRows = 0, rowKnownTokens = 0, maximumAdmission: number | null = null, maximumOrdinal = 0;
  for (const row of db.prepare('SELECT id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens FROM admissions ORDER BY ordinal').iterate() as Iterable<Row>) {
    rowCount++;
    if (rowCount > MAX_ROWS) fail('RELEASE_SCHEMA_INVALID');
    const id = z.string().uuid().safeParse(row.id), ordinal = clockValue.safeParse(row.ordinal), conversation = conversationKey.safeParse(row.conversation), admittedAt = clockValue.safeParse(row.admitted_at);
    if (!id.success || !ordinal.success || !conversation.success || !admittedAt.success || !['pending', 'settled', 'unknown',...(expectedVersion>=3?['not_dispatched']:[])].includes(String(row.state))) fail('RELEASE_SCHEMA_INVALID');
    if (ordinal.data > maximumOrdinal) maximumOrdinal = ordinal.data;
    const inputTokens = safeInteger(row.input_tokens), outputTokens = safeInteger(row.output_tokens), cachedInputTokens = safeInteger(row.cached_input_tokens);
    if (inputTokens > MAX_TOKENS_PER_FIELD || outputTokens > MAX_TOKENS_PER_FIELD || cachedInputTokens > MAX_TOKENS_PER_FIELD || cachedInputTokens > inputTokens) fail('RELEASE_SCHEMA_INVALID');
    const state = String(row.state);
    if (state !== 'settled' && (inputTokens !== MAX_TOKENS_PER_FIELD || outputTokens !== MAX_TOKENS_PER_FIELD || cachedInputTokens !== MAX_TOKENS_PER_FIELD)) fail('RELEASE_SCHEMA_INVALID');
    if (state === 'pending') {
      if (pending.length >= MAX_IN_FLIGHT || pendingConversations.has(conversation.data)) fail('RELEASE_SCHEMA_INVALID');
      pending.push({id: id.data, conversation: conversation.data}); pendingConversations.add(conversation.data);
    } else if (state === 'unknown') unknownRows++;
    else if(state==='settled')rowKnownTokens += inputTokens + outputTokens;
    if (admittedAt.data > initialNow - HOUR_MS) {
      const count = (recentCounts.get(conversation.data) ?? 0) + 1;
      if (count > MAX_STARTS_PER_CONVERSATION) fail('RELEASE_SCHEMA_INVALID');
      recentCounts.set(conversation.data, count);
    }
    if (maximumAdmission === null || admittedAt.data > maximumAdmission) maximumAdmission = admittedAt.data;
  }
  if (cumulativeStarts < rowCount || unknownCount !== unknownRows || knownTokens < rowKnownTokens ||
      maximumOrdinal > cumulativeStarts ||
      (unknownCount === 0 ? unknownCeiling !== null : unknownCeiling === null || unknownCeiling !== cumulativeStarts || unknownCeiling < maximumOrdinal) ||
      (cumulativeStarts === 0 ? lastAdmission !== null : lastAdmission === null) ||
      (maximumAdmission !== null && lastAdmission !== null && maximumAdmission > lastAdmission)) fail('RELEASE_SCHEMA_INVALID');
  if (unknownCeiling !== null && safeInteger((db.prepare('SELECT COUNT(*) AS count FROM admissions WHERE ordinal > ?').get(unknownCeiling) as Row).count) > 0) fail('RELEASE_SCHEMA_INVALID');
  const expectedPending = db.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'pending'").get() as Row;
  if (safeInteger(expectedPending.count) !== pending.length) fail('RELEASE_SCHEMA_INVALID');
  return pending;
}
function errorCode(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.startsWith('RELEASE_')) return error;
  return new Error(fallback);
}

/** Called only under exclusive transaction after complete validation of v2. */
function migrateVersion2(db:Database,initialNow:number):void {
  validateStoredDatabase(db,initialNow,2);
  db.exec(`ALTER TABLE metadata RENAME TO metadata_v2;
    ALTER TABLE admissions RENAME TO admissions_v2;
    DROP INDEX admissions_conversation_time;DROP INDEX admissions_state_time;`);
  createSchema(db);
  db.exec(`DELETE FROM metadata;
    INSERT INTO metadata SELECT id,3,cumulative_starts,known_tokens,unknown_count,unknown_admission_ceiling,last_admission FROM metadata_v2;
    INSERT INTO admissions SELECT id,ordinal,conversation,admitted_at,state,input_tokens,output_tokens,cached_input_tokens FROM admissions_v2;
    DROP TABLE admissions_v2;DROP TABLE metadata_v2;`);
  validateStoredDatabase(db,initialNow);
}

export async function openReleaseAccounting(directory: string, now: () => number): Promise<ReleaseAccountingOwner> {
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
      if(pragmaNumber(db!,'PRAGMA user_version','user_version')===2)migrateVersion2(db!,initialNow);
      else validateStoredDatabase(db!, initialNow);
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
    const row = database.prepare('SELECT cumulative_starts, known_tokens, unknown_count, unknown_admission_ceiling, last_admission FROM metadata WHERE id = 1').get() as Row | undefined;
    if (!row) fail('RELEASE_SCHEMA_INVALID'); return row;
  }
  function pendingCount(): number { return safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'pending'").get() as Row).count); }
  function activeStartCount(): number { return safeInteger((database.prepare('SELECT COUNT(*) AS count FROM admissions WHERE admitted_at > ?').get(lastClock - HOUR_MS) as Row).count); }
  function reserveInTransaction(key: string, current: number): string | null {
    database.prepare("DELETE FROM admissions WHERE state IN ('settled','not_dispatched') AND admitted_at <= ?").run(current - HOUR_MS);
    const stored = metadata(), starts = safeInteger(stored.cumulative_starts), known = safeInteger(stored.known_tokens), unknown = safeInteger(stored.unknown_count);
    if (unknown > 0 || recoveredPending.size > 0 || pendingCount() >= MAX_IN_FLIGHT || starts >= MAX_SAFE || known > MAX_SAFE - MAX_TOKENS_PER_FIELD * 2 * MAX_IN_FLIGHT) return null;
    if (safeInteger((database.prepare('SELECT COUNT(*) AS count FROM admissions').get() as Row).count) >= MAX_ROWS) return null;
    if (safeInteger((database.prepare("SELECT COUNT(*) AS count FROM admissions WHERE state = 'pending' AND conversation = ?").get(key) as Row).count) > 0) return null;
    if (safeInteger((database.prepare('SELECT COUNT(*) AS count FROM admissions WHERE conversation = ? AND admitted_at > ?').get(key, current - HOUR_MS) as Row).count) >= MAX_STARTS_PER_CONVERSATION) return null;
    const id = randomUUID();
    database.prepare('INSERT INTO admissions (id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens) VALUES (?, ?, ?, ?, \'pending\', ?, ?, ?)').run(id, starts + 1, key, current, MAX_TOKENS_PER_FIELD, MAX_TOKENS_PER_FIELD, MAX_TOKENS_PER_FIELD);
    database.prepare('UPDATE metadata SET cumulative_starts = ?, last_admission = ? WHERE id = 1').run(starts + 1, current);
    return id;
  }
  function createView(key: string): SubscriptionAccounting {
    const view = {key, closed: false, pending: new Set<Promise<unknown>>(), closing: undefined as Promise<void> | undefined};
    function track<T>(operation: Promise<T>): Promise<T> { view.pending.add(operation); operation.finally(() => view.pending.delete(operation)).catch(() => undefined); return operation; }
    return {
      reserve(): Promise<string | null> {
        if (closed || view.closed) return Promise.resolve(null);
        return track(serial(async () => {
          if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
          const current = time();
          try { const id = transaction(database, () => reserveInTransaction(key, current)); if (id) recoveredPending.delete(id); return id; }
          catch (error) { return markPersistenceFailure(error); }
        }));
      },
      settle(id: string, inputUsage: AccountedUsage | null): Promise<void> {
        if (closed) return Promise.reject(new Error('RELEASE_OWNER_CLOSED'));
        if (view.closed) return Promise.reject(new Error('RELEASE_VIEW_CLOSED'));
        let copiedId: string, copiedUsage: Usage | null;
        try { copiedId = z.string().uuid().parse(id); copiedUsage = inputUsage === null ? null : usageSchema.parse({...inputUsage}); }
        catch { return Promise.reject(new Error('RELEASE_USAGE_INVALID')); }
        return track(serial(async () => {
          if (poisoned) throw new Error('RELEASE_DATABASE_UNAVAILABLE');
          try {
            transaction(database, () => {
              const row = database.prepare('SELECT conversation, state FROM admissions WHERE id = ?').get(copiedId) as Row | undefined;
              if (!row || row.state !== 'pending' || row.conversation !== key) fail('RELEASE_INVALID_SETTLEMENT');
              if (copiedUsage === null) {
                database.prepare("UPDATE admissions SET state = 'unknown' WHERE id = ?").run(copiedId);
                const stored = metadata(), current = safeInteger(stored.unknown_count), starts = safeInteger(stored.cumulative_starts);
                if (current >= MAX_SAFE || starts <= 0) fail('RELEASE_COUNTER_OVERFLOW');
                database.prepare('UPDATE metadata SET unknown_count = ?, unknown_admission_ceiling = COALESCE(unknown_admission_ceiling, ?) WHERE id = 1').run(current + 1, starts);
              } else {
                const current = safeInteger(metadata().known_tokens), total = copiedUsage.inputTokens + copiedUsage.outputTokens;
                if (current > MAX_SAFE - total) fail('RELEASE_COUNTER_OVERFLOW');
                database.prepare("UPDATE admissions SET state = 'settled', input_tokens = ?, output_tokens = ?, cached_input_tokens = ? WHERE id = ?").run(copiedUsage.inputTokens, copiedUsage.outputTokens, copiedUsage.cachedInputTokens ?? 0, copiedId);
                database.prepare('UPDATE metadata SET known_tokens = ? WHERE id = 1').run(current + total);
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
            database.prepare("UPDATE admissions SET state='not_dispatched' WHERE id=?").run(copiedId);
          });}catch(error){if(isLogicalSettlementError(error))throw error;markPersistenceFailure(error);}
        }));
      },
      close(): Promise<void> { if (view.closing) return view.closing; view.closed = true; view.closing = Promise.all([...view.pending]).then(() => undefined); return view.closing; },
    };
  }
  return {
    forConversation(key: string): SubscriptionAccounting { const parsed = conversationKey.safeParse(key); if (!parsed.success) fail('RELEASE_CONVERSATION_KEY_INVALID'); return createView(parsed.data); },
    snapshot(): ReleaseAccountingSnapshot { const stored = metadata(); return {starts: safeInteger(stored.cumulative_starts), activeStarts: activeStartCount(), inFlight: pendingCount(), unresolved: pendingCount(), knownTokens: safeInteger(stored.known_tokens), unknown: safeInteger(stored.unknown_count), poisoned}; },
    close(): Promise<void> { if (closing) return closing; closed = true; closing = queue.then(() => { try { database.close(); } catch { throw new Error('RELEASE_CLOSE_FAILED'); } }); return closing; },
  } satisfies ReleaseAccountingOwner;
}
