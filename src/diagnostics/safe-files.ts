import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function ensureTrustedDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory);
  await mkdir(absolute, { recursive: true });
  const information = await lstat(absolute);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("diagnostic output requires a trusted directory, not a link");
  }
  const canonical = await realpath(absolute);
  if (comparablePath(canonical) !== comparablePath(absolute)) {
    throw new Error("diagnostic output requires a trusted directory path");
  }
  return absolute;
}

export async function regularFileInformation(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1) {
      throw new Error("diagnostic output file must be a regular file, not a link");
    }
    return information;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function openVerifiedAppend(path: string): Promise<FileHandle> {
  const before = await regularFileInformation(path);
  const handle = await open(path, before === null ? "ax" : "a", 0o600);
  try {
    const after = await handle.stat();
    if (!after.isFile()) throw new Error("diagnostic output handle is not a regular file");
    if (before !== null && (before.dev !== after.dev || before.ino !== after.ino)) {
      throw new Error("diagnostic output file changed before it could be opened");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
