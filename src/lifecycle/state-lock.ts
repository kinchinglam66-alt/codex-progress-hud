import { randomUUID } from "node:crypto";
import {
  link as nodeLink,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile
} from "node:fs/promises";
import { dirname } from "node:path";

interface FileIdentity { dev: bigint; ino: bigint; }
interface LockRecord { pid: number; token: string; }
interface AcquiredLock extends LockRecord, FileIdentity { lockPath: string; ownerPath: string; }

const LOCK_TIMEOUT_MS = 5_000;
const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export interface LifecycleStateLockFileSystem {
  link: typeof nodeLink;
  lstat: typeof nodeLstat;
  mkdir: typeof nodeMkdir;
  readFile: typeof nodeReadFile;
  unlink: typeof nodeUnlink;
  writeFile: typeof nodeWriteFile;
}

export const nodeLifecycleStateLockFileSystem: LifecycleStateLockFileSystem = {
  link: nodeLink,
  lstat: nodeLstat,
  mkdir: nodeMkdir,
  readFile: nodeReadFile,
  unlink: nodeUnlink,
  writeFile: nodeWriteFile
};

export class LifecycleStateTimeoutError extends Error {
  constructor() {
    super("lifecycle state lock timed out");
    this.name = "LifecycleStateTimeoutError";
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function information(
  path: string,
  fileSystem: LifecycleStateLockFileSystem
): Promise<(FileIdentity & { size: bigint }) | null> {
  try {
    const stats = await fileSystem.lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("lifecycle lock must be a regular owned file");
    }
    return { dev: stats.dev, ino: stats.ino, size: stats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function unlinkIfIdentical(
  path: string,
  identity: FileIdentity,
  signal?: AbortSignal,
  fileSystem: LifecycleStateLockFileSystem = nodeLifecycleStateLockFileSystem,
  beforeUnlink?: () => void
): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (signal?.aborted) throw new LifecycleStateTimeoutError();
    const current = await information(path, fileSystem);
    if (current === null || !sameIdentity(current, identity)) return false;
    if (signal?.aborted) throw new LifecycleStateTimeoutError();
    try {
      beforeUnlink?.();
      await fileSystem.unlink(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (!RETRYABLE_CODES.has(code ?? "") || attempt === 11) throw error;
      await delay(Math.min(5 * 2 ** attempt, 100));
    }
  }
  return false;
}

async function readLock(
  lockPath: string,
  fileSystem: LifecycleStateLockFileSystem
): Promise<(LockRecord & FileIdentity) | null> {
  const before = await information(lockPath, fileSystem);
  if (before === null) return null;
  if (before.size > 512n) throw new Error("lifecycle lock metadata is invalid");
  let content: string;
  try {
    content = await retryWindowsSharing(() => fileSystem.readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const after = await information(lockPath, fileSystem);
  if (after === null || !sameIdentity(before, after)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("lifecycle lock metadata is invalid"); }
  if (
    typeof parsed !== "object" || parsed === null || Object.keys(parsed).length !== 2 ||
    !("pid" in parsed) || !("token" in parsed) || !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 || typeof parsed.token !== "string" || parsed.token.length === 0
  ) throw new Error("lifecycle lock metadata is invalid");
  return { pid: parsed.pid as number, token: parsed.token, dev: after.dev, ino: after.ino };
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function acquire(
  lockPath: string,
  callerTimeoutMs?: number,
  signal?: AbortSignal,
  fileSystem: LifecycleStateLockFileSystem = nodeLifecycleStateLockFileSystem
): Promise<AcquiredLock> {
  const timeoutMs = Math.max(0, Math.min(callerTimeoutMs ?? LOCK_TIMEOUT_MS, LOCK_TIMEOUT_MS));
  if (timeoutMs === 0 || signal?.aborted) throw new LifecycleStateTimeoutError();
  const deadline = Date.now() + timeoutMs;
  await fileSystem.mkdir(dirname(lockPath), { recursive: true });
  if (Date.now() >= deadline || signal?.aborted) throw new LifecycleStateTimeoutError();
  const token = randomUUID();
  const ownerPath = `${lockPath}.owner-${process.pid}-${token}`;
  await fileSystem.writeFile(
    ownerPath,
    `${JSON.stringify({ pid: process.pid, token })}\n`,
    { flag: "wx", mode: 0o600 }
  );
  const owner = await information(ownerPath, fileSystem);
  if (owner === null) throw new Error("lifecycle lock owner was not created");
  try {
    if (Date.now() >= deadline || signal?.aborted) throw new LifecycleStateTimeoutError();
    for (;;) {
      if (Date.now() >= deadline || signal?.aborted) throw new LifecycleStateTimeoutError();
      try {
        await fileSystem.link(ownerPath, lockPath);
        if (signal?.aborted) {
          await unlinkIfIdentical(lockPath, owner, undefined, fileSystem);
          throw new LifecycleStateTimeoutError();
        }
        const published = await readLock(lockPath, fileSystem);
        if (published === null || published.pid !== process.pid || published.token !== token) {
          throw new Error("lifecycle lock publication could not be verified");
        }
        return { ...published, lockPath, ownerPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = await readLock(lockPath, fileSystem);
      if (existing !== null && !processIsAlive(existing.pid)) {
        await unlinkIfIdentical(lockPath, existing, signal, fileSystem);
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal?.aborted) throw new LifecycleStateTimeoutError();
      await delay(Math.min(5 + Math.floor(Math.random() * 11), remainingMs));
    }
  } catch (error) {
    await unlinkIfIdentical(ownerPath, owner, undefined, fileSystem).catch(() => undefined);
    throw error;
  }
}

async function release(
  lock: AcquiredLock,
  fileSystem: LifecycleStateLockFileSystem
): Promise<void> {
  const current = await readLock(lock.lockPath, fileSystem);
  if (current !== null && current.pid === lock.pid && current.token === lock.token && sameIdentity(current, lock)) {
    await unlinkIfIdentical(lock.lockPath, lock, undefined, fileSystem);
  }
  const owner = await information(lock.ownerPath, fileSystem);
  if (owner !== null) await unlinkIfIdentical(lock.ownerPath, owner, undefined, fileSystem);
}

const RELEASE_DEADLINE = Symbol("release-deadline");

async function releaseWithinDeadline(
  lock: AcquiredLock,
  deadline: number | undefined,
  fileSystem: LifecycleStateLockFileSystem
): Promise<void> {
  const releasing = release(lock, fileSystem);
  if (deadline === undefined) {
    await releasing;
    return;
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    // Release touches only identity-checked lock artifacts, so it may safely
    // finish after the caller's hard boundary without mutating product state.
    void releasing.catch(() => undefined);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    releasing.then(() => undefined),
    new Promise<typeof RELEASE_DEADLINE>((resolve_) => {
      timer = setTimeout(() => resolve_(RELEASE_DEADLINE), remainingMs);
    })
  ]);
  if (timer !== undefined) clearTimeout(timer);
  // The same identity checks prevent this detached owner from deleting a
  // successor lock that reused the path after the deadline.
  if (result === RELEASE_DEADLINE) void releasing.catch(() => undefined);
}

export async function withLifecycleStateLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs?: number,
  signal?: AbortSignal,
  fileSystem: LifecycleStateLockFileSystem = nodeLifecycleStateLockFileSystem
): Promise<T> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(0, timeoutMs);
  const lock = await acquire(lockPath, timeoutMs, signal, fileSystem);
  try {
    if (signal?.aborted) throw new LifecycleStateTimeoutError();
    const value = await operation();
    if (signal?.aborted) throw new LifecycleStateTimeoutError();
    return value;
  }
  finally { await releaseWithinDeadline(lock, deadline, fileSystem); }
}

export async function retryWindowsSharing<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!RETRYABLE_CODES.has(code ?? "") || attempt >= 11) throw error;
      await delay(Math.min(5 * 2 ** attempt, 100));
    }
  }
}

export async function identityOf(
  path: string,
  fileSystem: LifecycleStateLockFileSystem = nodeLifecycleStateLockFileSystem
): Promise<FileIdentity | null> {
  const stats = await information(path, fileSystem);
  return stats === null ? null : { dev: stats.dev, ino: stats.ino };
}
