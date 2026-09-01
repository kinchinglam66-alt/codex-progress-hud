import type { BigIntStats, PathLike } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

export interface TrustedDirectory {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface FileSystemOperations {
  readonly lstatBigInt: (path: PathLike) => Promise<BigIntStats>;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly realpath: typeof realpath;
}

export const nodeFileSystemOperations: FileSystemOperations = {
  lstatBigInt: (path) => lstat(path, { bigint: true }),
  mkdir,
  open,
  realpath
};

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFile(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function informationOrNull(
  path: string,
  fileSystem: FileSystemOperations
): Promise<BigIntStats | null> {
  try {
    return await fileSystem.lstatBigInt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function trustedDirectoryInformation(
  path: string,
  fileSystem: FileSystemOperations
): Promise<BigIntStats> {
  const information = await fileSystem.lstatBigInt(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("diagnostic output requires a trusted directory, not a link");
  }
  const canonical = await fileSystem.realpath(path);
  if (comparablePath(canonical) !== comparablePath(path)) {
    throw new Error("diagnostic output requires a trusted directory path");
  }
  return information;
}

export async function ensureTrustedDirectory(
  directory: string,
  fileSystem: FileSystemOperations = nodeFileSystemOperations
): Promise<TrustedDirectory> {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let current = root;
  await trustedDirectoryInformation(current, fileSystem);
  const remainder = relative(root, absolute);
  const components = remainder.length === 0 ? [] : remainder.split(sep);
  for (const component of components) {
    current = join(current, component);
    let information = await informationOrNull(current, fileSystem);
    if (information === null) {
      try {
        await fileSystem.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      information = await fileSystem.lstatBigInt(current);
    }
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("diagnostic output requires a trusted directory, not a link");
    }
  }
  const information = await trustedDirectoryInformation(absolute, fileSystem);
  return { path: absolute, device: information.dev, inode: information.ino };
}

export async function assertTrustedDirectory(
  directory: TrustedDirectory,
  fileSystem: FileSystemOperations = nodeFileSystemOperations
): Promise<void> {
  const information = await fileSystem.lstatBigInt(directory.path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("diagnostic output requires a trusted directory, not a link");
  }
  if (information.dev !== directory.device || information.ino !== directory.inode) {
    throw new Error("diagnostic output directory changed before file access");
  }
}

export async function regularFileInformation(
  path: string,
  fileSystem: FileSystemOperations = nodeFileSystemOperations
): Promise<BigIntStats | null> {
  const information = await informationOrNull(path, fileSystem);
  if (information === null) return null;
  if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1n) {
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
  before: BigIntStats | null,
  fileSystem: FileSystemOperations
): Promise<void> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) throw new Error("diagnostic output handle is not a regular file");
  if (opened.nlink !== 1n) throw new Error("diagnostic output file must have one link");
  if (before !== null && !sameFile(before, opened)) {
    throw new Error("diagnostic output file changed before it could be opened");
  }
  await assertTrustedDirectory(directory, fileSystem);
  const current = await fileSystem.lstatBigInt(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
    throw new Error("diagnostic output file must be a regular file, not a link");
  }
  if (!sameFile(current, opened)) {
    throw new Error("diagnostic output path changed before it could be verified");
  }
}

async function openVerified(
  directory: TrustedDirectory,
  filename: string,
  mode: "append" | "create",
  fileSystem: FileSystemOperations
): Promise<FileHandle> {
  const path = outputPath(directory, filename);
  await assertTrustedDirectory(directory, fileSystem);
  const before = await regularFileInformation(path, fileSystem);
  if (mode === "create" && before !== null) {
    const error = new Error("diagnostic output file already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  const flags = mode === "create" ? "wx" : before === null ? "wx+" : "r+";
  const handle = await fileSystem.open(path, flags, 0o600);
  try {
    await verifyOpenedFile(directory, path, handle, before, fileSystem);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function openVerifiedAppend(
  directory: TrustedDirectory,
  filename: string,
  fileSystem: FileSystemOperations = nodeFileSystemOperations
): Promise<FileHandle> {
  return openVerified(directory, filename, "append", fileSystem);
}

export async function openVerifiedCreate(
  directory: TrustedDirectory,
  filename: string,
  fileSystem: FileSystemOperations = nodeFileSystemOperations
): Promise<FileHandle> {
  return openVerified(directory, filename, "create", fileSystem);
}

export async function openVerifiedExisting(
  directory: TrustedDirectory,
  filename: string,
  fileSystem: FileSystemOperations = nodeFileSystemOperations
): Promise<FileHandle | null> {
  const path = outputPath(directory, filename);
  await assertTrustedDirectory(directory, fileSystem);
  const before = await regularFileInformation(path, fileSystem);
  if (before === null) return null;
  const handle = await fileSystem.open(path, "r+", 0o600);
  try {
    await verifyOpenedFile(directory, path, handle, before, fileSystem);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
