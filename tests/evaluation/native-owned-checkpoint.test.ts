import {link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {readOwnedNativeCheckpoint, readOwnedNativeRollout} from "../../src/evaluation/native-owned-checkpoint.js";

var realOpen: typeof import("node:fs/promises").open;
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  realOpen = actual.open;
  return {...actual, open: vi.fn(actual.open)};
});

const SOURCE_THREAD_ID = "source-thread";
const FORK_THREAD_ID = "fork-thread";
const CUSTODY_TAG = "hud_native_test-custody";
const roots: string[] = [];

function compacted(summary: string): Record<string, unknown> {
  return {
    type: "compacted",
    payload: {
      replacement_history: [
        {type: "message", role: "user", content: [{type: "input_text", text: `synthetic-${summary}`}]},
        {type: "compaction", encrypted_content: `opaque-${summary}`}
      ]
    }
  };
}

function metadata(id = FORK_THREAD_ID, tag = CUSTODY_TAG): Record<string, unknown> {
  return {type: "session_meta", payload: {id, thread_source: tag}};
}

function rollout(...records: Record<string, unknown>[]): string {
  return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

async function fixture(contents = rollout(metadata(), compacted("latest"))): Promise<{root: string; file: string}> {
  const root = await mkdtemp(join(tmpdir(), "native-owned-checkpoint-"));
  roots.push(root);
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const file = join(sessions, "fork.jsonl");
  await writeFile(file, contents, {encoding: "utf8", mode: 0o600});
  return {root, file};
}

function options(root: string, file: string, maxBytes = 1024 * 1024) {
  return {
    runtimeHome: root,
    path: file,
    sourceThreadId: SOURCE_THREAD_ID,
    forkThreadId: FORK_THREAD_ID,
    custodyTag: CUSTODY_TAG,
    maxBytes,
    verifyStorage: async () => {}
  };
}

afterEach(async () => {
  const open = vi.mocked((await import("node:fs/promises")).open);
  open.mockReset();
  open.mockImplementation(realOpen);
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

async function mutateAfterFirstRead(action: () => Promise<void>): Promise<void> {
  const fs = await import("node:fs/promises");
  const open = vi.mocked(fs.open);
  open.mockImplementationOnce(async (path, flags, mode) => {
    const handle = await realOpen(path, flags, mode);
    const read = handle.read.bind(handle);
    let first = true;
    handle.read = async (...readArgs: any[]) => {
      const result = await read(...readArgs);
      if (first) {
        first = false;
        await action();
      }
      return result;
    };
    return handle;
  });
}

describe("readOwnedNativeCheckpoint", () => {
  it("reads ordered uncompressed owned response items without requiring a compaction", async () => {
    const older={type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'BETA'}]}};
    const newer={type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'GAMMA'}]}};
    const f=await fixture(rollout(metadata(),older,newer));
    expect(await readOwnedNativeRollout(options(f.root,f.file))).toEqual([metadata(),older,newer]);
    await expect(readOwnedNativeCheckpoint(options(f.root,f.file))).rejects.toThrow('NATIVE_CHECKPOINT_NO_COMPACTED');
  });

  it("does not expose a source or wrong-custody rollout through the diagnostic reader",async()=>{
    for(const meta of [metadata(SOURCE_THREAD_ID),metadata(FORK_THREAD_ID,'wrong-custody')]){
      const f=await fixture(rollout(meta));
      await expect(readOwnedNativeRollout(options(f.root,f.file))).rejects.toThrow();
    }
  });

  it("returns the latest compacted checkpoint and its exact envelope from an owned file", async () => {
    const f = await fixture(rollout(metadata(), compacted("old"), compacted("latest")));
    const result = await readOwnedNativeCheckpoint(options(f.root, f.file));

    expect(result.envelope).toEqual(compacted("latest"));
    expect(result.checkpoint.items).toEqual([
      {type: "message", role: "user", content: [{type: "input_text", text: "synthetic-latest"}]},
      {type: "compaction", encrypted_content: "opaque-latest"}
    ]);
    expect(result.checkpoint.sourceRepresentation).toBe("upstream_compacted");
  });

  it("requires the first metadata id to be the fork and rejects the source id", async () => {
    const wrongFork = await fixture(rollout(metadata("other-fork"), compacted("latest")));
    await expect(readOwnedNativeCheckpoint(options(wrongFork.root, wrongFork.file))).rejects.toThrow("NATIVE_CHECKPOINT_METADATA");

    const source = await fixture(rollout(metadata(SOURCE_THREAD_ID), compacted("latest")));
    await expect(readOwnedNativeCheckpoint(options(source.root, source.file))).rejects.toThrow("NATIVE_CHECKPOINT_SOURCE_COLLISION");
  });

  it("requires the exact custody tag in first metadata", async () => {
    const f = await fixture(rollout(metadata(FORK_THREAD_ID, "other-tag"), compacted("latest")));
    await expect(readOwnedNativeCheckpoint(options(f.root, f.file))).rejects.toThrow("NATIVE_CHECKPOINT_METADATA");
  });

  it("rejects a hard-linked checkpoint file", async () => {
    const f = await fixture();
    const alias = join(f.root, "sessions", "alias.jsonl");
    await link(f.file, alias);
    await expect(readOwnedNativeCheckpoint(options(f.root, f.file))).rejects.toThrow("NATIVE_CHECKPOINT_PATH");
  });

  it("rejects a reparse-point ancestor even when its target is below the runtime home", async () => {
    const f = await fixture();
    const reparse = join(f.root, "reparse-sessions");
    await symlink(join(f.root, "sessions"), reparse, process.platform === "win32" ? "junction" : "dir");
    const path = join(reparse, "fork.jsonl");
    expect((await lstat(reparse)).isSymbolicLink()).toBe(true);
    await expect(readOwnedNativeCheckpoint(options(f.root, path))).rejects.toThrow("NATIVE_CHECKPOINT_REPARSE");
  });

  it("rejects a file that grows after the captured read snapshot", async () => {
    const f = await fixture();
    await mutateAfterFirstRead(async () => {
      await writeFile(f.file, `${await readFile(f.file, "utf8")}growth\n`);
    });
    await expect(readOwnedNativeCheckpoint(options(f.root, f.file))).rejects.toThrow("NATIVE_CHECKPOINT_REPLACED");
  });

  it("rejects replacement of the path after the held handle has started reading", async () => {
    const f = await fixture();
    await mutateAfterFirstRead(async () => {
      const moved = join(f.root, "sessions", "moved.jsonl");
      await rename(f.file, moved);
      await writeFile(f.file, rollout(metadata(), compacted("replacement")), {encoding: "utf8", mode: 0o600});
    });
    await expect(readOwnedNativeCheckpoint(options(f.root, f.file))).rejects.toThrow("NATIVE_CHECKPOINT_REPLACED");
  });

  it("rejects a file without a complete final newline", async () => {
    const f = await fixture(`${JSON.stringify(metadata())}\n${JSON.stringify(compacted("partial"))}`);
    await expect(readOwnedNativeCheckpoint(options(f.root, f.file))).rejects.toThrow("NATIVE_CHECKPOINT_PARTIAL");
  });

  it("rejects a file larger than maxBytes before reading it", async () => {
    const f = await fixture();
    const size = Buffer.byteLength(await readFile(f.file));
    const fs = await import("node:fs/promises");
    await expect(readOwnedNativeCheckpoint(options(f.root, f.file, size - 1))).rejects.toThrow("NATIVE_CHECKPOINT_BOUND");
    expect(fs.open).not.toHaveBeenCalled();
  });
});
