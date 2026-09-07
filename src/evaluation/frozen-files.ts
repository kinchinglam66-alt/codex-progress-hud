import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

export type FrozenSnapshot = {
  pins: Record<string, string>;
  verify(): Promise<void>;
};

type PreparedFile = {
  relativePath: string;
  sourcePath: string;
  size: number;
  bytes: Buffer;
  hash: string;
  signature: FileSignature;
};

type FileSignature = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validateRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail("relative path must be non-empty");
  }
  if (CONTROL_CHARS.test(relativePath) || relativePath.includes("\\")) {
    fail("relative path contains forbidden characters");
  }
  if (isAbsolute(relativePath) || posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath) || /^[A-Za-z]:/u.test(relativePath)) {
    fail("relative path must not be absolute");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail("relative path is not canonical");
  }
  if (posix.normalize(relativePath) !== relativePath) {
    fail("relative path is not canonical");
  }
  return relativePath;
}

async function canonicalDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory);
  const entry = await lstat(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail("root must be a non-symlink directory");
  }
  const canonical = await realpath(absolute);
  if (!samePath(absolute, canonical)) {
    fail("root has a symlinked ancestor");
  }
  return canonical;
}

async function sourceFile(sourceRoot: string, relativePath: string): Promise<string> {
  let current = sourceRoot;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      fail("relative path is not canonical");
    }
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      fail("source path must not contain symlinks");
    }
    if (index < parts.length - 1 && !entry.isDirectory()) {
      fail("source ancestor must be a directory");
    }
    if (index === parts.length - 1 && !entry.isFile()) {
      fail("source path must be a regular file");
    }
  }
  const canonical = await realpath(current);
  if (!samePath(current, canonical)) {
    fail("source path is not canonical");
  }
  return canonical;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signatureOf(stat: { dev: number; ino: number; mtimeMs: number; size: number }): FileSignature {
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

async function readBounded(path: string, expectedSize: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (stat.size !== expectedSize || stat.size > MAX_FILE_BYTES) {
      fail("file size limit exceeded or file changed");
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const result = await handle.read(bytes, offset, stat.size - offset, offset);
      if (result.bytesRead === 0) {
        fail("file changed during read");
      }
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStable(path: string): Promise<{ bytes: Buffer; size: number; hash: string; signature: FileSignature }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail("source changed or is not a regular file");
  }
  if (before.size > MAX_FILE_BYTES) {
    fail("file size limit exceeded");
  }
  const beforeSignature = signatureOf(before);
  const bytes = await readBounded(path, before.size);
  const after = await lstat(path);
  const afterSignature = signatureOf(after);
  if (after.isSymbolicLink() || !after.isFile() || !sameSignature(beforeSignature, afterSignature) || bytes.length !== before.size) {
    fail("source changed during snapshot");
  }
  const hash = digest(bytes);
  return { bytes, size: before.size, hash, signature: beforeSignature };
}

async function assertDestinationFile(root: string, relativePath: string, expectedRoot: string): Promise<string> {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail("destination root changed");
  }
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      fail("relative path is not canonical");
    }
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      fail("destination contains a symlink");
    }
    if (index < parts.length - 1 && !entry.isDirectory()) {
      fail("destination ancestor is not a directory");
    }
    if (index === parts.length - 1 && !entry.isFile()) {
      fail("destination file is not regular");
    }
  }
  const canonical = await realpath(current);
  const expected = resolve(expectedRoot, relativePath);
  if (!samePath(canonical, expected)) {
    fail("destination canonical path mismatch");
  }
  return current;
}

export async function snapshotFiles(
  sourceRoot: string,
  destRoot: string,
  relativePaths: string[],
): Promise<FrozenSnapshot> {
  if (!Array.isArray(relativePaths) || relativePaths.length > MAX_FILES) {
    fail("file count limit exceeded");
  }
  const sourceCanonical = await canonicalDirectory(sourceRoot);
  const seen = new Set<string>();
  const prepared: PreparedFile[] = [];
  let totalBytes = 0;
  for (const candidate of relativePaths) {
    const relativePath = validateRelativePath(candidate);
    const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (seen.has(key)) {
      fail("duplicate relative path");
    }
    seen.add(key);
    const sourcePath = await sourceFile(sourceCanonical, relativePath);
    const source = await readStable(sourcePath);
    totalBytes += source.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail("total size limit exceeded");
    }
    prepared.push({ relativePath, sourcePath, ...source });
  }

  const destination = resolve(destRoot);
  try {
    await mkdir(destination, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("destination root must not already exist");
    }
    throw error;
  }
  const destinationCanonical = await realpath(destination);
  const pins: Record<string, string> = {};
  try {
    for (const file of prepared) {
      const target = join(destination, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(file.bytes);
      } finally {
        await handle.close();
      }
      const sourceAfter = await readStable(file.sourcePath);
      if (!sameSignature(sourceAfter.signature, file.signature) || sourceAfter.hash !== file.hash) {
        fail("source changed during snapshot");
      }
      pins[file.relativePath] = file.hash;
    }
  } catch (error) {
    throw error;
  }

  const trustedPins = { ...pins };
  const publicPins = Object.freeze({ ...trustedPins }) as Record<string, string>;
  return {
    pins: publicPins,
    async verify() {
      const currentRoot = await realpath(destination);
      if (!samePath(currentRoot, destinationCanonical)) {
        fail("destination root canonical path mismatch");
      }
      for (const file of prepared) {
        const target = await assertDestinationFile(destination, file.relativePath, destinationCanonical);
        const verified = await readStable(target);
        if (verified.size !== file.size || verified.hash !== trustedPins[file.relativePath]) {
          fail("destination contents or hash mismatch");
        }
      }
    },
  };
}
