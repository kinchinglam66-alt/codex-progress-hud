import { createHash, randomUUID } from "node:crypto";
import { link, unlink, type FileHandle } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { resolve } from "node:path";
import type { ObservedHudState } from "../lifecycle/types.js";
import {
  assertTrustedDirectory,
  ensureTrustedDirectory,
  nodeFileSystemOperations,
  openVerifiedAppend,
  openVerifiedCreate,
  openVerifiedExisting
} from "./safe-files.js";
import type { FileSystemOperations, TrustedDirectory } from "./safe-files.js";

export type OperationalEventCode =
  | "startup_requested"
  | "child_exit"
  | "startup_ready"
  | "startup_failed"
  | "shutdown_requested"
  | "shutdown_complete"
  | "shutdown_timeout"
  | "port_conflict"
  | "protocol_mismatch"
  | "crash_recovery"
  | "hook_received" | "hook_failed" | "lease_acquired" | "lease_expired"
  | "late_attach" | "stale_revision";

export interface OperationalLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  event: OperationalEventCode;
  lifecycleState?: ObservedHudState;
  protocolVersion?: number;
  httpStatusCategory?: "2xx" | "4xx" | "5xx" | "network";
  elapsedMs?: number;
  role?: "manager" | "desktop";
  attemptId?: string;
  generation?: number;
  childPid?: number;
  childOutcome?: "spawned" | "attached" | "termination_requested" | "terminated" | "exited" | "unknown";
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
  "child_exit",
  "startup_requested",
  "startup_ready",
  "startup_failed",
  "shutdown_requested",
  "shutdown_complete",
  "shutdown_timeout",
  "port_conflict",
  "protocol_mismatch",
  "crash_recovery",
  "hook_received", "hook_failed", "lease_acquired", "lease_expired",
  "late_attach", "stale_revision"
]);
const LEVELS = new Set<OperationalLogEntry["level"]>(["info", "warn", "error"]);
const LIFECYCLE_STATES = new Set<ObservedHudState>([
  "starting",
  "running",
  "hidden",
  "stopped",
  "crashed",
  "unresponsive",
  "incompatible",
  "port_conflict"
]);
const HTTP_STATUS_CATEGORIES = new Set<NonNullable<OperationalLogEntry["httpStatusCategory"]>>([
  "2xx",
  "4xx",
  "5xx",
  "network"
]);
const ROLES = new Set<NonNullable<OperationalLogEntry["role"]>>(["manager", "desktop"]);
const CHILD_OUTCOMES = new Set<NonNullable<OperationalLogEntry["childOutcome"]>>([
  "spawned",
  "attached",
  "termination_requested",
  "terminated",
  "exited",
  "unknown"
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
  const role = entry.role;
  const attemptId = entry.attemptId;
  const generation = entry.generation;
  const childPid = entry.childPid;
  const childOutcome = entry.childOutcome;
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
  if (role !== undefined && !ROLES.has(role)) throw new TypeError("role must be allowed");
  if (attemptId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(attemptId)) {
    throw new TypeError("attempt identity must be a UUID");
  }
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
    throw new TypeError("generation must be a non-negative integer");
  }
  if (childPid !== undefined && (!Number.isSafeInteger(childPid) || childPid <= 0)) {
    throw new TypeError("child PID must be a positive integer");
  }
  if (childOutcome !== undefined && !CHILD_OUTCOMES.has(childOutcome)) {
    throw new TypeError("child outcome must be allowed");
  }

  return {
    at,
    level,
    event,
    ...(lifecycleState === undefined ? {} : { lifecycleState }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(httpStatusCategory === undefined
      ? {}
      : { httpStatusCategory }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(role === undefined ? {} : { role }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(generation === undefined ? {} : { generation }),
    ...(childPid === undefined ? {} : { childPid }),
    ...(childOutcome === undefined ? {} : { childOutcome })
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve_) => server.close(() => resolve_()));
}

function transactionAddress(logDirectory: string): string {
  const digest = createHash("sha256").update(logDirectory.toLowerCase()).digest("hex").slice(0, 32);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codex-progress-hud-log-transaction-${digest}`;
  }
  if (process.platform === "linux") return `\0codex-progress-hud-log-transaction-${digest}`;
  throw new Error("operational log locking requires Windows or Linux kernel sockets");
}

async function acquireTransaction(logDirectory: string): Promise<Server> {
  const address = transactionAddress(logDirectory);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const server = createServer((socket) => socket.destroy());
    const acquired = await new Promise<boolean>((resolve_, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve_(false);
        else reject(error);
      };
      server.once("error", onError);
      server.listen(address, () => {
        server.off("error", onError);
        resolve_(true);
      });
    });
    if (acquired) return server;
    await new Promise((resolve_) => setTimeout(resolve_, 5));
  }
  throw new Error("operational log rotation lock timed out");
}

interface OwnerIdentity {
  address: string;
  server: Server;
}

async function createOwnerIdentity(): Promise<OwnerIdentity> {
  const token = randomUUID();
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-progress-hud-owner-${token}`
    : process.platform === "linux"
      ? `\0codex-progress-hud-owner-${token}`
      : (() => { throw new Error("operational log owner identity requires Windows or Linux"); })();
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve_, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve_();
    });
  });
  server.unref();
  return { address, server };
}

