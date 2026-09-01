import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function readToken(path: string): Promise<string> {
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32) throw new Error("HUD token file contains an invalid token");
  return token;
}

export async function loadOrCreateToken(path: string): Promise<string> {
  try {
    return await readToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readToken(path);
  }
}

export function tokensEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

