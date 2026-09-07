import { describe, expect, it } from "vitest";
import type { PassiveContent } from "../../src/hooks/passive-content.js";
import type { HookEnvelope, HookName } from "../../src/hooks/schema.js";
import { PassiveContextStore } from "../../src/server/passive-context-store.js";

type EnvelopeWithContent = HookEnvelope & { content?: PassiveContent };

const sessionA = "session_aaaaaaaaaaaaaaaaaaaaaaaa";
const sessionB = "session_bbbbbbbbbbbbbbbbbbbbbbbb";

let eventNumber = 0;

function event(
  hook: HookName,
  options: {
    sessionKey?: string;
    turnKey?: string | undefined;
    receivedAt?: number;
    content?: PassiveContent | undefined;
    eventId?: string;
  } = {}
): EnvelopeWithContent {
  eventNumber += 1;
  const id = options.eventId ?? `${eventNumber}`;
  return {
    schemaVersion: 2,
    taskHandle: `hud_${"h".repeat(24)}`,
    eventId: `evt_${id}${"e".repeat(Math.max(20, 24 - id.length))}`,
    sessionKey: options.sessionKey ?? sessionA,
    ...(options.turnKey === undefined ? { turnKey: `turn_${eventNumber}${"t".repeat(20)}` } : { turnKey: options.turnKey }),
    hook,
    receivedAt: options.receivedAt ?? 100,
    ...(options.content === undefined ? {} : { content: options.content })
  };
}

function content(kind: PassiveContent["kind"], text: string, truncated = false): PassiveContent {
  return { kind, text, truncated };
}

