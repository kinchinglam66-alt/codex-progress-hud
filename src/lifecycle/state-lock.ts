import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface FileIdentity { dev: bigint; ino: bigint; }
interface LockRecord { pid: number; token: string; }
interface AcquiredLock extends LockRecord, FileIdentity { lockPath: string; ownerPath: string; }

const LOCK_TIMEOUT_MS = 5_000;
const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

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

async function information(path: string): Promise<(FileIdentity & { size: bigint }) | null> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("lifecycle lock must be a regular owned file");
    }
    return { dev: stats.dev, ino: stats.ino, size: stats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function unlinkIfIdentical(path: string, identity: FileIdentity): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await information(path);
    if (current === null || !sameIdentity(current, identity)) return false;
    try {
      await unlink(path);
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

async function readLock(lockPath: string): Promise<(LockRecord & FileIdentity) | null> {
  const before = await information(lockPath);
  if (before === null) return null;
  if (before.size > 512n) throw new Error("lifecycle lock metadata is invalid");
  let content: string;
  try {
    content = await retryWindowsSharing(() => readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const after = await information(lockPath);
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
  signal?: AbortSignal
): Promise<AcquiredLock> {
  const timeoutMs = Math.max(0, Math.min(callerTimeoutMs ?? LOCK_TIMEOUT_MS, LOCK_TIMEOUT_MS));
  if (timeoutMs === 0 || signal?.aborted) throw new LifecycleStateTimeoutError();
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const ownerPath = `${lockPath}.owner-${process.pid}-${token}`;
  await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, { flag: "wx", mode: 0o600 });
  const owner = await information(ownerPath);
  if (owner === null) throw new Error("lifecycle lock owner was not created");
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (Date.now() >= deadline || signal?.aborted) throw new LifecycleStateTimeoutError();
      try {
        await link(ownerPath, lockPath);
        if (signal?.aborted) {
          await unlinkIfIdentical(lockPath, owner);
          throw new LifecycleStateTimeoutError();
        }
        const published = await readLock(lockPath);
        if (published === null || published.pid !== process.pid || published.token !== token) {
          throw new Error("lifecycle lock publication could not be verified");
        }
        return { ...published, lockPath, ownerPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = await readLock(lockPath);
      if (existing !== null && !processIsAlive(existing.pid)) {
        await unlinkIfIdentical(lockPath, existing);
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal?.aborted) throw new LifecycleStateTimeoutError();
      await delay(Math.min(5 + Math.floor(Math.random() * 11), remainingMs));
    }
  } catch (error) {
    await unlinkIfIdentical(ownerPath, owner).catch(() => undefined);
    throw error;
  }
}

async function release(lock: AcquiredLock): Promise<void> {
  const current = await readLock(lock.lockPath);
  if (current !== null && current.pid === lock.pid && current.token === lock.token && sameIdentity(current, lock)) {
    await unlinkIfIdentical(lock.lockPath, lock);
  }
  const owner = await information(lock.ownerPath);
  if (owner !== null) await unlinkIfIdentical(lock.ownerPath, owner);
}

export async function withLifecycleStateLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<T> {
  const lock = await acquire(lockPath, timeoutMs, signal);
  try {
    if (signal?.aborted) throw new LifecycleStateTimeoutError();
    return await operation();
  }
  finally { await release(lock); }
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

export async function identityOf(path: string): Promise<FileIdentity | null> {
  const stats = await information(path);
  return stats === null ? null : { dev: stats.dev, ino: stats.ino };
}
