import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {copyInvocationRecord, copyInvocationPatch, type InvocationRecord, type InvocationRecordPatch} from './invocation-ownership.js';
import type {AccountingPurpose} from './subscription-accounting.js';

const SCHEMA_VERSION = 3;
const MILLION = 1_000_000;
const MAX_COUNTER = 10_000_000_000;

type SqlRow = Record<string, unknown>;

export interface ApiProviderBinding {
  kind: 'api';
  profileId: string;
  generation: number;
}

export interface ApiReservation {
  id: string;
  profileId: string;
  generation: number;
  ownershipBound?: boolean;
  purpose?: AccountingPurpose;
}

export interface ApiPrices {
  version?: string;
  source?: string;
  effectiveDate?: string;
  date?: string;
  inputMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
  cachedInputMicrousdPerMillion?: number;
}

export interface ApiLimits {
  dailyCallLimit: number;
  dailyTokenCap?: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  dailyMicrousdCap?: number;
  prices?: ApiPrices;
}

export interface ApiUsage {
  kind: 'api-tokens';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type ApiReservationState = 'pending' | 'dispatched' | 'settled' | 'unknown' | 'cancelled';
export type ApiUsageState = 'pending' | 'known' | 'unknown' | 'cancelled';
export type ApiCostState = 'not-configured' | 'enforced' | 'unknown';

export interface ApiAccountingRow {
  id: string;
  profileId: string;
  generation: number;
  dayUtc: string;
  state: ApiReservationState;
  usageState: ApiUsageState;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  usage: ApiUsage | null;
  reservedMicrousd: number | null;
  actualMicrousd: number | null;
  costState: ApiCostState;
  prices: ApiPrices | null;
  createdAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  invocation?: InvocationRecord;
  recoveryOutcome?: 'abandoned_unconfirmed';
}

export interface ApiAccountingSnapshot {
  rows: readonly ApiAccountingRow[];
  rowsTruncated: boolean;
  starts: number;
  knownTokens: number;
  unknown: number;
  unresolved: number;
  dollarCapEnforced: boolean;
}

export interface ApiAccounting {
  reserve(binding: ApiProviderBinding, limits: ApiLimits, ownership?: Omit<InvocationRecord,'admissionId'>, purpose?: AccountingPurpose): Promise<ApiReservation | null>;
  markDispatch(id: string): Promise<void>;
  settle(id: string, usage: ApiUsage | null): Promise<void>;
  cancelBeforeDispatch(id: string): Promise<void>;
  bindInvocation(id: string, record: InvocationRecord): Promise<void>;
  updateInvocation(id: string, patch: InvocationRecordPatch): Promise<void>;
  snapshot(options?: ApiSnapshotOptions): ApiAccountingSnapshot;
  close(): Promise<void>;
}

export interface ApiSnapshotOptions {
  rowLimit?: number;
}

export type ApiAccountingClock = () => number;

const RESERVATION_COLUMNS = [
  'id', 'profile_id', 'generation', 'day_utc', 'state', 'usage_state',
  'reserved_input_tokens', 'reserved_output_tokens', 'usage_input_tokens',
  'usage_output_tokens', 'usage_cached_input_tokens', 'reserved_microusd',
  'actual_microusd', 'cost_state', 'prices_json', 'created_at',
  'dispatched_at', 'completed_at', 'invocation_json', 'recovery_outcome',
] as const;

function fail(code: string): never {
  throw new Error(code);
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;
}

function isSafeGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nowMs(clock: ApiAccountingClock): number {
  const value = clock();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('API_INVALID_CLOCK');
  return value;
}

function validateBinding(binding: ApiProviderBinding): void {
  if (!binding || binding.kind !== 'api' || !text(binding.profileId) || !isSafeGeneration(binding.generation)) {
    fail('API_INVALID_BINDING');
  }
}

function validatePrice(value: ApiPrices): ApiPrices {
  if (!value || !isSafeCounter(value.inputMicrousdPerMillion) || !isSafeCounter(value.outputMicrousdPerMillion)) {
    fail('API_INVALID_LIMITS');
  }
  if (value.cachedInputMicrousdPerMillion !== undefined && !isSafeCounter(value.cachedInputMicrousdPerMillion)) {
    fail('API_INVALID_LIMITS');
  }
  for (const metadata of [value.version, value.source]) {
    if (metadata !== undefined && !text(metadata, 256)) fail('API_INVALID_LIMITS');
  }
  const date = value.effectiveDate ?? value.date;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('API_INVALID_LIMITS');
  const copy: ApiPrices = {
    inputMicrousdPerMillion: value.inputMicrousdPerMillion,
    outputMicrousdPerMillion: value.outputMicrousdPerMillion,
  };
  if (value.version !== undefined) copy.version = value.version;
  if (value.source !== undefined) copy.source = value.source;
  if (value.effectiveDate !== undefined) copy.effectiveDate = value.effectiveDate;
  else if (value.date !== undefined) copy.effectiveDate = value.date;
  if (value.cachedInputMicrousdPerMillion !== undefined) copy.cachedInputMicrousdPerMillion = value.cachedInputMicrousdPerMillion;
  return copy;
}

function validateLimits(limits: ApiLimits): ApiLimits {
  if (!limits || !isSafeCounter(limits.dailyCallLimit) || !isSafeCounter(limits.maxInputTokens) ||
      !isSafeCounter(limits.maxOutputTokens)) fail('API_INVALID_LIMITS');
  if (limits.dailyTokenCap !== undefined && !isSafeCounter(limits.dailyTokenCap)) fail('API_INVALID_LIMITS');
  if (limits.dailyMicrousdCap !== undefined && !isSafeCounter(limits.dailyMicrousdCap)) fail('API_INVALID_LIMITS');
  const prices = limits.prices === undefined ? undefined : validatePrice(limits.prices);
  if (limits.prices !== undefined && prices === undefined) fail('API_INVALID_LIMITS');
  const copy: ApiLimits = {
    dailyCallLimit: limits.dailyCallLimit,
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
  };
  if (limits.dailyTokenCap !== undefined) copy.dailyTokenCap = limits.dailyTokenCap;
  if (limits.dailyMicrousdCap !== undefined) copy.dailyMicrousdCap = limits.dailyMicrousdCap;
  if (prices !== undefined) copy.prices = prices;
  return copy;
}

function validateUsage(usage: ApiUsage): ApiUsage {
  if (!usage || usage.kind !== 'api-tokens' || !isSafeCounter(usage.inputTokens) ||
      !isSafeCounter(usage.outputTokens) || !isSafeCounter(usage.cachedInputTokens) ||
      usage.cachedInputTokens > usage.inputTokens) fail('API_INVALID_USAGE');
  return {
    kind: 'api-tokens',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };
}

function validateColumns(database: DatabaseSync, table: string, expected: readonly string[]): void {
  const actual = new Set<string>();
  for (const row of database.prepare(`PRAGMA table_info(${table})`).iterate() as Iterable<SqlRow>) {
    if (typeof row.name === 'string') actual.add(row.name);
  }
  if (actual.size !== expected.length || expected.some(column => !actual.has(column))) fail('API_ACCOUNTING_CORRUPT');
}

function parseStoredPrices(value: unknown): ApiPrices | null {
  if (value === null) return null;
  if (typeof value !== 'string') fail('API_ACCOUNTING_CORRUPT');
  try {
    return validatePrice(JSON.parse(value) as ApiPrices);
  } catch {
    fail('API_ACCOUNTING_CORRUPT');
  }
}

function initializeDatabase(database: DatabaseSync): void {
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const tables = new Set<string>();
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").iterate() as Iterable<SqlRow>) {
      if (typeof row.name === 'string') tables.add(row.name);
    }
    const isNewDatabase = tables.size === 0;
    if (isNewDatabase) {
      database.exec(`
        CREATE TABLE api_accounting_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL CHECK (schema_version = ${SCHEMA_VERSION})
        );
        CREATE TABLE api_reservations (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          day_utc TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'settled', 'unknown', 'cancelled')),
          usage_state TEXT NOT NULL CHECK (usage_state IN ('pending', 'known', 'unknown', 'cancelled')),
          reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens >= 0),
          reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
          usage_input_tokens INTEGER,
          usage_output_tokens INTEGER,
          usage_cached_input_tokens INTEGER,
          reserved_microusd INTEGER,
          actual_microusd INTEGER,
          cost_state TEXT NOT NULL CHECK (cost_state IN ('not-configured', 'enforced', 'unknown')),
          prices_json TEXT,
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          dispatched_at INTEGER,
          completed_at INTEGER,
          invocation_json TEXT,
          recovery_outcome TEXT CHECK(recovery_outcome IS NULL OR recovery_outcome='abandoned_unconfirmed')
        );
        CREATE INDEX api_reservations_day ON api_reservations(day_utc);
        INSERT INTO api_accounting_meta (id, schema_version) VALUES (1, ${SCHEMA_VERSION});
      `);
    }
    if (!isNewDatabase && (!tables.has('api_accounting_meta') || !tables.has('api_reservations') || tables.size !== 2)) {
      fail('API_ACCOUNTING_CORRUPT');
    }
    validateColumns(database, 'api_accounting_meta', ['id', 'schema_version']);
    const storedVersion = database.prepare('SELECT schema_version FROM api_accounting_meta WHERE id = 1').get() as SqlRow | undefined;
    if (storedVersion?.schema_version === 1 || storedVersion?.schema_version === 2) {
      transaction(database, () => {
        const currentVersion=database.prepare('SELECT schema_version FROM api_accounting_meta WHERE id = 1').get() as SqlRow | undefined;
        if (currentVersion?.schema_version === SCHEMA_VERSION) return;
        if (currentVersion?.schema_version !== 1 && currentVersion?.schema_version !== 2) fail('API_ACCOUNTING_CORRUPT');
        validateColumns(database, 'api_reservations', RESERVATION_COLUMNS.filter(column => column !== 'recovery_outcome' && (currentVersion.schema_version!==1||column!=='invocation_json')));
        if(currentVersion.schema_version===1)database.exec('ALTER TABLE api_reservations ADD COLUMN invocation_json TEXT');
        database.exec(`ALTER TABLE api_reservations ADD COLUMN recovery_outcome TEXT CHECK(recovery_outcome IS NULL OR recovery_outcome='abandoned_unconfirmed');
          ALTER TABLE api_accounting_meta RENAME TO api_accounting_meta_old;
          CREATE TABLE api_accounting_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=3));
          INSERT INTO api_accounting_meta VALUES(1,3);
          DROP TABLE api_accounting_meta_old;`);
      });
    }
    validateColumns(database, 'api_reservations', RESERVATION_COLUMNS);
    const meta = database.prepare('SELECT id, schema_version FROM api_accounting_meta').all() as SqlRow[];
    if (meta.length !== 1 || meta[0]?.id !== 1 || meta[0]?.schema_version !== SCHEMA_VERSION) fail('API_ACCOUNTING_CORRUPT');
    const integrity = database.prepare('PRAGMA integrity_check').get() as SqlRow;
    if (integrity.integrity_check !== 'ok') fail('API_ACCOUNTING_CORRUPT');
    validateStoredRows(database);
  } catch (error) {
    if (error instanceof Error && error.message === 'API_ACCOUNTING_CORRUPT') throw error;
    throw new Error('API_ACCOUNTING_CORRUPT', {cause: error});
  }
}

