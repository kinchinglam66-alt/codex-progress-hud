import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ObservedHudState } from "../lifecycle/types.js";

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
  const parsedAt = new Date(entry.at);
  if (Number.isNaN(parsedAt.getTime()) || parsedAt.toISOString() !== entry.at) {
    throw new TypeError("at must be a canonical ISO timestamp");
  }
  if (!LEVELS.has(entry.level)) throw new TypeError("level must be an allowed category");
  if (!EVENT_CODES.has(entry.event)) throw new TypeError("event code must be allowed");
  if (entry.lifecycleState !== undefined && !LIFECYCLE_STATES.has(entry.lifecycleState)) {
    throw new TypeError("lifecycle state must be allowed");
  }
  if (entry.protocolVersion !== undefined && !Number.isSafeInteger(entry.protocolVersion)) {
    throw new TypeError("protocol version must be an integer");
  }
  if (
    entry.httpStatusCategory !== undefined &&
    !HTTP_STATUS_CATEGORIES.has(entry.httpStatusCategory)
  ) {
    throw new TypeError("HTTP status category must be allowed");
  }
  optionalNonNegativeNumber(entry.elapsedMs, "elapsedMs");

  return {
    at: entry.at,
    level: entry.level,
    event: entry.event,
    ...(entry.lifecycleState === undefined ? {} : { lifecycleState: entry.lifecycleState }),
    ...(entry.protocolVersion === undefined ? {} : { protocolVersion: entry.protocolVersion }),
    ...(entry.httpStatusCategory === undefined
      ? {}
      : { httpStatusCategory: entry.httpStatusCategory }),
    ...(entry.elapsedMs === undefined ? {} : { elapsedMs: entry.elapsedMs })
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function moveIfPresent(source: string, destination: string): Promise<void> {
  await rm(destination, { force: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createOperationalLogger(options: OperationalLoggerOptions): OperationalLogger {
  positiveInteger(options.maxBytes, "maxBytes");
  positiveInteger(options.maxFiles, "maxFiles");
  const activePath = join(options.logDirectory, "companion.log");
  let pending = Promise.resolve();

  const write = async (entry: OperationalLogEntry): Promise<void> => {
    const serialized = `${JSON.stringify(sanitizeEntry(entry))}\n`;
    const entryBytes = Buffer.byteLength(serialized, "utf8");
    if (entryBytes > options.maxBytes) {
      throw new RangeError("operational log entry exceeds maxBytes");
    }
    await mkdir(options.logDirectory, { recursive: true });
    if ((await fileSize(activePath)) + entryBytes > options.maxBytes) {
      if (options.maxFiles === 1) {
        await rm(activePath, { force: true });
      } else {
        for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
          const source = index === 1 ? activePath : `${activePath}.${index - 1}`;
          await moveIfPresent(source, `${activePath}.${index}`);
        }
      }
    }
    await appendFile(activePath, serialized, { encoding: "utf8", mode: 0o600 });
  };

  return {
    write(entry): Promise<void> {
      const operation = pending.then(() => write(entry));
      pending = operation.catch(() => undefined);
      return operation;
    }
  };
}
