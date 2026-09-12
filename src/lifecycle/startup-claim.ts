import { randomUUID } from "node:crypto";
import {
  link,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { join } from "node:path";
import {
  assertTrustedDirectory,
  ensureTrustedDirectory,
  nodeFileSystemOperations,
  openVerifiedCreate,
  type TrustedDirectory
} from "../diagnostics/safe-files.js";
import { nodeLifecycleStateLockFileSystem, unlinkIfIdentical } from "./state-lock.js";

export interface StartupClaim {
  generation: number;
  ownerNonce: string;
  expiresAt: number;
}

export interface StartupClaimLease extends StartupClaim {
  release(): Promise<void>;
}

export type StartupClaimAttempt =
  | { kind: "acquired"; lease: StartupClaimLease }
  | { kind: "held"; claim: StartupClaim };

export interface StartupClaimStore {
  tryAcquire(generation: number, expiresAt: number): Promise<StartupClaimAttempt>;
}

const CLAIM_FILENAME = ".companion-startup-claim.json";
const MAX_CLAIM_BYTES = 1_024;
const MAX_ACQUIRE_ATTEMPTS = 32;

async function claimFileInformation(path: string): Promise<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  nlink: bigint;
} | null> {
  try {
    const information = await nodeFileSystemOperations.lstatBigInt(path);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      (information.nlink !== 1n && information.nlink !== 2n)
    ) throw new Error("startup claim must be a regular file");
    return information;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertClaim(claim: unknown): asserts claim is StartupClaim {
  if (typeof claim !== "object" || claim === null) throw new Error("startup claim is invalid");
  const candidate = claim as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 0 ||
    typeof candidate.ownerNonce !== "string" ||
    candidate.ownerNonce.length === 0 ||
    candidate.ownerNonce.length > 64 ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    (candidate.expiresAt as number) < 0 ||
    Object.keys(candidate).some((key) => !["generation", "ownerNonce", "expiresAt"].includes(key))
  ) throw new Error("startup claim is invalid");
}

async function readClaim(
  trustedDirectory: TrustedDirectory,
  claimPath: string
): Promise<{ claim: StartupClaim; identity: { dev: bigint; ino: bigint } } | null> {
  await assertTrustedDirectory(trustedDirectory, nodeFileSystemOperations);
  const before = await claimFileInformation(claimPath);
  if (before === null) return null;
  if (before.size > BigInt(MAX_CLAIM_BYTES)) throw new Error("startup claim is too large");
  let handle: FileHandle | undefined;
  try {
    handle = await nodeFileSystemOperations.open(claimPath, "r");
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      (opened.nlink !== 1n && opened.nlink !== 2n) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) throw new Error("startup claim changed before it could be read");
    const buffer = Buffer.allocUnsafe(MAX_CLAIM_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CLAIM_BYTES) throw new Error("startup claim is too large");
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size > BigInt(MAX_CLAIM_BYTES)
    ) throw new Error("startup claim changed while it was read");
    let claim: unknown;
    try { claim = JSON.parse(content); } catch { throw new Error("startup claim is invalid"); }
    assertClaim(claim);
    await assertTrustedDirectory(trustedDirectory, nodeFileSystemOperations);
    return { claim, identity: { dev: after.dev, ino: after.ino } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createClaimFile(
  trustedDirectory: TrustedDirectory,
  claimPath: string,
  claim: StartupClaim
): Promise<{ dev: bigint; ino: bigint } | undefined> {
  await assertTrustedDirectory(trustedDirectory, nodeFileSystemOperations);
  const temporaryName = `${CLAIM_FILENAME}.${process.pid}-${randomUUID()}.tmp`;
  const temporaryPath = join(trustedDirectory.path, temporaryName);
  let temporaryHandle: FileHandle | undefined;
  try {
    temporaryHandle = await openVerifiedCreate(trustedDirectory, temporaryName, nodeFileSystemOperations);
    await temporaryHandle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
    await temporaryHandle.sync();
    const temporaryIdentity = await temporaryHandle.stat({ bigint: true });
    await link(temporaryPath, claimPath);
    await assertTrustedDirectory(trustedDirectory, nodeFileSystemOperations);
    const linkedIdentity = await nodeFileSystemOperations.lstatBigInt(claimPath);
    if (
      !linkedIdentity.isFile() ||
      linkedIdentity.dev !== temporaryIdentity.dev ||
      linkedIdentity.ino !== temporaryIdentity.ino
    ) throw new Error("startup claim changed during acquisition");
    await unlink(temporaryPath);
    await assertTrustedDirectory(trustedDirectory, nodeFileSystemOperations);
    const publishedIdentity = await nodeFileSystemOperations.lstatBigInt(claimPath);
    if (
      !publishedIdentity.isFile() ||
      publishedIdentity.dev !== temporaryIdentity.dev ||
      publishedIdentity.ino !== temporaryIdentity.ino
    ) throw new Error("startup claim changed after acquisition");
    return { dev: temporaryIdentity.dev, ino: temporaryIdentity.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function createStartupClaimStore(dataDirectory: string, options: { now?: () => number } = {}): StartupClaimStore {
  const now = options.now ?? Date.now;
  const claimPath = join(dataDirectory, CLAIM_FILENAME);
  let trustedDirectoryPromise: Promise<TrustedDirectory> | undefined;
  const trustedDirectory = () => trustedDirectoryPromise ??= ensureTrustedDirectory(dataDirectory);

  return {
    async tryAcquire(generation, expiresAt): Promise<StartupClaimAttempt> {
      if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("generation must be a non-negative integer");
      if (!Number.isSafeInteger(expiresAt) || expiresAt < now()) throw new TypeError("startup claim expiry must be in the future");
      const directory = await trustedDirectory();
      for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
        await assertTrustedDirectory(directory, nodeFileSystemOperations);
        const candidate: StartupClaim = { generation, ownerNonce: randomUUID(), expiresAt };
        const created = await createClaimFile(directory, claimPath, candidate);
        if (created !== undefined) {
          let released = false;
          return {
            kind: "acquired",
            lease: {
              ...candidate,
              async release(): Promise<void> {
                if (released) return;
                released = true;
                await assertTrustedDirectory(directory, nodeFileSystemOperations);
                await unlinkIfIdentical(claimPath, created, undefined, nodeLifecycleStateLockFileSystem).catch(() => false);
              }
            }
          };
        }
        const existing = await readClaim(directory, claimPath);
        if (existing === null) continue;
        if (existing.claim.expiresAt <= now()) {
          await unlinkIfIdentical(claimPath, existing.identity, undefined, nodeLifecycleStateLockFileSystem).catch(() => false);
          continue;
        }
        return { kind: "held", claim: existing.claim };
      }
      throw new Error("startup claim acquisition contention");
    }
  };
}

export const startupClaimFilename = CLAIM_FILENAME;
