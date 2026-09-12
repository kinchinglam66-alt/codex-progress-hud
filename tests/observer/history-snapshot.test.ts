import {appendFile, mkdir, mkdtemp, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import type {HistoryRecord, HistorySnapshot} from "../../src/observer/history-snapshot.js";
import {createHistorySnapshot} from "../../src/observer/history-snapshot.js";
import {createLocalSessionReader} from "../../src/observer/local-session-reader.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const cleanups: Array<() => Promise<void>> = [];

type SnapshotReader = ReturnType<typeof createLocalSessionReader> & {
  snapshot(threadId: string, signal: AbortSignal): Promise<HistorySnapshot>;
};

function line(type: string, payload: unknown, atMs = 1_700_000_000_000): string {
  return `${JSON.stringify({timestamp: new Date(atMs).toISOString(), type, payload})}\n`;
}

function meta(): string {
  return line("session_meta", {id: THREAD});
}

function message(role: "user" | "assistant", text: string, id: string, turnId = "turn-1"): string {
  return line("response_item", {
    type: "message", id, role, turn_id: turnId,
    content: [{type: role === "user" ? "input_text" : "output_text", text}]
  });
}

function toolResult(output: string, actionId = "large-tool", turnId = "turn-1"): string {
  return line("response_item", {
    type: "custom_tool_call_output", id: `output-${actionId}`, call_id: actionId,
    output, turn_id: turnId
  });
}

async function fixture(contents: string): Promise<{root: string; file: string}> {
  const root = await mkdtemp(join(tmpdir(), "history-snapshot-"));
  const directory = join(root, "2026", "09", "06");
  await mkdir(directory, {recursive: true});
  const file = join(directory, `rollout-2026-09-06T00-00-00-${THREAD}.jsonl`);
  await writeFile(file, contents, {encoding: "utf8", mode: 0o600});
  cleanups.push(() => rm(root, {recursive: true, force: true}));
  return {root, file};
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("source-backed history snapshots", () => {
  it("bounds dedupe metadata while retaining text beyond the window and flags uncertainty", async () => {
    const f=await fixture(meta()+Array.from({length:4200},(_,i)=>message('assistant',`text-${i}`,`id-${i}`)).join('')+
      message('assistant','text-0','id-0'));
    const reader=createLocalSessionReader({root:f.root});
    const snapshot=await reader.snapshot(THREAD,signal());
    try {
      let count=0,last='';
      for await(const entry of snapshot.records(signal())){count++;last=entry.record.text??'';}
      expect(count).toBe(4201);
      expect(last).toBe('text-0');
      expect(snapshot.coverage).toEqual({complete:false,gaps:['deduplication_window']});
    } finally {await snapshot.close();await reader.close();}
  });
  it("keeps an earlier incomplete page authoritative after a complete terminal page", async () => {
    let page = 0;
    const snapshot = createHistorySnapshot({
      identity: "verified-source",
      sourceEpoch: 1,
      revision: 2,
      open: () => {
        page = 0;
        return {
        readPage: async () => page++ === 0 ? {
          records: [{id: "early", turnId: "turn-1", atMs: 1, kind: "user", text: "early"}],
          nextOffset: 1,
          done: false,
          coverage: {complete: false, gaps: []}
        } : {
          records: [{id: "late", turnId: "turn-1", atMs: 2, kind: "assistant", text: "late"}],
          nextOffset: 2,
          done: true,
          coverage: {complete: true, gaps: []}
        },
        close: async () => {}
        };
      },
      close: async () => {}
    });
    const records: HistoryRecord[] = [];
    for await (const entry of snapshot.records(signal())) records.push(entry);
    expect(records.map(entry => entry.record.id)).toEqual(["early", "late"]);
    expect(snapshot.coverage).toEqual({complete: false, gaps: []});
    await snapshot.close();
  });

  it("captures a fixed watermark and preserves readable history bodies", async () => {
    const largeToolOutput = "tool-result-marker:" + "x".repeat(300 * 1024);
    const initial = meta() + Array.from({length: 200}, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `history-${index}`, `message-${index}`)
    ).join("") + message("user", "same text", "same-text-a") +
      message("user", "same text", "same-text-b") + message("user", "duplicate event", "duplicate-id") +
      message("user", "duplicate event", "duplicate-id") + toolResult(largeToolOutput);
    const f = await fixture(initial);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;

    const snapshot = await reader.snapshot(THREAD, signal());
    const watermark = (await stat(f.file)).size;
    await appendFile(f.file, message("user", "after-watermark", "after-watermark"));
    expect(snapshot.identity).not.toContain(f.file);
    expect(snapshot.coverage.complete).toBe(false);

    const received: HistoryRecord[] = [];
    try {
      for await (const entry of snapshot.records(signal())) received.push(entry);
    } finally {
      await snapshot.close();
    }

    expect(watermark).toBeLessThan((await stat(f.file)).size);
    expect(received.map(entry => entry.ordinal)).toEqual([...received.keys()]);
    expect(received).toHaveLength(204);
    expect(received.some(entry => entry.record.text === "history-0")).toBe(true);
    expect(received.some(entry => entry.record.text === "history-199")).toBe(true);
    expect(received.some(entry => entry.record.text === "after-watermark")).toBe(false);
    expect(received.filter(entry => entry.record.text === "same text")).toHaveLength(2);
    expect(received.filter(entry => entry.record.text === "duplicate event")).toHaveLength(1);
    expect(received.find(entry => entry.record.kind === "tool_result")?.record.output).toBe(largeToolOutput);
    expect(snapshot.coverage).toEqual({complete: true, gaps: []});

    const next = await reader.snapshot(THREAD, signal());
    const nextRecords: HistoryRecord[] = [];
    try {
      for await (const entry of next.records(signal())) nextRecords.push(entry);
    } finally {
      await next.close();
      await reader.close();
    }
    expect(nextRecords.some(entry => entry.record.text === "after-watermark")).toBe(true);
  });

  it("keeps coverage non-authoritative until unsupported and partial records are examined", async () => {
    const unsupported = line("response_item", {
      type: "message", id: "attachment-message", role: "user", turn_id: "turn-1",
      content: [{type: "input_image", path: "must-not-be-read.txt"}]
    });
    const unattributed = line("response_item", {
      type: "message", id: "unattributed-message", role: "assistant",
      content: [{type: "output_text", text: "background record"}]
    });
    const upstreamTruncation = line("compacted", {summary: "source compacted this history"});
    const partial = JSON.stringify({timestamp: new Date().toISOString(), type: "response_item",
      payload: {type: "message", id: "partial", role: "user", turn_id: "turn-1",
        content: [{type: "input_text", text: "partial"}]}});
    const f = await fixture(meta() + message("user", "readable", "readable") + unsupported +
      unattributed + upstreamTruncation + partial);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());

    expect(snapshot.coverage.complete).toBe(false);
    const received: HistoryRecord[] = [];
    try {
      for await (const entry of snapshot.records(signal())) received.push(entry);
    } finally {
      await snapshot.close();
      await reader.close();
    }

    expect(received.map(entry => entry.record.text)).toContain("readable");
    expect(received.map(entry => entry.record.text)).toContain("background record");
    expect(received.map(entry => entry.record.text)).not.toContain("partial");
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.gaps).toEqual(expect.arrayContaining([
      "unsupported_payload", "unattributed_record", "upstream_truncated", "unreadable_record"
    ]));
  });

  it("rejects a snapshot when the verified source is replaced before paging", async () => {
    const f = await fixture(meta() + message("user", "before replacement", "before"));
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    await writeFile(f.file, meta() + message("user", "after replacement", "after"), {encoding: "utf8"});

    try {
      await expect((async () => {
        for await (const _entry of snapshot.records(signal())) {
          // The source must be checked before any replaced record is exposed.
        }
      })()).rejects.toMatchObject({code: "source_identity_mismatch"});
      expect(snapshot.coverage.complete).toBe(false);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("cancels between pages and releases the snapshot source", async () => {
    const history = Array.from({length: 250}, (_, index) =>
      message("user", `cancel-${index}-${"x".repeat(32 * 1024)}`, `cancel-${index}`)
    ).join("");
    const f = await fixture(meta() + history);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    const controller = new AbortController();
    let received = 0;
    try {
      await expect((async () => {
        for await (const _entry of snapshot.records(controller.signal)) {
          received += 1;
          if (received === 1) controller.abort();
        }
      })()).rejects.toMatchObject({code: "source_cancelled"});
      expect(received).toBe(1);
      expect(snapshot.coverage.complete).toBe(false);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("keeps an earlier page gap authoritative across later clean pages", async () => {
    const unsupported = line("response_item", {
      type: "message", id: "early-unsupported", role: "user", turn_id: "turn-1",
      content: [{type: "input_image", path: "not-read.txt"}]
    });
    const history = Array.from({length: 150}, (_, index) =>
      message("assistant", `page-${index}-${"y".repeat(40 * 1024)}`, `page-${index}`)
    ).join("");
    const f = await fixture(meta() + unsupported + history);
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    try {
      const received: HistoryRecord[] = [];
      for await (const entry of snapshot.records(signal())) received.push(entry);
      expect(received.length).toBe(151);
      expect(snapshot.coverage.complete).toBe(false);
      expect(snapshot.coverage.gaps).toEqual(["unsupported_payload"]);
    } finally {
      await snapshot.close();
      await reader.close();
    }
  });

  it("replays the same fixed watermark until explicitly closed", async () => {
    const f = await fixture(meta() + message("user", "before replay", "before-replay"));
    const reader = createLocalSessionReader({root: f.root}) as SnapshotReader;
    const snapshot = await reader.snapshot(THREAD, signal());
    const first: HistoryRecord[] = [];
    const second: HistoryRecord[] = [];
    await appendFile(f.file, message("user", "after replay", "after-replay"));
    try {
      for await (const entry of snapshot.records(signal())) first.push(entry);
      for await (const entry of snapshot.records(signal())) second.push(entry);
    } finally {
      await snapshot.close();
      await reader.close();
    }
    expect(second).toEqual(first);
    expect(second.some(entry => entry.record.text === "after replay")).toBe(false);
    await expect((async () => {
      for await (const _entry of snapshot.records(signal())) {
        // A closed snapshot must reject explicitly rather than silently yielding no records.
      }
    })()).rejects.toMatchObject({code: "source_closed"});
  });
});
