import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotFiles } from "../../src/evaluation/frozen-files.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "frozen-files-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const destRoot = join(root, "snapshot");
  await mkdir(join(sourceRoot, "nested"), { recursive: true });
  await writeFile(join(sourceRoot, "alpha.txt"), Buffer.from("alpha\0bytes"));
  await writeFile(join(sourceRoot, "nested", "beta.js"), Buffer.from("module.exports = 7;\n"));
  return { root, sourceRoot, destRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshotFiles", () => {
  it("copies exact bytes, records hashes, and verifies the snapshot", async () => {
    const { sourceRoot, destRoot } = await fixture();
    const snapshot = await snapshotFiles(sourceRoot, destRoot, ["alpha.txt", "nested/beta.js"]);

    expect(snapshot.pins).toEqual({
      "alpha.txt": createHash("sha256").update("alpha\0bytes").digest("hex"),
      "nested/beta.js": createHash("sha256").update("module.exports = 7;\n").digest("hex"),
    });
    expect(await readFile(join(destRoot, "alpha.txt"))).toEqual(Buffer.from("alpha\0bytes"));
    await expect(snapshot.verify()).resolves.toBeUndefined();
  });

  it("freezes exposed pins without allowing trust-anchor mutation", async () => {
    const { sourceRoot, destRoot } = await fixture();
    const snapshot = await snapshotFiles(sourceRoot, destRoot, ["alpha.txt"]);

    expect(Object.isFrozen(snapshot.pins)).toBe(true);
    try {
      snapshot.pins["alpha.txt"] = "attacker-controlled-hash";
    } catch {
      // Strict-mode assignment to the frozen public view may throw.
    }
    await expect(snapshot.verify()).resolves.toBeUndefined();
  });

  it("rejects non-canonical, unsafe, duplicate, absolute, and control-character paths", async () => {
    const { sourceRoot, destRoot } = await fixture();
    for (const paths of [
      ["../alpha.txt"], ["nested/../alpha.txt"], ["nested//beta.js"], ["./alpha.txt"],
      ["alpha.txt", "alpha.txt"], ["C:/alpha.txt"], ["nested\\beta.js"], ["bad\u0000name"], [""],
    ]) {
      await expect(snapshotFiles(sourceRoot, destRoot, paths)).rejects.toThrow();
    }
  });

  it("rejects a pre-existing destination and symlinked source or ancestor", async () => {
    const { root, sourceRoot, destRoot } = await fixture();
    await mkdir(destRoot);
    await expect(snapshotFiles(sourceRoot, destRoot, ["alpha.txt"])).rejects.toThrow();

    const linkedRoot = join(root, "linked-source");
    try {
      await symlink(sourceRoot, linkedRoot, "junction");
    } catch {
      return;
    }
    await expect(snapshotFiles(linkedRoot, join(root, "snapshot-2"), ["alpha.txt"])).rejects.toThrow();
  });

  it("enforces file, total, and file-count limits", async () => {
    const { root, sourceRoot, destRoot } = await fixture();
    await writeFile(join(sourceRoot, "too-large.bin"), Buffer.alloc(1_048_577));
    await expect(snapshotFiles(sourceRoot, destRoot, ["too-large.bin"])).rejects.toThrow(/size|limit/i);

    const totalSource = join(root, "total-source");
    await mkdir(totalSource);
    for (let index = 0; index < 17; index += 1) {
      await writeFile(join(totalSource, `file-${index}.bin`), Buffer.alloc(1_048_576));
    }
    await expect(snapshotFiles(totalSource, join(root, "total-snapshot"), Array.from({ length: 17 }, (_, index) => `file-${index}.bin`))).rejects.toThrow(/total|limit/i);

    const manySource = join(root, "many-source");
    await mkdir(manySource);
    const paths = [];
    for (let index = 0; index < 129; index += 1) {
      const path = `file-${index}.txt`;
      paths.push(path);
      await writeFile(join(manySource, path), "x");
    }
    await expect(snapshotFiles(manySource, join(root, "many-snapshot"), paths)).rejects.toThrow(/files|limit/i);
  });

  it("rejects symlink, mutation, missing, replacement, and canonical-mismatch destinations during verify", async () => {
    const { root, sourceRoot, destRoot } = await fixture();
    const snapshot = await snapshotFiles(sourceRoot, destRoot, ["alpha.txt"]);

    await writeFile(join(destRoot, "alpha.txt"), "mutated");
    await expect(snapshot.verify()).rejects.toThrow();

    await rm(join(destRoot, "alpha.txt"));
    await expect(snapshot.verify()).rejects.toThrow();

    try {
      await symlink(join(sourceRoot, "alpha.txt"), join(destRoot, "alpha.txt"));
    } catch {
      return;
    }
    await expect(snapshot.verify()).rejects.toThrow();

    const replacementRoot = join(root, "replacement");
    const replacement = await snapshotFiles(sourceRoot, replacementRoot, ["alpha.txt"]);
    await rm(join(replacementRoot, "alpha.txt"));
    await writeFile(join(replacementRoot, "alpha.txt"), "replacement");
    await expect(replacement.verify()).rejects.toThrow();
  });

  it("rejects oversized destination replacements before reading them", async () => {
    const { sourceRoot, destRoot } = await fixture();
    const snapshot = await snapshotFiles(sourceRoot, destRoot, ["alpha.txt"]);
    await writeFile(join(destRoot, "alpha.txt"), Buffer.alloc(1_048_577));
    await expect(snapshot.verify()).rejects.toThrow(/size|limit/i);
  });

});
