import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ObservedHudState } from "../lifecycle/types.js";
import {
  ensureTrustedDirectory,
  openVerifiedAppend,
  regularFileInformation
} from "./safe-files.js";

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

async function fileSize(path: string): Promise<number> {
  return Number((await regularFileInformation(path))?.size ?? 0);
}

async function moveIfPresent(source: string, destination: string): Promise<void> {
  const sourceInformation = await regularFileInformation(source);
  if (sourceInformation === null) return;
  await regularFileInformation(destination);
  await rm(destination, { force: true });
  await rename(source, destination);
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
  let pending = Promise.resolve();

  const write = async (entry: OperationalLogEntry): Promise<void> => {
    const serialized = `${JSON.stringify(sanitizeEntry(entry))}\n`;
    const entryBytes = Buffer.byteLength(serialized, "utf8");
    if (entryBytes > options.maxBytes) {
      throw new RangeError("operational log entry exceeds maxBytes");
    }
    await ensureTrustedDirectory(logDirectory);
    const lock = await acquireLock(lockPath);
    try {
      if ((await fileSize(activePath)) + entryBytes > options.maxBytes) {
        if (options.maxFiles === 1) {
          await regularFileInformation(activePath);
          await rm(activePath, { force: true });
        } else {
          for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
            const source = index === 1 ? activePath : `${activePath}.${index - 1}`;
            await moveIfPresent(source, `${activePath}.${index}`);
          }
        }
      }
      const handle = await openVerifiedAppend(activePath);
      try {
        await handle.appendFile(serialized, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } finally {
      await lock.close().catch(() => undefined);
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