let processOwnerIdentityPromise: Promise<OwnerIdentity> | undefined;

function processOwnerIdentity(): Promise<OwnerIdentity> {
  processOwnerIdentityPromise ??= createOwnerIdentity();
  return processOwnerIdentityPromise;
}

function validOwnerAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (process.platform === "win32") {
    return /^\\\\\.\\pipe\\codex-progress-hud-owner-[0-9a-f-]{36}$/u.test(value);
  }
  return /^\0codex-progress-hud-owner-[0-9a-f-]{36}$/u.test(value);
}

async function ownerIsAlive(address: string): Promise<boolean> {
  return new Promise((resolve_) => {
    const socket = connect(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve_(true);
    });
    socket.once("error", () => resolve_(false));
  });
}

interface LockRecord {
  device: bigint;
  inode: bigint;
  owner: string;
  tempName: string;
  token: string;
}

async function readLockRecord(
  lockPath: string,
  fileSystem: FileSystemOperations
): Promise<LockRecord | null> {
  let before;
  try {
    before = await fileSystem.lstatBigInt(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1n || before.nlink > 2n) {
    throw new Error("operational log lock must be a regular owned file");
  }
  if (before.size > 512n) throw new Error("operational log lock metadata is invalid");
  const handle = await fileSystem.open(lockPath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("operational log lock changed while being opened");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    let current;
    try {
      current = await fileSystem.lstatBigInt(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("operational log lock path changed while being read");
    }
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) {
      throw new Error("operational log lock metadata is invalid");
    }
    const owner = Reflect.get(value, "owner");
    const token = Reflect.get(value, "token");
    const tempName = Reflect.get(value, "tempName");
    if (
      !validOwnerAddress(owner) ||
      typeof token !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(token) ||
      tempName !== `.companion.log.lock.owner-${token}`
    ) {
      throw new Error("operational log lock metadata is invalid");
    }
    return { device: opened.dev, inode: opened.ino, owner, tempName, token };
  } finally {
    await handle.close();
  }
}

async function unlinkIfOwned(
  path: string,
  record: LockRecord,
  fileSystem: FileSystemOperations
): Promise<boolean> {
  let information;
  try {
    information = await fileSystem.lstatBigInt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (information.dev !== record.device || information.ino !== record.inode) return false;
  await unlink(path);
  return true;
}

interface AcquiredLock extends LockRecord {
  lockPath: string;
}

async function acquireLock(
  directory: TrustedDirectory,
  logDirectory: string,
  owner: OwnerIdentity,
  fileSystem: FileSystemOperations
): Promise<AcquiredLock> {
  const lockPath = resolve(logDirectory, ".companion.log.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const token = randomUUID();
    const tempName = `.companion.log.lock.owner-${token}`;
    const tempPath = resolve(logDirectory, tempName);
    const handle = await openVerifiedCreate(directory, tempName, fileSystem);
    try {
      await handle.writeFile(JSON.stringify({ owner: owner.address, tempName, token }), {
        encoding: "utf8"
      });
    } finally {
      await handle.close();
    }
    await assertTrustedDirectory(directory, fileSystem);
    try {
      await link(tempPath, lockPath);
      const published = await readLockRecord(lockPath, fileSystem);
      if (published === null || published.token !== token || published.owner !== owner.address) {
        throw new Error("operational log lock publication could not be verified");
      }
      await unlinkIfOwned(tempPath, published, fileSystem);
      return { ...published, lockPath };
    } catch (error) {
      const tempInformation = await fileSystem.lstatBigInt(tempPath);
      const tempRecord: LockRecord = {
        device: tempInformation.dev,
        inode: tempInformation.ino,
        owner: owner.address,
        tempName,
        token
      };
      await unlinkIfOwned(tempPath, tempRecord, fileSystem);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const transaction = await acquireTransaction(logDirectory);
    try {
      const existing = await readLockRecord(lockPath, fileSystem);
      if (existing !== null && !await ownerIsAlive(existing.owner)) {
        await unlinkIfOwned(lockPath, existing, fileSystem);
        await unlinkIfOwned(resolve(logDirectory, existing.tempName), existing, fileSystem);
      }
    } finally {
      await closeServer(transaction);
    }
    await new Promise((resolve_) => setTimeout(resolve_, 5));
  }
  throw new Error("operational log rotation lock timed out");
}

async function releaseLock(
  _logDirectory: string,
  lock: AcquiredLock,
  fileSystem: FileSystemOperations
): Promise<void> {
  const current = await readLockRecord(lock.lockPath, fileSystem);
  if (
    current === null ||
    current.token !== lock.token ||
    current.owner !== lock.owner ||
    current.device !== lock.device ||
    current.inode !== lock.inode
  ) {
    return;
  }
  await unlinkIfOwned(lock.lockPath, lock, fileSystem);
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const information = await handle.stat();
  if (information.size > maxBytes) {
    throw new Error("operational log file exceeds maxBytes");
  }
  const content = Buffer.alloc(Number(information.size));
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    if (bytesRead === 0) throw new Error("operational log file changed while being read");
    offset += bytesRead;
  }
  return content;
}

async function replaceThroughHandle(
  source: FileHandle,
  destination: FileHandle,
  maxBytes: number
): Promise<void> {
  const content = await readBounded(source, maxBytes);
  await destination.truncate(0);
  await writeAt(destination, content, 0);
  await destination.truncate(content.length);
}

async function writeAt(handle: FileHandle, content: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      position + offset
    );
    if (bytesWritten === 0) throw new Error("operational log archive write made no progress");
    offset += bytesWritten;
  }
}

