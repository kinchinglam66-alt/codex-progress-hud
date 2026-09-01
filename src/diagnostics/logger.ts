import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import type { ObservedHudState } from "../lifecycle/types.js";
import {
  assertTrustedDirectory,
  ensureTrustedDirectory,
  openVerifiedAppend,
  openVerifiedCreate,
  regularFileInformation
} from "./safe-files.js";
import type { TrustedDirectory } from "./safe-files.js";

export type OperationalEventCode =
  | "startup_requested"
  | "startup_ready"
  | "startup_failed"
  | "shutdown_requested"
  | "shutdown_complete"
  | "shutdown_timeout"
  | "port_conflict"
  | "protocol_mismatch"
  | "crash_recovery";

export interface OperationalLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  event: OperationalEventCode;
  lifecycleState?: ObservedHudState;
  protocolVersion?: number;
  httpStatusCategory?: "2xx" | "4xx" | "5xx" | "network";
  elapsedMs?: number;
}

export interface OperationalLogger {
  write(entry: OperationalLogEntry): Promise<void>;
}

export interface OperationalLoggerOptions {
  logDirectory: string;
  maxBytes: number;
  maxFiles: number;
}

const EVENT_CODES = new Set<OperationalEventCode>([
  "startup_requested",
  "startup_ready",
  "startup_failed",
  "shutdown_requested",
  "shutdown_complete",
  "shutdown_timeout",
  "port_conflict",
  "protocol_mismatch",
  "crash_recovery"
]);
const LEVELS = new Set<OperationalLogEntry["level"]>(["info", "warn", "error"]);
const LIFECYCLE_STATES = new Set<ObservedHudState>([
  "starting",
  "running",
  "hidden",
  "stopped",
  "crashed",
  "incompatible",
  "port_conflict"
]);
const HTTP_STATUS_CATEGORIES = new Set<NonNullable<OperationalLogEntry["httpStatusCategory"]>>([
  "2xx",
  "4xx",
  "5xx",
  "network"
]);

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function optionalNonNegativeNumber(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
}

function sanitizeEntry(entry: OperationalLogEntry): OperationalLogEntry {
  const at = entry.at;
  const level = entry.level;
  const event = entry.event;
  const lifecycleState = entry.lifecycleState;
  const protocolVersion = entry.protocolVersion;
  const httpStatusCategory = entry.httpStatusCategory;
  const elapsedMs = entry.elapsedMs;
  const parsedAt = new Date(at);
  if (Number.isNaN(parsedAt.getTime()) || parsedAt.toISOString() !== at) {
    throw new TypeError("at must be a canonical ISO timestamp");
  }
  if (!LEVELS.has(level)) throw new TypeError("level must be an allowed category");
  if (!EVENT_CODES.has(event)) throw new TypeError("event code must be allowed");
  if (lifecycleState !== undefined && !LIFECYCLE_STATES.has(lifecycleState)) {
    throw new TypeError("lifecycle state must be allowed");
  }
  if (protocolVersion !== undefined && !Number.isSafeInteger(protocolVersion)) {
    throw new TypeError("protocol version must be an integer");
  }
  if (
    httpStatusCategory !== undefined &&
    !HTTP_STATUS_CATEGORIES.has(httpStatusCategory)
  ) {
    throw new TypeError("HTTP status category must be allowed");
  }
  optionalNonNegativeNumber(elapsedMs, "elapsedMs");

  return {
    at,
    level,
    event,
    ...(lifecycleState === undefined ? {} : { lifecycleState }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(httpStatusCategory === undefined
      ? {}
      : { httpStatusCategory }),
    ...(elapsedMs === undefined ? {} : { elapsedMs })
  };
}

async function fileSize(directory: TrustedDirectory, path: string): Promise<number> {
  await assertTrustedDirectory(directory);
  return Number((await regularFileInformation(path))?.size ?? 0);
}

async function moveIfPresent(
  directory: TrustedDirectory,
  source: string,
  destination: string
): Promise<void> {
  await assertTrustedDirectory(directory);
  const sourceInformation = await regularFileInformation(source);
  if (sourceInformation === null) return;
  await regularFileInformation(destination);
  await rm(destination, { force: true });
  await assertTrustedDirectory(directory);
  await rename(source, destination);
  await assertTrustedDirectory(directory);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockOwnerIsAlive(lockPath: string): Promise<boolean> {
  const information = await regularFileInformation(lockPath);
  if (information === null) return false;
  if (information.size > 256) throw new Error("operational log lock metadata is invalid");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return Date.now() - information.mtimeMs < 5_000;
  }
  if (typeof value !== "object" || value === null) return false;
  const pid = Reflect.get(value, "pid");
  return Number.isSafeInteger(pid) && (pid as number) > 0 && processIsAlive(pid as number);
}

async function reclaimOrphanedLock(lockPath: string): Promise<void> {
  if (await lockOwnerIsAlive(lockPath)) return;
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(stalePath, { force: true });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve_) => server.close(() => resolve_()));
}