function validateStoredRows(database: DatabaseSync): void {
  const allowedStates = new Set<ApiReservationState>(['pending', 'dispatched', 'settled', 'unknown', 'cancelled']);
  const allowedUsageStates = new Set<ApiUsageState>(['pending', 'known', 'unknown', 'cancelled']);
  const allowedCostStates = new Set<ApiCostState>(['not-configured', 'enforced', 'unknown']);
  for (const row of database.prepare('SELECT * FROM api_reservations ORDER BY rowid').iterate() as Iterable<SqlRow>) {
    if (!text(row.id) || !text(row.profile_id) || !isSafeGeneration(row.generation) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(row.day_utc)) || !allowedStates.has(String(row.state) as ApiReservationState) ||
        !allowedUsageStates.has(String(row.usage_state) as ApiUsageState) ||
        !isSafeCounter(row.reserved_input_tokens) || !isSafeCounter(row.reserved_output_tokens) ||
        !allowedCostStates.has(String(row.cost_state) as ApiCostState) || !isTimestamp(row.created_at)) fail('API_ACCOUNTING_CORRUPT');
    const usageFields = [row.usage_input_tokens, row.usage_output_tokens, row.usage_cached_input_tokens];
    if (usageFields.some(field => field !== null && !isSafeCounter(field))) fail('API_ACCOUNTING_CORRUPT');
    if (usageFields.every(field => field !== null) && Number(row.usage_cached_input_tokens) > Number(row.usage_input_tokens)) fail('API_ACCOUNTING_CORRUPT');
    if (row.reserved_microusd !== null && !isSafeCounter(row.reserved_microusd)) fail('API_ACCOUNTING_CORRUPT');
    if (row.actual_microusd !== null && !isSafeCounter(row.actual_microusd)) fail('API_ACCOUNTING_CORRUPT');
    if (row.dispatched_at !== null && !isTimestamp(row.dispatched_at)) fail('API_ACCOUNTING_CORRUPT');
    if (row.completed_at !== null && !isTimestamp(row.completed_at)) fail('API_ACCOUNTING_CORRUPT');
    parseStoredPrices(row.prices_json);
    readInvocation(row);
    if(row.recovery_outcome!==null&&(row.recovery_outcome!=='abandoned_unconfirmed'||row.state!=='unknown'))fail('API_ACCOUNTING_CORRUPT');
    const state = row.state as ApiReservationState;
    const usageState = row.usage_state as ApiUsageState;
    if ((state === 'pending' && usageState !== 'pending') || (state === 'dispatched' && usageState !== 'pending') ||
        (state === 'settled' && usageState !== 'known') || (state === 'unknown' && usageState !== 'unknown') ||
        (state === 'cancelled' && usageState !== 'cancelled')) fail('API_ACCOUNTING_CORRUPT');
    if ((state === 'dispatched' && row.dispatched_at === null) ||
        ((state === 'settled' || state === 'unknown' || state === 'cancelled') && row.completed_at === null)) fail('API_ACCOUNTING_CORRUPT');
    if ((state === 'settled') !== (usageFields.every(field => field !== null))) fail('API_ACCOUNTING_CORRUPT');
    if (row.completed_at !== null && Number(row.completed_at) < Number(row.created_at)) fail('API_ACCOUNTING_CORRUPT');
    if (row.cost_state === 'enforced' && row.reserved_microusd === null) fail('API_ACCOUNTING_CORRUPT');
    if (row.state === 'settled' && row.cost_state === 'enforced' && row.actual_microusd === null) fail('API_ACCOUNTING_CORRUPT');
  }
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function conservativeCost(tokens: {inputTokens: number; outputTokens: number}, prices: ApiPrices): number {
  const inputRate = prices.cachedInputMicrousdPerMillion === undefined
    ? prices.inputMicrousdPerMillion
    : Math.max(prices.inputMicrousdPerMillion, prices.cachedInputMicrousdPerMillion);
  const value = Math.ceil(tokens.inputTokens * inputRate / MILLION) + Math.ceil(tokens.outputTokens * prices.outputMicrousdPerMillion / MILLION);
  if (!Number.isSafeInteger(value)) fail('API_INVALID_LIMITS');
  return value;
}