async function rotateThroughHandles(
  directory: TrustedDirectory,
  active: FileHandle,
  maxBytes: number,
  maxFiles: number,
  fileSystem: FileSystemOperations
): Promise<void> {
  if (maxFiles === 1) {
    await active.truncate(0);
    return;
  }
  const handles: Array<FileHandle | null> = [active];
  const existed = [true];
  try {
    for (let index = 1; index < maxFiles; index += 1) {
      const handle = await openVerifiedExisting(
        directory,
        `companion.log.${index}`,
        fileSystem
      );
      handles[index] = handle;
      existed[index] = handle !== null;
    }
    for (let index = 1; index < maxFiles; index += 1) {
      if (handles[index] === null && existed[index - 1]) {
        handles[index] = await openVerifiedAppend(
          directory,
          `companion.log.${index}`,
          fileSystem
        );
      }
    }
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      if (!existed[index - 1]) continue;
      const source = handles[index - 1] ?? null;
      const destination = handles[index] ?? null;
      if (source === null || destination === null) {
        throw new Error("operational log rotation handle set is incomplete");
      }
      await replaceThroughHandle(source, destination, maxBytes);
    }
    await active.truncate(0);
  } finally {
    await Promise.all(handles.slice(1).map((handle) => handle?.close().catch(() => undefined)));
  }
}

/** Internal composition seam for deterministic filesystem-boundary tests. */
export function createOperationalLoggerWithFileSystem(
  options: OperationalLoggerOptions,
  fileSystem: FileSystemOperations
): OperationalLogger {
  positiveInteger(options.maxBytes, "maxBytes");
  positiveInteger(options.maxFiles, "maxFiles");
  const logDirectory = resolve(options.logDirectory);
  let trustedDirectoryPromise: Promise<TrustedDirectory> | undefined;
  let pending = Promise.resolve();

  const write = async (entry: OperationalLogEntry): Promise<void> => {
    const serialized = `${JSON.stringify(sanitizeEntry(entry))}\n`;
    const entryBytes = Buffer.byteLength(serialized, "utf8");
    if (entryBytes > options.maxBytes) {
      throw new RangeError("operational log entry exceeds maxBytes");
    }
    trustedDirectoryPromise ??= ensureTrustedDirectory(logDirectory, fileSystem);
    const trustedDirectory = await trustedDirectoryPromise;
    const owner = await processOwnerIdentity();
    const lock = await acquireLock(trustedDirectory, logDirectory, owner, fileSystem);
    try {
      const handle = await openVerifiedAppend(trustedDirectory, "companion.log", fileSystem);
      try {
        const activeSize = Number((await handle.stat()).size);
        if (activeSize + entryBytes > options.maxBytes) {
          await rotateThroughHandles(
            trustedDirectory,
            handle,
            options.maxBytes,
            options.maxFiles,
            fileSystem
          );
        }
        const writePosition = Number((await handle.stat()).size);
        await writeAt(handle, Buffer.from(serialized, "utf8"), writePosition);
        if (Number((await handle.stat()).size) > options.maxBytes) {
          throw new Error("operational log exceeded maxBytes after append");
        }
      } finally {
        await handle.close();
      }
    } finally {
      await releaseLock(logDirectory, lock, fileSystem);
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

export function createOperationalLogger(options: OperationalLoggerOptions): OperationalLogger {
  return createOperationalLoggerWithFileSystem(options, nodeFileSystemOperations);
}