async function acquireRecoveryMutex(lockPath: string): Promise<Server | null> {
  if (process.platform !== "win32") return null;
  const digest = createHash("sha256").update(lockPath.toLowerCase()).digest("hex").slice(0, 32);
  const pipePath = `\\\\.\\pipe\\codex-progress-hud-log-recovery-${digest}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const server = createServer();
    const acquired = await new Promise<boolean>((resolve_, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve_(false);
        else reject(error);
      };
      server.once("error", onError);
      server.listen(pipePath, () => {
        server.off("error", onError);
        resolve_(true);
      });
    });
    if (acquired) return server;
    await new Promise((resolve_) => setTimeout(resolve_, 5));
  }
  throw new Error("operational log recovery mutex timed out");
}

interface AcquiredLock {
  handle: FileHandle;
}

async function acquireLock(
  directory: TrustedDirectory,
  lockPath: string
): Promise<AcquiredLock> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const token = randomUUID();
      const handle = await openVerifiedCreate(directory, ".companion.log.lock");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), { encoding: "utf8" });
        return { handle };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await assertTrustedDirectory(directory);
        await rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recoveryMutex = await acquireRecoveryMutex(lockPath);
      try {
        await reclaimOrphanedLock(lockPath);
      } finally {
        if (recoveryMutex !== null) await closeServer(recoveryMutex);
      }
      await new Promise((resolve_) => setTimeout(resolve_, 5));
    }
  }
  throw new Error("operational log rotation lock timed out");
}

export function createOperationalLogger(options: OperationalLoggerOptions): OperationalLogger {
  positiveInteger(options.maxBytes, "maxBytes");
  positiveInteger(options.maxFiles, "maxFiles");
  const logDirectory = resolve(options.logDirectory);
  const activePath = join(logDirectory, "companion.log");
  const lockPath = join(logDirectory, ".companion.log.lock");
  let trustedDirectoryPromise: Promise<TrustedDirectory> | undefined;
  let pending = Promise.resolve();

  const write = async (entry: OperationalLogEntry): Promise<void> => {
    const serialized = `${JSON.stringify(sanitizeEntry(entry))}\n`;
    const entryBytes = Buffer.byteLength(serialized, "utf8");
    if (entryBytes > options.maxBytes) {
      throw new RangeError("operational log entry exceeds maxBytes");
    }
    trustedDirectoryPromise ??= ensureTrustedDirectory(logDirectory);
    const trustedDirectory = await trustedDirectoryPromise;
    const lock = await acquireLock(trustedDirectory, lockPath);
    try {
      if ((await fileSize(trustedDirectory, activePath)) + entryBytes > options.maxBytes) {
        if (options.maxFiles === 1) {
          await assertTrustedDirectory(trustedDirectory);
          await regularFileInformation(activePath);
          await rm(activePath, { force: true });
          await assertTrustedDirectory(trustedDirectory);
        } else {
          for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
            const source = index === 1 ? activePath : `${activePath}.${index - 1}`;
            await moveIfPresent(trustedDirectory, source, `${activePath}.${index}`);
          }
        }
      }
      const handle = await openVerifiedAppend(trustedDirectory, "companion.log");
      try {
        await handle.appendFile(serialized, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } finally {
      await lock.handle.close().catch(() => undefined);
      await assertTrustedDirectory(trustedDirectory);
      await rm(lockPath, { force: true });
    }
  };

  return {
    write(entry): Promise<void> {
      const operation = pending.then(() => write(entry));
      pending = operation.catch(() => undefined);
      return operation;
    }
  };
}