function actualCost(usage: ApiUsage, prices: ApiPrices): number | null {
  if (prices.cachedInputMicrousdPerMillion === undefined) return null;
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  const value = Math.ceil(uncached * prices.inputMicrousdPerMillion / MILLION) +
    Math.ceil(usage.cachedInputTokens * prices.cachedInputMicrousdPerMillion / MILLION) +
    Math.ceil(usage.outputTokens * prices.outputMicrousdPerMillion / MILLION);
  return Number.isSafeInteger(value) ? value : null;
}

function storedRow(row: SqlRow): ApiAccountingRow {
  const usageState = String(row.usage_state) as ApiUsageState;
  const usage = usageState === 'known'
    ? {kind: 'api-tokens' as const, inputTokens: Number(row.usage_input_tokens), outputTokens: Number(row.usage_output_tokens), cachedInputTokens: Number(row.usage_cached_input_tokens)}
    : null;
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    generation: Number(row.generation),
    dayUtc: String(row.day_utc),
    state: String(row.state) as ApiReservationState,
    usageState,
    reservedInputTokens: Number(row.reserved_input_tokens),
    reservedOutputTokens: Number(row.reserved_output_tokens),
    usage,
    reservedMicrousd: row.reserved_microusd === null ? null : Number(row.reserved_microusd),
    actualMicrousd: row.actual_microusd === null ? null : Number(row.actual_microusd),
    costState: String(row.cost_state) as ApiCostState,
    prices: parseStoredPrices(row.prices_json),
    createdAt: Number(row.created_at),
    dispatchedAt: row.dispatched_at === null ? null : Number(row.dispatched_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    ...(row.invocation_json == null ? {} : {invocation: readInvocation(row)!}),
    ...(row.recovery_outcome==='abandoned_unconfirmed'?{recoveryOutcome:'abandoned_unconfirmed' as const}:{}),
  };
}