describe("PassiveContextStore", () => {
  it("stores only safe content and returns detached views", () => {
    const store = new PassiveContextStore();
    const envelope = event("UserPromptSubmit", {
      content: { ...content("user", "Build the report"), extra: "discard me" } as PassiveContent & { extra: string }
    });

    expect(store.ingest(envelope, 100)).toBe(true);
    const view = store.read(sessionA);
    expect(view).toEqual({
      sessionKey: sessionA,
      sequence: 1,
      entries: [{ turnKey: envelope.turnKey, hook: "UserPromptSubmit", receivedAt: 100, content: content("user", "Build the report") }],
      truncated: false
    });
    expect(view).not.toHaveProperty("taskHandle");
    expect(view).not.toHaveProperty("eventId");

    view!.entries[0]!.content.text = "mutated";
    view!.entries.push({ turnKey: "turn_fake", hook: "Stop", receivedAt: 101, content: content("assistant", "fake") });
    expect(store.read(sessionA)).toEqual({
      sessionKey: sessionA,
      sequence: 1,
      entries: [{ turnKey: envelope.turnKey, hook: "UserPromptSubmit", receivedAt: 100, content: content("user", "Build the report") }],
      truncated: false
    });
  });

  it("sorts retained entries by receipt time and stable ingestion order", () => {
    const store = new PassiveContextStore();
    store.ingest(event("UserPromptSubmit", { receivedAt: 300, content: content("user", "third") }), 300);
    store.ingest(event("PostToolUse", { receivedAt: 100, content: content("tool", "first") }), 300);
    store.ingest(event("Stop", { receivedAt: 100, content: content("assistant", "second") }), 300);

    expect(store.read(sessionA)!.entries.map(entry => [entry.receivedAt, entry.content.text])).toEqual([
      [100, "first"], [100, "second"], [300, "third"]
    ]);
  });

  it("rejects content events without turn identity but accepts contentless lifecycle sequencing", () => {
    const store = new PassiveContextStore();
    const missingTurn = event("UserPromptSubmit", { content: content("user", "missing") });
    delete missingTurn.turnKey;

    expect(store.ingest(missingTurn, 100)).toBe(false);
    expect(store.ingest(event("Interrupt", { receivedAt: 101, turnKey: undefined }), 101)).toBe(true);
    expect(store.ingest(event("Stop", { receivedAt: 102, turnKey: undefined }), 102)).toBe(true);
    expect(store.read(sessionA)).toMatchObject({ sessionKey: sessionA, sequence: 2, entries: [], truncated: false });
  });

  it("rejects unsafe clocks, mismatched content kinds, and oversized content", () => {
    const store = new PassiveContextStore();
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "future") , receivedAt: 101 }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { content: content("assistant", "wrong") }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { content: undefined }), 100)).toBe(false);
    expect(store.ingest(event("SessionEnd", { content: content("tool", "wrong") }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { content: null as unknown as PassiveContent }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "x".repeat(4097)) }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "negative"), receivedAt: -1 }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "nan"), receivedAt: Number.NaN }), 100)).toBe(false);
    expect(store.ingest(event("UserPromptSubmit", { turnKey: 42 as unknown as string, content: content("user", "bad id") }), 100)).toBe(false);
    expect(store.read(sessionA)).toBeNull();
  });

  it("increments sequence for accepted contentless lifecycle events and fences a session after SessionEnd", () => {
    const store = new PassiveContextStore();
    expect(store.ingest(event("SessionStart", { turnKey: undefined }), 100)).toBe(true);
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "keep") }), 101)).toBe(true);
    expect(store.ingest(event("SessionEnd", { turnKey: undefined }), 102)).toBe(true);
    expect(store.read(sessionA)).toBeNull();
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "old event") }), 103)).toBe(false);

    expect(store.ingest(event("UserPromptSubmit", { sessionKey: sessionB, content: content("user", "other conversation") }), 104)).toBe(true);
    expect(store.read(sessionB)!.entries[0]!.content.text).toBe("other conversation");
  });

  it("prunes FIFO entries while preserving the newest user prompt", () => {
    const store = new PassiveContextStore({ maxEntries: 2 });
    store.ingest(event("UserPromptSubmit", { receivedAt: 100, content: content("user", "old prompt") }), 100);
    store.ingest(event("Stop", { receivedAt: 101, content: content("assistant", "old answer") }), 101);
    store.ingest(event("UserPromptSubmit", { receivedAt: 102, content: content("user", "new prompt") }), 102);
    store.ingest(event("PostToolUse", { receivedAt: 103, content: content("tool", "new tool") }), 103);

    expect(store.read(sessionA)!.entries.map(entry => entry.content.text)).toEqual(["new prompt", "new tool"]);
    expect(store.read(sessionA)!.truncated).toBe(true);
  });

  it("rejects an entry that cannot safely fit instead of silently dropping it", () => {
    const store = new PassiveContextStore({ maxEntries: 1, maxChars: 4 });
    expect(store.ingest(event("UserPromptSubmit", { content: content("user", "fits") }), 100)).toBe(true);
    expect(store.ingest(event("Stop", { content: content("assistant", "does not fit") }), 101)).toBe(false);
    expect(store.read(sessionA)!.entries.map(entry => entry.content.text)).toEqual(["fits"]);
    expect(store.read(sessionA)!.truncated).toBe(false);
  });

  it("refuses unseen identities at the bounded replay-fence cap", () => {
    const store = new PassiveContextStore();
    for (let index = 0; index < 4096; index += 1) {
      expect(store.ingest(event("Interrupt", { eventId: `fence${index}` }), 100)).toBe(true);
    }
    expect(store.ingest(event("Interrupt", { eventId: "one-too-many" }), 100)).toBe(false);
    expect(store.ingest(event("Interrupt", { eventId: "fence0" }), 100)).toBe(false);
    expect(store.stats()).toMatchObject({ eventIdentities: 4096, conversations: 1, entries: 0 });
  });

  it("bounds conversations without erasing existing conversation state", () => {
    const store = new PassiveContextStore({ maxConversations: 2 });
    expect(store.ingest(event("UserPromptSubmit", { sessionKey: sessionA, content: content("user", "a") }), 100)).toBe(true);
    expect(store.ingest(event("UserPromptSubmit", { sessionKey: sessionB, content: content("user", "b") }), 101)).toBe(true);
    expect(store.ingest(event("UserPromptSubmit", { sessionKey: "session_cccccccccccccccccccccccc", content: content("user", "c") }), 102)).toBe(false);
    expect(store.read(sessionA)!.entries[0]!.content.text).toBe("a");
    expect(store.read(sessionB)!.entries[0]!.content.text).toBe("b");
  });

  it("supports remove and clear while reporting numeric-only stats", () => {
    const store = new PassiveContextStore();
    store.ingest(event("UserPromptSubmit", { content: content("user", "one") }), 100);
    store.ingest(event("UserPromptSubmit", { sessionKey: sessionB, content: content("user", "two") }), 101);
    store.remove(sessionA);
    expect(store.read(sessionA)).toBeNull();
    expect(store.stats()).toEqual({ conversations: 1, entries: 1, chars: 3, eventIdentities: 2, tombstones: 0 });
    store.clear();
    expect(store.read(sessionB)).toBeNull();
    expect(store.stats()).toEqual({ conversations: 0, entries: 0, chars: 0, eventIdentities: 0, tombstones: 0 });
  });
});
