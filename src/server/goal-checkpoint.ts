import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LifecycleStateTimeoutError, withLifecycleStateLock } from "../lifecycle/state-lock.js";
import type { CountdownPrediction } from "../ui/countdown.js";

const SCHEMA_VERSION = 1 as const;
const FILE_NAME = "goal-checkpoint.json";
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 256;
const MAX_SECONDS = 31_536_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPAQUE_STRING_LENGTH = 256;
const CHECKPOINT_LOCK_FILE = ".goal-checkpoint.lock";
const CHECKPOINT_LOCK_TIMEOUT_MS = 500;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const RECORD_KEYS = [
  "sessionKey",
  "turnKey",
  "generation",
  "estimateRevision",
  "savedAtMs",
  "activeSeconds",
  "runtime",
  "status",
  "prediction",
  "progressFloor",
  "timingUncertain"
] as const;
const PREDICTION_KEYS = ["remainingSeconds", "errorPercent", "observedActiveSeconds"] as const;

export interface GoalCheckpointRecord {
  sessionKey: string;
  turnKey: string;
  generation: number;
  estimateRevision: number;
  savedAtMs: number;
  activeSeconds: number;
  runtime: "running" | "waiting" | "paused";
  status: "running" | "waiting" | "paused" | "unknown";
  prediction: CountdownPrediction | null;
  progressFloor: number;
  timingUncertain: boolean;
}

export interface GoalCheckpointRepository {
  load(): Promise<GoalCheckpointRecord[]>;
  save(records: readonly GoalCheckpointRecord[]): Promise<void>;
}

interface CheckpointDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  sourceIdentity: string;
  records: GoalCheckpointRecord[];
}

interface FileIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  nlink: number;
}

class GoalCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalCheckpointError";
  }
}