function readInvocation(row: SqlRow): InvocationRecord | undefined {
  if (row.invocation_json == null) return undefined;
  try {
    const value = copyInvocationRecord(JSON.parse(String(row.invocation_json)));
    if (value.admissionId !== row.id || value.providerKind !== 'api' ||
        value.pid !== undefined || value.creationIdentity !== undefined) fail('API_INVOCATION_INVALID');
    return value;
  } catch { return fail('API_INVOCATION_INVALID'); }
}

export function createApiAccounting(path: string, clock: ApiAccountingClock, monotonicClock=()=>performance.now()): ApiAccounting {
  const database = (() => {
    let candidate: DatabaseSync | undefined;
    try {
      candidate = new DatabaseSync(path);
      initializeDatabase(candidate);
      return candidate;
    } catch (error) {
      try { candidate?.close(); } catch { /* Opening may have failed before a handle existed. */ }
      if (error instanceof Error && error.message === 'API_ACCOUNTING_CORRUPT') throw error;
      throw new Error('API_ACCOUNTING_CORRUPT', {cause: error});
    }
  })();

  let queue: Promise<unknown> = Promise.resolve();
  let accepting = true;
  let closed = false;
  let closing: Promise<void> | undefined;
  let recoveryFailed=false;
  let recoveryTimer:ReturnType<typeof setTimeout>|undefined;
  const acquiredAt=nowMs(clock), acquiredMonotonic=monotonicClock();
  const recovered=new Set((database.prepare("SELECT id FROM api_reservations WHERE state IN ('pending','dispatched')").all() as SqlRow[]).map(row=>String(row.id)));

  function reconcileRecovered():void {
    const at=nowMs(clock);
    const done=transaction(database,()=>{
      const completed:string[]=[];
      for(const id of recovered) {
        const row=database.prepare('SELECT * FROM api_reservations WHERE id = ?').get(id) as SqlRow|undefined;
        if(!row||!['pending','dispatched'].includes(String(row.state))){completed.push(id);continue;}
        const createdAt=Number(row.created_at);
        const eligible=createdAt>acquiredAt||at<acquiredAt ? monotonicClock()-acquiredMonotonic>=300_000 : at-createdAt>=300_000;
        if(!eligible)continue;
        const invocation=readInvocation(row);
        database.prepare("UPDATE api_reservations SET state='unknown',usage_state='unknown',recovery_outcome='abandoned_unconfirmed',completed_at=?,invocation_json=? WHERE id=? AND state IN ('pending','dispatched')")
          .run(Math.max(at,createdAt),invocation?JSON.stringify({...invocation,phase:'closed',cleanupOutcome:'unconfirmed',recoveryOutcome:'abandoned_unconfirmed',recoveredAt:at}):null,id);
        completed.push(id);
      }
      return completed;
    });
    done.forEach(id=>recovered.delete(id));
  }
  function scheduleRecovery():void {
    if(!accepting||recovered.size===0||recoveryTimer!==undefined)return;
    recoveryTimer=setTimeout(()=>{
      recoveryTimer=undefined;
      void enqueue(()=>reconcileRecovered()).catch(()=>{if(accepting)recoveryFailed=true;}).finally(scheduleRecovery);
    },30_000);
    recoveryTimer.unref?.();
  }

  // Retry claims are the pending invocation rows themselves, inserted atomically
  // with ownership. Failure/backoff is derived from durable, never-reset history.
  function conversationAdmission(profileId:string,key:string,at:number,accountScope?:string):{allowed:boolean;retry:boolean} {
    const rows=database.prepare("SELECT * FROM api_reservations WHERE profile_id=? AND invocation_json IS NOT NULL AND json_extract(invocation_json,'$.conversationKey')=? AND json_extract(invocation_json,'$.accountScope') IS ? ORDER BY rowid").all(profileId,key,accountScope??null) as SqlRow[];
    let failures=0,nextEligible=0,retry=false;
    for(const row of rows) {
      if(row.state==='pending'||row.state==='dispatched')return {allowed:false,retry:true};
      if(row.state==='settled'){failures=0;nextEligible=0;retry=false;continue;}
      if(row.state!=='unknown')continue;
      const invocation=readInvocation(row)!;
      retry=true;
      if(invocation.recoveryOutcome!=='abandoned_unconfirmed'||invocation.retryAttempt===true)failures=Math.min(5,failures+1);
      nextEligible=failures===0?0:(invocation.recoveredAt??Number(row.completed_at))+[60_000,120_000,300_000,600_000,1_800_000][failures-1]!;
    }
    return {allowed:at>=nextEligible,retry};
  }

  function enqueue<T>(operation: () => T): Promise<T> {
    if (!accepting) return Promise.reject(new Error(closed ? 'API_ACCOUNTING_CLOSED' : 'API_ACCOUNTING_CLOSING'));
    const work = queue.then(() => {
      if (closed) throw new Error('API_ACCOUNTING_CLOSED');
      return operation();
    });
    queue = work.catch(() => undefined);
    return work;
  }

  function snapshot(options: ApiSnapshotOptions = {}): ApiAccountingSnapshot {
    if (closed) throw new Error('API_ACCOUNTING_CLOSED');
    const rowLimit = options.rowLimit === undefined ? 100 : options.rowLimit;
    if (!Number.isSafeInteger(rowLimit) || rowLimit < 0 || rowLimit > 1_000) fail('API_INVALID_SNAPSHOT_OPTIONS');
    const rows = (database.prepare('SELECT * FROM api_reservations ORDER BY created_at DESC, id DESC LIMIT ?').all(rowLimit) as SqlRow[])
      .map(storedRow).reverse();
    const totals = database.prepare(`
      SELECT
        COUNT(*) AS starts,
        COALESCE(SUM(CASE WHEN state = 'settled' THEN usage_input_tokens + usage_output_tokens ELSE 0 END), 0) AS known_tokens,
        COALESCE(SUM(CASE WHEN state IN ('unknown', 'dispatched') THEN 1 ELSE 0 END), 0) AS unknown_count,
        COALESCE(SUM(CASE WHEN state IN ('pending', 'dispatched') THEN 1 ELSE 0 END), 0) AS unresolved_count,
        COALESCE(SUM(CASE WHEN cost_state = 'enforced' THEN 1 ELSE 0 END), 0) AS enforced_count,
        COALESCE(SUM(CASE WHEN cost_state = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cost_count
      FROM api_reservations
    `).get() as SqlRow;
    return {
      rows,
      rowsTruncated: Number(totals.starts) > rowLimit,
      starts: Number(totals.starts),
      knownTokens: Number(totals.known_tokens),
      unknown: Number(totals.unknown_count),
      unresolved: Number(totals.unresolved_count),
      dollarCapEnforced: Number(totals.enforced_count) > 0 && Number(totals.unknown_cost_count) === 0,
    };
  }

  const accounting: ApiAccounting = {
    reserve(binding, limits, ownership, purpose: AccountingPurpose = 'eta') {
      return enqueue(() => {
        if(recoveryFailed)fail('API_ACCOUNTING_RECOVERY_FAILED');
        reconcileRecovered();
        validateBinding(binding);
        const checkedLimits = validateLimits(limits);
        const createdAt = nowMs(clock);
        const day = utcDay(createdAt);
        const reservedTokens = checkedLimits.maxInputTokens + checkedLimits.maxOutputTokens;
        if (!Number.isSafeInteger(reservedTokens)) fail('API_INVALID_LIMITS');
        return transaction(database, () => {
          const id=randomUUID();
          let invocation=ownership===undefined?undefined:copyInvocationRecord({...ownership,admissionId:id});
          if(invocation) {
            if(invocation.providerKind!=='api'||invocation.phase!=='prepared'||invocation.pid!==undefined||invocation.creationIdentity!==undefined||invocation.recoveryOutcome!==undefined)fail('API_INVOCATION_INVALID');
            const admission=conversationAdmission(binding.profileId,invocation.conversationKey,createdAt,invocation.accountScope);
            if(!admission.allowed)return null;
            invocation={...invocation,retryAttempt:admission.retry};
          }
          const oldUnpricedCost = Number((database.prepare("SELECT COUNT(*) AS count FROM api_reservations WHERE day_utc = ? AND cost_state <> 'enforced'").get(day) as SqlRow).count) > 0;
          const prices = checkedLimits.prices;
          const pricingComplete = prices !== undefined && prices.cachedInputMicrousdPerMillion !== undefined;
          const costState: ApiCostState = checkedLimits.dailyMicrousdCap === undefined
            ? 'not-configured'
            : !pricingComplete || oldUnpricedCost ? 'unknown' : 'enforced';
          const reservedMicrousd = prices === undefined || costState === 'unknown'
            ? null
            : conservativeCost({inputTokens: checkedLimits.maxInputTokens, outputTokens: checkedLimits.maxOutputTokens}, prices);
          const usedTokens = Number((database.prepare(`
            SELECT COALESCE(SUM(CASE
              WHEN state = 'settled' THEN usage_input_tokens + usage_output_tokens
              WHEN state IN ('pending', 'dispatched', 'unknown') THEN reserved_input_tokens + reserved_output_tokens
              ELSE 0 END), 0) AS total
            FROM api_reservations WHERE day_utc = ?
          `).get(day) as SqlRow).total);
          const usedCalls = Number((database.prepare(`
            SELECT COUNT(*) AS total FROM api_reservations
            WHERE day_utc = ? AND state <> 'cancelled'
          `).get(day) as SqlRow).total);
          if (!Number.isSafeInteger(usedCalls) || usedCalls >= checkedLimits.dailyCallLimit) return null;
          if (checkedLimits.dailyTokenCap !== undefined &&
              (!Number.isSafeInteger(usedTokens) || usedTokens > checkedLimits.dailyTokenCap - reservedTokens)) return null;
          if (costState === 'enforced' && checkedLimits.dailyMicrousdCap !== undefined) {
            const usedCost = Number((database.prepare(`
              SELECT COALESCE(SUM(CASE
                WHEN state = 'settled' THEN actual_microusd
                WHEN state IN ('pending', 'dispatched', 'unknown') THEN reserved_microusd
                ELSE 0 END), 0) AS total
              FROM api_reservations WHERE day_utc = ? AND cost_state = 'enforced'
            `).get(day) as SqlRow).total);
            if (!Number.isSafeInteger(usedCost) || reservedMicrousd === null || usedCost > checkedLimits.dailyMicrousdCap - reservedMicrousd) return null;
          }
          database.prepare(`
            INSERT INTO api_reservations (
              id, profile_id, generation, day_utc, state, usage_state,
              reserved_input_tokens, reserved_output_tokens, usage_input_tokens,
              usage_output_tokens, usage_cached_input_tokens, reserved_microusd,
              actual_microusd, cost_state, prices_json, created_at, dispatched_at, completed_at
            ) VALUES (?, ?, ?, ?, 'pending', 'pending', ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)
          `).run(id, binding.profileId, binding.generation, day, checkedLimits.maxInputTokens, checkedLimits.maxOutputTokens,
            reservedMicrousd, costState, prices ? JSON.stringify(prices) : null, createdAt);
          if(invocation)database.prepare('UPDATE api_reservations SET invocation_json=? WHERE id=?').run(JSON.stringify(invocation),id);
          return {id, profileId: binding.profileId, generation: binding.generation, purpose, ...(invocation?{ownershipBound:true}:{})};
        });
      });
    },

    bindInvocation(id, record) {
      const copied = copyInvocationRecord(record);
      return enqueue(() => transaction(database, () => {
        const row = database.prepare('SELECT * FROM api_reservations WHERE id = ?').get(id) as SqlRow | undefined;
        if (!row || row.state !== 'pending' || row.invocation_json !== null || copied.phase !== 'prepared') fail('API_INVOCATION_INVALID');
        readInvocation({...row, invocation_json: JSON.stringify(copied)});
        database.prepare('UPDATE api_reservations SET invocation_json = ? WHERE id = ?').run(JSON.stringify(copied), id);
      }));
    },

    updateInvocation(id, patch) {
      const copied = copyInvocationPatch(patch);
      return enqueue(() => transaction(database, () => {
        const row = database.prepare('SELECT * FROM api_reservations WHERE id = ?').get(id) as SqlRow | undefined;
        if (!row || !['pending', 'dispatched'].includes(String(row.state))) fail('API_INVOCATION_INVALID');
        const current = readInvocation(row);
        if (!current || current.phase === 'closed' || copied.pid !== undefined || copied.creationIdentity !== undefined ||
            copied.deadline !== undefined || copied.phase !== 'closed' || !['confirmed', 'unconfirmed', 'failed'].includes(copied.cleanupOutcome ?? '')) fail('API_INVOCATION_INVALID');
        database.prepare('UPDATE api_reservations SET invocation_json = ? WHERE id = ?').run(JSON.stringify({...current, ...copied}), id);
      }));
    },

    markDispatch(id) {
      return enqueue(() => {
        if (!text(id)) fail('API_INVALID_RESERVATION_ID');
        const dispatchedAt = nowMs(clock);
        transaction(database, () => {
          const row = database.prepare('SELECT * FROM api_reservations WHERE id = ?').get(id) as SqlRow | undefined;
          if (!row) fail('API_RESERVATION_NOT_FOUND');
          if (row.state === 'dispatched') return;
          if (row.state !== 'pending') fail('API_RESERVATION_NOT_PENDING');
          const invocation = readInvocation(row);
          if (invocation) {
            if (invocation.phase !== 'prepared') fail('API_INVOCATION_INVALID');
            database.prepare('UPDATE api_reservations SET invocation_json = ? WHERE id = ?').run(JSON.stringify({...invocation, phase: 'dispatching'}), id);
          }
          database.prepare("UPDATE api_reservations SET state = 'dispatched', dispatched_at = ? WHERE id = ? AND state = 'pending'").run(dispatchedAt, id);
        });
      });
    },

    settle(id, usage) {
      return enqueue(() => {
        if (!text(id)) fail('API_INVALID_RESERVATION_ID');
        const completedAt = nowMs(clock);
        const checkedUsage = usage === null ? null : validateUsage(usage);
        transaction(database, () => {
          const row = database.prepare('SELECT * FROM api_reservations WHERE id = ?').get(id) as SqlRow | undefined;
          if (!row) fail('API_RESERVATION_NOT_FOUND');
          if (row.state !== 'pending' && row.state !== 'dispatched') fail('API_SETTLEMENT_ALREADY_APPLIED');
          if (checkedUsage === null) {
            database.prepare("UPDATE api_reservations SET state = 'unknown', usage_state = 'unknown', completed_at = ? WHERE id = ?").run(completedAt, id);
            return;
          }
          const prices = parseStoredPrices(row.prices_json);
          const actual = prices === null ? null : actualCost(checkedUsage, prices);
          database.prepare(`
            UPDATE api_reservations SET state = 'settled', usage_state = 'known',
              usage_input_tokens = ?, usage_output_tokens = ?, usage_cached_input_tokens = ?,
              actual_microusd = ?, completed_at = ? WHERE id = ?
          `).run(checkedUsage.inputTokens, checkedUsage.outputTokens, checkedUsage.cachedInputTokens, actual, completedAt, id);
        });
      });
    },

    cancelBeforeDispatch(id) {
      return enqueue(() => {
        if (!text(id)) fail('API_INVALID_RESERVATION_ID');
        const completedAt = nowMs(clock);
        transaction(database, () => {
          const row = database.prepare('SELECT state FROM api_reservations WHERE id = ?').get(id) as SqlRow | undefined;
          if (!row) fail('API_RESERVATION_NOT_FOUND');
          if (row.state !== 'pending') fail('API_RESERVATION_NOT_PENDING');
          database.prepare("UPDATE api_reservations SET state = 'cancelled', usage_state = 'cancelled', completed_at = ? WHERE id = ? AND state = 'pending'").run(completedAt, id);
        });
      });
    },

    snapshot,

    close() {
      if (closing) return closing;
      accepting = false;
      clearTimeout(recoveryTimer);
      closing = queue.then(() => {
        closed = true;
        database.close();
      });
      return closing;
    },
  };
  try {reconcileRecovered();scheduleRecovery();}catch(error){database.close();throw error;}
  return accounting;
}
