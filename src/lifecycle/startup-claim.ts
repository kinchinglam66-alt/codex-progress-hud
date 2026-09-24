import { randomUUID } from "node:crypto";
import {
  link,
  rename,
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
  ownerPid?: number;
  childPid?: number;
}

export interface StartupClaimLease extends StartupClaim {
  bindChild(pid:number):Promise<void>;
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
    [candidate.ownerPid,candidate.childPid].some(pid=>pid!==undefined&&(!Number.isSafeInteger(pid)||(pid as number)<=0)) ||
    Object.keys(candidate).some((key) => !["generation", "ownerNonce", "expiresAt", "ownerPid", "childPid"].includes(key))
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

export function createStartupClaimStore(dataDirectory: string, options: { now?: () => number;processAlive?:(pid:number)=>boolean } = {}): StartupClaimStore {
  const now = options.now ?? Date.now;
  const processAlive=options.processAlive??((pid:number)=>{
    try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
  });
  const mayBeAlive=(pid:number|undefined)=>{
    if(pid===undefined)return false;
    try{return processAlive(pid);}catch{return true;}
  };
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
        const candidate: StartupClaim = { generation, ownerNonce: randomUUID(), expiresAt,ownerPid:process.pid };
        const created = await createClaimFile(directory, claimPath, candidate);
        if (created !== undefined) {
          let released = false;
          let currentIdentity=created;
          let mutations:Promise<void>=Promise.resolve();
          const serialize=(operation:()=>Promise<void>)=>{
            const result=mutations.then(operation);mutations=result.catch(()=>undefined);return result;
          };
          return {
            kind: "acquired",
            lease: {
              ...candidate,
              bindChild(pid:number):Promise<void> {return serialize(async()=>{
                if(released||!Number.isSafeInteger(pid)||pid<=0)throw Error('startup child binding invalid');
                await assertTrustedDirectory(directory,nodeFileSystemOperations);
                const existing=await readClaim(directory,claimPath);
                if(!existing||existing.identity.dev!==currentIdentity.dev||existing.identity.ino!==currentIdentity.ino||existing.claim.ownerNonce!==candidate.ownerNonce||existing.claim.generation!==candidate.generation)throw Error('startup ownership changed');
                if(candidate.childPid!==undefined&&candidate.childPid!==pid)throw Error('startup child already bound');
                const temporaryName=`${CLAIM_FILENAME}.${randomUUID()}.bind.tmp`,temporaryPath=join(directory.path,temporaryName);
                let handle:FileHandle|undefined;
                try{
                  handle=await openVerifiedCreate(directory,temporaryName,nodeFileSystemOperations);
                  await handle.writeFile(JSON.stringify({...candidate,childPid:pid})+'\n');await handle.sync();
                  const identity=await handle.stat({bigint:true});await handle.close();handle=undefined;
                  await assertTrustedDirectory(directory,nodeFileSystemOperations);
                  const current=await claimFileInformation(claimPath),temporary=await claimFileInformation(temporaryPath);
                  if(!current||current.dev!==currentIdentity.dev||current.ino!==currentIdentity.ino||!temporary||temporary.dev!==identity.dev||temporary.ino!==identity.ino)throw Error('startup ownership changed');
                  await rename(temporaryPath,claimPath);
                  currentIdentity={dev:identity.dev,ino:identity.ino};candidate.childPid=pid;
                }finally{await handle?.close().catch(()=>undefined);await unlink(temporaryPath).catch(()=>undefined);}
              });},
              release(): Promise<void> {return serialize(async()=>{
                if (released) return;
                released = true;
                await assertTrustedDirectory(directory, nodeFileSystemOperations);
                // Inodes may be reused after an expired claim is removed. The
                // logical owner must still match before an old lease can unlink.
                const existing = await readClaim(directory, claimPath);
                if (!existing || existing.claim.ownerNonce !== candidate.ownerNonce || existing.claim.generation !== candidate.generation) return;
                await unlinkIfIdentical(claimPath, currentIdentity, undefined, nodeLifecycleStateLockFileSystem).catch(() => false);
              });}
            }
          };
        }
        const existing = await readClaim(directory, claimPath);
        if (existing === null) continue;
        // PID liveness is only a conservative fence, never authority to kill a process.
        if (existing.claim.expiresAt <= now()&&!mayBeAlive(existing.claim.childPid??existing.claim.ownerPid)) {
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
