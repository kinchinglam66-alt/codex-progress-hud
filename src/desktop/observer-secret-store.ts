import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ConsentProtection } from "../estimation/observer-consent-store.js";

const MAX_SECRET_STORE_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 8 * 1024;
const referencePattern = /^[A-Za-z0-9_-]{24,}$/u;
const secretEnvelopeSchema = z.object({
  version: z.literal(1),
  secrets: z.record(z.string(), z.string()),
}).strict();

type SecretEnvelope = z.infer<typeof secretEnvelopeSchema>;

async function readSealed(path: string): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SECRET_STORE_BYTES) {
    throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
  }
  const file = await open(path, "r").catch(() => {
    throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
  });
  try {
    const buffer = Buffer.alloc(MAX_SECRET_STORE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SECRET_STORE_BYTES) throw new Error();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
  } finally {
    await file.close().catch(() => undefined);
  }
}

export function createObserverSecretStore(path: string, protection: ConsentProtection) {
  let mutationTail = Promise.resolve();

  function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function load(strict: boolean): Promise<SecretEnvelope | null> {
    const sealed = await readSealed(path);
    if (sealed === null) return null;
    let raw: string | null;
    try {
      raw = await protection.unprotect(sealed);
    } catch {
      if (strict) throw new Error("OBSERVER_SECRET_STORAGE_UNAVAILABLE");
      return null;
    }
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_SECRET_STORE_BYTES) {
      if (strict) throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
      return null;
    }
    let parsed;
    try {
      parsed = secretEnvelopeSchema.safeParse(JSON.parse(raw));
    } catch {
      if (strict) throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
      return null;
    }
    if (!parsed.success) {
      if (strict) throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
      return null;
    }
    return parsed.data;
  }

  async function save(envelope: SecretEnvelope): Promise<void> {
    const raw = JSON.stringify(envelope);
    let sealed: string;
    try {
      sealed = await protection.protect(raw);
    } catch {
      throw new Error("OBSERVER_SECRET_STORAGE_UNAVAILABLE");
    }
    if (typeof sealed !== "string" || Buffer.byteLength(sealed, "utf8") > MAX_SECRET_STORE_BYTES) {
      throw new Error("OBSERVER_SECRET_STORAGE_INVALID");
    }
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, sealed, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } catch {
      throw new Error("OBSERVER_SECRET_STORAGE_UNAVAILABLE");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  return {
    put(key: string): Promise<string> {
      return serializeMutation(async () => {
      if (!key || Buffer.byteLength(key, "utf8") > MAX_SECRET_BYTES || /[\p{Cc}\p{Cf}]/u.test(key)) {
        throw new Error("OBSERVER_SECRET_INVALID");
      }
      const envelope = (await load(true)) ?? { version: 1 as const, secrets: {} };
      let ref: string;
      do {
        ref = randomBytes(18).toString("base64url");
      } while (ref in envelope.secrets);
      envelope.secrets[ref] = key;
      await save(envelope);
      return ref;
      });
    },
    async read(ref: string): Promise<string | null> {
      if (!referencePattern.test(ref)) return null;
      const envelope = await load(false);
      return envelope?.secrets[ref] ?? null;
    },
    remove(ref: string): Promise<void> {
      return serializeMutation(async () => {
      if (!referencePattern.test(ref)) return;
      const envelope = await load(true);
      if (envelope === null || !(ref in envelope.secrets)) return;
      delete envelope.secrets[ref];
      await save(envelope);
      });
    },
  };
}
