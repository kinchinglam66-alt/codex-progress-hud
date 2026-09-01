import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

export interface TrustedDirectory {
  readonly path: string;
  readonly device: number | bigint;
  readonly inode: number | bigint;
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function informationOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function trustedDirectoryInformation(path: string): Promise<Stats> {
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("diagnostic output requires a trusted directory, not a link");
  }
  const canonical = await realpath(path);
  if (comparablePath(canonical) !== comparablePath(path)) {
    throw new Error("diagnostic output requires a trusted directory path");
  }
  return information;
}

export async function ensureTrustedDirectory(directory: string): Promise<TrustedDirectory> {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let current = root;
  await trustedDirectoryInformation(current);
  const remainder = relative(root, absolute);
  const components = remainder.length === 0 ? [] : remainder.split(sep);
  for (const component of components) {
    current = join(current, component);
    let information = await informationOrNull(current);
    if (information === null) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      information = await lstat(current);
    }
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("diagnostic output requires a trusted directory, not a link");
    }
  }
  const information = await trustedDirectoryInformation(absolute);
  return { path: absolute, device: information.dev, inode: information.ino };
}

export async function assertTrustedDirectory(directory: TrustedDirectory): Promise<void> {
  const information = await lstat(directory.path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("diagnostic output requires a trusted directory, not a link");
  }
  if (information.dev !== directory.device || information.ino !== directory.inode) {
    throw new Error("diagnostic output directory changed before file access");
  }
}

export async function regularFileInformation(path: string): Promise<Stats | null> {
  const information = await informationOrNull(path);
  if (information === null) return null;
  if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1) {
    throw new Error("diagnostic output file must be a regular file, not a link");
  }
  return information;
}

function outputPath(directory: TrustedDirectory, filename: string): string {
  if (basename(filename) !== filename || dirname(filename) !== ".") {
    throw new TypeError("diagnostic output filename must not contain a path");
  }
  return join(directory.path, filename);
}

async function verifyOpenedFile(
  directory: TrustedDirectory,
  path: string,
  handle: FileHandle,
  before: Stats | null
): Promise<void> {
  const opened = await handle.stat();
  if (!opened.isFile()) throw new Error("diagnostic output handle is not a regular file");
  if (opened.nlink !== 1) throw new Error("diagnostic output file must have one link");
  if (before !== null && !sameFile(before, opened)) {
    throw new Error("diagnostic output file changed before it could be opened");
  }
  await assertTrustedDirectory(directory);
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new Error("diagnostic output file must be a regular file, not a link");
  }
  if (!sameFile(current, opened)) {
    throw new Error("diagnostic output path changed before it could be verified");
  }
}

async function openVerified(
  directory: TrustedDirectory,
  filename: string,
  mode: "append" | "create"
): Promise<FileHandle> {
  const path = outputPath(directory, filename);
  await assertTrustedDirectory(directory);
  const before = await regularFileInformation(path);
  if (mode === "create" && before !== null) {
    const error = new Error("diagnostic output file already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  const flags = mode === "create" ? "wx" : before === null ? "ax" : "a";
  const handle = await open(path, flags, 0o600);
  try {
    await verifyOpenedFile(directory, path, handle, before);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function openVerifiedAppend(
  directory: TrustedDirectory,
  filename: string
): Promise<FileHandle> {
  return openVerified(directory, filename, "append");
}

export async function openVerifiedCreate(
  directory: TrustedDirectory,
  filename: string
): Promise<FileHandle> {
  return openVerified(directory, filename, "create");
}