function checkpointError(message: string): GoalCheckpointError {
  return new GoalCheckpointError(`Goal checkpoint ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw checkpointError(`contains invalid ${label} fields`);
  }
}

function opaqueString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OPAQUE_STRING_LENGTH) {
    throw checkpointError(`${label} is invalid`);
  }
  if (!/^[A-Za-z0-9._~-]+$/u.test(value)) {
    throw checkpointError(`${label} is invalid`);
  }
  return value;
}

function boundedSeconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) {
    throw checkpointError(`${label} is invalid`);
  }
  return value;
}

function safeNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw checkpointError(`${label} is invalid`);
  }
  return value;
}

function safeNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    throw checkpointError("clock is unavailable");
  }
  return safeNonnegativeInteger(value, "clock");
}

function validatePrediction(value: unknown, activeSeconds: number): CountdownPrediction | null {
  if (value === null) return null;
  if (!isRecord(value)) throw checkpointError("prediction is invalid");
  hasExactKeys(value, PREDICTION_KEYS, "prediction");
  const prediction: CountdownPrediction = {
    remainingSeconds: boundedSeconds(value.remainingSeconds, "prediction remaining seconds"),
    errorPercent: boundedSeconds(value.errorPercent, "prediction error percent"),
    observedActiveSeconds: boundedSeconds(value.observedActiveSeconds, "prediction anchor")
  };
  if (prediction.errorPercent > 1000) throw checkpointError("prediction error percent is invalid");
  if (prediction.observedActiveSeconds > activeSeconds) {
    throw checkpointError("prediction anchor is invalid");
  }
  return prediction;
}

function validateRecord(value: unknown): GoalCheckpointRecord {
  if (!isRecord(value)) throw checkpointError("record is invalid");
  hasExactKeys(value, RECORD_KEYS, "record");

  const sessionKey = opaqueString(value.sessionKey, "session key");
  const turnKey = opaqueString(value.turnKey, "turn key");
  const generation = safeNonnegativeInteger(value.generation, "generation");
  const estimateRevision = safeNonnegativeInteger(value.estimateRevision, "estimate revision");
  const savedAtMs = safeNonnegativeInteger(value.savedAtMs, "saved timestamp");
  const activeSeconds = boundedSeconds(value.activeSeconds, "active seconds");
  const runtime = value.runtime;
  if (runtime !== "running" && runtime !== "waiting" && runtime !== "paused") {
    throw checkpointError("runtime is invalid");
  }
  const status = value.status;
  if (status !== "running" && status !== "waiting" && status !== "paused" && status !== "unknown") {
    throw checkpointError("status is invalid");
  }
  const progressFloor = value.progressFloor;
  if (typeof progressFloor !== "number" || !Number.isFinite(progressFloor) || progressFloor < 0 || progressFloor > 99) {
    throw checkpointError("progress floor is invalid");
  }
  if (typeof value.timingUncertain !== "boolean") {
    throw checkpointError("timing uncertainty is invalid");
  }

  return {
    sessionKey,
    turnKey,
    generation,
    estimateRevision,
    savedAtMs,
    activeSeconds,
    runtime,
    status,
    prediction: validatePrediction(value.prediction, activeSeconds),
    progressFloor,
    timingUncertain: value.timingUncertain
  };
}

function uniqueRecords(records: readonly GoalCheckpointRecord[]): GoalCheckpointRecord[] {
  const seenTurns = new Set<string>();
  const seenSessions = new Map<string, string>();
  for (const record of records) {
    const previousTurn = seenSessions.get(record.sessionKey);
    if (previousTurn !== undefined && previousTurn !== record.turnKey) {
      throw checkpointError("contains multiple turns for one session");
    }
    seenSessions.set(record.sessionKey, record.turnKey);
    const sessionTurn = `${record.sessionKey}\u0000${record.turnKey}`;
    if (seenTurns.has(sessionTurn)) throw checkpointError("contains duplicate session-turn records");
    seenTurns.add(sessionTurn);
  }
  return records.map(record => ({
    ...record,
    prediction: record.prediction === null ? null : { ...record.prediction }
  }));
}

function compareNewest(left: GoalCheckpointRecord, right: GoalCheckpointRecord): number {
  if (left.savedAtMs !== right.savedAtMs) return left.savedAtMs < right.savedAtMs ? 1 : -1;
  if (left.generation !== right.generation) return left.generation < right.generation ? 1 : -1;
  if (left.estimateRevision !== right.estimateRevision) return left.estimateRevision < right.estimateRevision ? 1 : -1;
  const sessionOrder = left.sessionKey.localeCompare(right.sessionKey);
  if (sessionOrder !== 0) return sessionOrder;
  return left.turnKey.localeCompare(right.turnKey);
}

function newestRecords(records: readonly GoalCheckpointRecord[]): GoalCheckpointRecord[] {
  return [...records].sort(compareNewest).slice(0, MAX_RECORDS);
}

function identity(stats: { dev: number; ino: number; birthtimeMs: number; nlink: number }): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    nlink: stats.nlink
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeMs === right.birthtimeMs;
}

async function trustedDirectory(directory: string): Promise<FileIdentity> {
  try {
    const absolute = resolve(directory);
    const stats = await lstat(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw checkpointError("directory is not trusted");
    const canonical = await realpath(absolute);
    const comparableCanonical = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (comparableCanonical !== comparableAbsolute) throw checkpointError("directory is not trusted");
    return identity(stats);
  } catch (error) {
    if (error instanceof GoalCheckpointError) throw error;
    throw checkpointError("directory is not trusted");
  }
}

async function regularTarget(path: string): Promise<FileIdentity | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw checkpointError("target is not a single-link regular file");
    }
    return identity(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof GoalCheckpointError) throw error;
    throw checkpointError("target cannot be inspected");
  }
}

async function requireOwner(isOwner: () => Promise<boolean>): Promise<void> {
  let owner: boolean;
  try {
    owner = await isOwner();
  } catch {
    throw checkpointError("ownership could not be verified");
  }
  if (owner !== true) throw checkpointError("ownership is not current");
}

async function readBounded(path: string, expectedIdentity: FileIdentity): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw checkpointError("target is not a single-link regular file");
    if (!sameIdentity(expectedIdentity, identity(stats))) throw checkpointError("target changed");
    if (stats.size > MAX_BYTES) throw checkpointError("file is too large");
    const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > MAX_BYTES) throw checkpointError("file is too large");
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } catch (error) {
    if (error instanceof GoalCheckpointError) throw error;
    throw checkpointError("file cannot be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseDocument(serialized: string, sourceIdentity: string, nowMs: number): GoalCheckpointRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw checkpointError("contains invalid JSON");
  }
  if (!isRecord(value)) throw checkpointError("document is invalid");
  hasExactKeys(value, ["schemaVersion", "sourceIdentity", "records"], "document");
  if (value.schemaVersion !== SCHEMA_VERSION) throw checkpointError("schema version is unsupported");
  const documentSource = opaqueString(value.sourceIdentity, "source identity");
  if (documentSource !== sourceIdentity) return [];
  if (!Array.isArray(value.records)) throw checkpointError("records are invalid");

  const records = uniqueRecords(value.records.map(validateRecord));
  for (const record of records) {
    if (record.savedAtMs > nowMs) throw checkpointError("contains a future timestamp");
  }
  return newestRecords(records.filter(record => nowMs - record.savedAtMs <= MAX_RETENTION_MS));
}

function serializeDocument(sourceIdentity: string, records: readonly GoalCheckpointRecord[], nowMs: number): string {
  for (const record of records) {
    if (record.savedAtMs > nowMs) throw checkpointError("cannot save a future timestamp");
  }
  const document: CheckpointDocument = {
    schemaVersion: SCHEMA_VERSION,
    sourceIdentity,
    records: newestRecords(records)
  };
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) throw checkpointError("serialized data is too large");
  return serialized;
}

async function writeAtomically(
  directory: string,
  path: string,
  serialized: string,
  isOwner: () => Promise<boolean>
): Promise<void> {
  const directoryIdentity = await trustedDirectory(directory);
  const targetIdentity = await regularTarget(path);
  await requireOwner(isOwner);
  const beforeWriteDirectory = await trustedDirectory(directory);
  if (!sameIdentity(directoryIdentity, beforeWriteDirectory)) throw checkpointError("directory changed");
  const beforeWriteTarget = await regularTarget(path);
  if ((targetIdentity === null) !== (beforeWriteTarget === null)
    || (targetIdentity !== null && beforeWriteTarget !== null && !sameIdentity(targetIdentity, beforeWriteTarget))) {
    throw checkpointError("target changed");
  }

  const temporaryPath = join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    ownsTemporary = true;
    let temporaryIdentity: FileIdentity | undefined;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw checkpointError("temporary file is not a single-link regular file");
      }
      temporaryIdentity = identity(opened);
    } finally {
      await handle.close();
    }
    if (temporaryIdentity === undefined) throw checkpointError("temporary file identity is unavailable");
    await requireOwner(isOwner);
    const afterFlushDirectory = await trustedDirectory(directory);
    const afterFlushTarget = await regularTarget(path);
    const afterFlushTemporary = await regularTarget(temporaryPath);
    if (!sameIdentity(directoryIdentity, afterFlushDirectory)) throw checkpointError("directory changed");
    if (afterFlushTemporary === null || !sameIdentity(temporaryIdentity, afterFlushTemporary)) {
      throw checkpointError("temporary file changed");
    }
    if ((targetIdentity === null) !== (afterFlushTarget === null)
      || (targetIdentity !== null && afterFlushTarget !== null && !sameIdentity(targetIdentity, afterFlushTarget))) {
      throw checkpointError("target changed");
    }
    await rename(temporaryPath, path);
    ownsTemporary = false;
  } catch (error) {
    if (ownsTemporary) await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof GoalCheckpointError) throw error;
    throw checkpointError("replacement failed");
  }
}

async function withCheckpointLock<T>(
  directory: string,
  operation: () => Promise<T>
): Promise<T> {
  await trustedDirectory(directory);
  try {
    return await withLifecycleStateLock(
      join(directory, CHECKPOINT_LOCK_FILE),
      operation,
      CHECKPOINT_LOCK_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof GoalCheckpointError) throw error;
    if (error instanceof LifecycleStateTimeoutError) throw checkpointError("storage lock timed out");
    throw checkpointError("storage lock is unavailable");
  }
}

export function createGoalCheckpointRepository(options: {
  directory: string;
  sourceIdentity: string;
  isOwner: () => Promise<boolean>;
  now?: () => number;
}): GoalCheckpointRepository {
  if (typeof options.directory !== "string" || options.directory.length === 0) {
    throw checkpointError("directory is invalid");
  }
  const sourceIdentity = opaqueString(options.sourceIdentity, "source identity");
  const now = options.now ?? Date.now;
  if (typeof options.isOwner !== "function") throw checkpointError("ownership callback is invalid");
  const directory = resolve(options.directory);
  const path = join(directory, FILE_NAME);
  let pending: Promise<void> = Promise.resolve();

  const load = async (): Promise<GoalCheckpointRecord[]> => {
    return withCheckpointLock(directory, async () => {
      await trustedDirectory(directory);
      const target = await regularTarget(path);
      if (target === null) return [];
      const serialized = await readBounded(path, target);
      return parseDocument(serialized, sourceIdentity, safeNow(now));
    });
  };

  const save = (records: readonly GoalCheckpointRecord[]): Promise<void> => {
    if (!Array.isArray(records)) return Promise.reject(checkpointError("records are invalid"));
    let snapshot: GoalCheckpointRecord[];
    let serialized: string;
    try {
      snapshot = uniqueRecords(records.map(validateRecord));
      serialized = serializeDocument(sourceIdentity, snapshot, safeNow(now));
    } catch (error) {
      return Promise.reject(error);
    }

    const operation = pending.then(async () => {
      await withCheckpointLock(directory, async () => {
        await writeAtomically(directory, path, serialized, options.isOwner);
      });
    });
    pending = operation.catch(() => undefined);
    return operation;
  };

  return { load, save };
}

/** Milestone sidecar shares the exact owner, single-link, bounded and atomic I/O guards.
 * Kept separate from the v1 goal document so older installations can still roll back. */
export function createMilestoneCheckpointStorage(options:{directory:string;isOwner:()=>Promise<boolean>}) {
  const directory=resolve(options.directory),path=join(directory,'milestone-checkpoint.json');
  let pending:Promise<void>=Promise.resolve();
  return {
    load:()=>withCheckpointLock(directory,async()=>{
      const target=await regularTarget(path);return target===null?null:readBounded(path,target);
    }),
    save:(serialized:string)=>{
      if(Buffer.byteLength(serialized)>MAX_BYTES)return Promise.reject(checkpointError('milestone file is too large'));
      const operation=pending.then(()=>withCheckpointLock(directory,()=>writeAtomically(directory,path,serialized,options.isOwner)));
      pending=operation.catch(()=>undefined);return operation;
    },
  };
}
