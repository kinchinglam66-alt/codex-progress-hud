import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObserverSecretStore } from "../../src/desktop/observer-secret-store.js";
import type { ConsentProtection } from "../../src/estimation/observer-consent-store.js";

const syntheticKey = "synthetic-api-key-never-for-network-use";

function createSyntheticProtection(): ConsentProtection {
  return {
    protect(value) {
      return `os-v1:${Buffer.from(value, "utf8").toString("base64")}`;
    },
    unprotect(value) {
      if (!value.startsWith("os-v1:")) return null;
      try {
        return Buffer.from(value.slice("os-v1:".length), "base64").toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

describe("observer secret store", () => {
  it("stores synthetic keys through protection under opaque references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-secret-store-"));
    const path = join(directory, "secrets.json");
    try {
      const store = createObserverSecretStore(path, createSyntheticProtection());
      const ref = await store.put(syntheticKey);
      expect(ref).not.toBe(syntheticKey);
      expect(ref).toMatch(/^[A-Za-z0-9_-]{24,}$/u);
      expect(await store.read(ref)).toBe(syntheticKey);
      expect(await readFile(path, "utf8")).not.toContain(syntheticKey);
      expect(await store.read("unknown-ref")).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes a stored key and treats an absent file as empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-secret-store-remove-"));
    const path = join(directory, "secrets.json");
    try {
      const store = createObserverSecretStore(path, createSyntheticProtection());
      expect(await store.read("missing-ref")).toBeNull();
      const ref = await store.put(syntheticKey);
      await store.remove(ref);
      expect(await store.read(ref)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to plaintext when protection is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-secret-store-disabled-"));
    const path = join(directory, "secrets.json");
    const unavailable: ConsentProtection = {
      protect() { throw new Error("provider backend path C:\\private\\token"); },
      unprotect() { throw new Error("provider backend path C:\\private\\token"); },
    };
    try {
      const store = createObserverSecretStore(path, unavailable);
      await expect(store.put(syntheticKey)).rejects.toThrow("OBSERVER_SECRET_STORAGE_UNAVAILABLE");
      await expect(store.put(syntheticKey)).rejects.not.toThrow("C:\\private\\token");
      expect(await store.read("synthetic-ref-12345678901234567890")).toBeNull();
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent puts so no successful key is lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-secret-store-concurrent-"));
    const path = join(directory, "secrets.json");
    try {
      const store = createObserverSecretStore(path, createSyntheticProtection());
      const refs = await Promise.all([
        store.put("synthetic-key-one"),
        store.put("synthetic-key-two"),
      ]);
      expect(await store.read(refs[0]!)).toBe("synthetic-key-one");
      expect(await store.read(refs[1]!)).toBe("synthetic-key-two");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns no key for malformed ciphertext and never replaces it during a failed write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-secret-store-malformed-"));
    const path = join(directory, "secrets.json");
    try {
      await writeFile(path, "os-v1:not-valid-ciphertext");
      const store = createObserverSecretStore(path, createSyntheticProtection());
      expect(await store.read("synthetic-ref")).toBeNull();
      await expect(store.put(syntheticKey)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("os-v1:not-valid-ciphertext");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
