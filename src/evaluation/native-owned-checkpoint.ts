import {lstat, open, realpath} from "node:fs/promises";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {parseCodexCheckpoint, type NativeCodexCheckpoint} from "../observer/codex-checkpoint.js";

export interface ReadOwnedNativeCheckpointOptions {
  runtimeHome: string;
  path: string;
  sourceThreadId: string;
  forkThreadId: string;
  custodyTag: string;
  maxBytes: number;
  verifyStorage: () => Promise<void>;
}

export type OwnedNativeCheckpoint = {
  checkpoint: NativeCodexCheckpoint;
  envelope: Readonly<Record<string, unknown>>;
};

type FileStats = Awaited<ReturnType<typeof lstat>>;

const canonical = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function below(child: string, parent: string): boolean {
  const childPath = resolve(child);
  const parentPath = resolve(parent);
  const remainder = relative(parentPath, childPath);
  return remainder.length > 0 && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

function identity(stat: FileStats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}`;
}

function sizeOf(stat: FileStats): number {
  const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
  if (!Number.isSafeInteger(size) || size < 0) throw Error("NATIVE_CHECKPOINT_BOUND");
  return size;
}

function regularSingleLink(stat: FileStats): boolean {
  return stat.isFile() && stat.nlink === 1;
}

async function safePath(path: string, directory: boolean): Promise<FileStats> {
  if (!isAbsolute(path)) throw Error("NATIVE_CHECKPOINT_PATH");
  const resolved = resolve(path);
  for (let current = resolved;; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || canonical(await realpath(current)) !== canonical(current)) {
      throw Error("NATIVE_CHECKPOINT_REPARSE");
    }
    if (current !== resolved && !stat.isDirectory()) throw Error("NATIVE_CHECKPOINT_PATH");
    if (dirname(current) === current) break;
  }
  const stat = await lstat(resolved);
  if (directory ? !stat.isDirectory() : !regularSingleLink(stat)) throw Error("NATIVE_CHECKPOINT_PATH");
  return stat;
}

function parseLine(line: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!object(parsed)) throw Error("NATIVE_CHECKPOINT_METADATA");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "NATIVE_CHECKPOINT_METADATA") throw error;
    throw Error("NATIVE_CHECKPOINT_METADATA");
  }
}

/** Diagnostic-only readback of a bounded, exactly owned rollout. No model RPC. */
export async function readOwnedNativeRollout(
  options: ReadOwnedNativeCheckpointOptions
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  if (!isAbsolute(options.runtimeHome) || !isAbsolute(options.path) || options.runtimeHome === options.path) {
    throw Error("NATIVE_CHECKPOINT_PATH");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw Error("NATIVE_CHECKPOINT_BOUND");
  if (options.forkThreadId === options.sourceThreadId) throw Error("NATIVE_CHECKPOINT_SOURCE_COLLISION");
  if (!below(options.path, options.runtimeHome)) throw Error("NATIVE_CHECKPOINT_OUTSIDE_HOME");

  await options.verifyStorage();
  await safePath(options.runtimeHome, true);
  const before = await safePath(options.path, false);
  const runtimeCanonical = canonical(await realpath(options.runtimeHome));
  const pathCanonical = canonical(await realpath(options.path));
  if (!below(pathCanonical, runtimeCanonical)) throw Error("NATIVE_CHECKPOINT_OUTSIDE_HOME");
  const capturedSize = sizeOf(before);
  if (capturedSize > options.maxBytes) throw Error("NATIVE_CHECKPOINT_BOUND");

  const handle = await open(options.path, "r");
  try {
    const opened = await handle.stat();
    if (!regularSingleLink(opened) || identity(opened) !== identity(before)) {
      throw Error("NATIVE_CHECKPOINT_REPLACED");
    }

    const bytes = Buffer.alloc(capturedSize);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead <= 0) throw Error("NATIVE_CHECKPOINT_PARTIAL");
      offset += result.bytesRead;
    }

    const finalHandle = await handle.stat();
    if (!regularSingleLink(finalHandle) || identity(finalHandle) !== identity(before)) {
      throw Error("NATIVE_CHECKPOINT_REPLACED");
    }
    let finalPath: FileStats;
    try {
      finalPath = await safePath(options.path, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error("NATIVE_CHECKPOINT_REPLACED");
      throw error;
    }
    if (identity(finalPath) !== identity(before)) throw Error("NATIVE_CHECKPOINT_REPLACED");
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw Error("NATIVE_CHECKPOINT_PARTIAL");

    let text: string;
    try {
      text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    } catch {
      throw Error("NATIVE_CHECKPOINT_METADATA");
    }
    const lines = text.slice(0, -1).split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
    if (lines.length === 0 || lines[0] === "") throw Error("NATIVE_CHECKPOINT_METADATA");
    const first = parseLine(lines[0]!);
    const firstPayload = first.payload;
    if (first.type !== "session_meta" || !object(firstPayload)) throw Error("NATIVE_CHECKPOINT_METADATA");
    if (firstPayload.id === options.sourceThreadId) throw Error("NATIVE_CHECKPOINT_SOURCE_COLLISION");
    if (firstPayload.id !== options.forkThreadId || firstPayload.thread_source !== options.custodyTag) {
      throw Error("NATIVE_CHECKPOINT_METADATA");
    }

    const records:Readonly<Record<string,unknown>>[]=[Object.freeze(first)];
    for (const line of lines.slice(1)) {
      if (line === "") throw Error("NATIVE_CHECKPOINT_METADATA");
      records.push(Object.freeze(parseLine(line)));
    }
    return Object.freeze(records);
  } finally {
    await handle.close();
  }
}

export async function readOwnedNativeCheckpoint(options:ReadOwnedNativeCheckpointOptions):Promise<OwnedNativeCheckpoint>{
  const records=await readOwnedNativeRollout(options);
  const latest=records.filter(record=>record.type==='compacted').at(-1);
  if(!latest)throw Error('NATIVE_CHECKPOINT_NO_COMPACTED');
  const checkpoint=parseCodexCheckpoint(latest);
  if(!checkpoint)throw Error('NATIVE_CHECKPOINT_NO_COMPACTED');
  return {checkpoint,envelope:latest};
}
