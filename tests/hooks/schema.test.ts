import { describe, expect, it } from "vitest";
import {
  hookEnvelopeSchema,
  normalizeHookInput,
  parseHookEnvelope
} from "../../src/hooks/schema.js";

const hookNames = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd"
] as const;

describe("privacy-bounded Hook schema", () => {
  it.each(hookNames)("normalizes representative %s input without retaining content", (hook) => {
    const normalized = normalizeHookInput(hook, {
      session_id: "session-secret-123",
      turn_id: "turn-secret-456",
      hook_event_name: hook,
      source: "resume",
      prompt: "private prompt text",
      transcript_path: "C:\\Users\\person\\private-transcript.jsonl",
      tool_input: { command: "cat private.txt" },
      tool_output: "private tool output",
      cwd: "C:\\Users\\person\\private-repository",
      arbitrary: "must not cross the boundary"
    }, 1_700_000_000_123);

    expect(normalized.envelope).toMatchObject({
      schemaVersion: 1,
      hook,
      source: "resume",
      receivedAt: 1_700_000_000_123,
      turnKey: expect.stringMatching(/^turn_[A-Za-z0-9_-]+$/u),
      taskHandle: expect.stringMatching(/^hud_[A-Za-z0-9_-]+$/u),
      eventId: expect.stringMatching(/^evt_[A-Za-z0-9_-]+$/u),
      sessionKey: expect.stringMatching(/^session_[A-Za-z0-9_-]+$/u)
    });
    const output = JSON.stringify(normalized.envelope);
    for (const secret of [
      "private prompt text",
      "private-transcript.jsonl",
      "private.txt",
      "private tool output",
      "private-repository",
      "must not cross the boundary",
      "session-secret-123",
      "turn-secret-456"
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(normalized.envelope).not.toHaveProperty("prompt");
    expect(normalized.envelope).not.toHaveProperty("transcript_path");
    expect(normalized.envelope).not.toHaveProperty("tool_input");
    expect(normalized.envelope).not.toHaveProperty("tool_output");
    expect(normalized.envelope).not.toHaveProperty("cwd");
    expect(normalized.envelope).not.toHaveProperty("arbitrary");
  });

  it("keeps normalized identifiers deterministic while changing receipt time", () => {
    const input = { session_id: "session-1", turn_id: "turn-1", hook_event_name: "Stop" };
    const first = normalizeHookInput("Stop", input, 100);
    const second = normalizeHookInput("Stop", input, 200);

    expect(second.envelope.taskHandle).toBe(first.envelope.taskHandle);
    expect(second.envelope.eventId).toBe(first.envelope.eventId);
    expect(second.envelope.sessionKey).toBe(first.envelope.sessionKey);
    expect(second.envelope.turnKey).toBe(first.envelope.turnKey);
    expect(second.envelope.receivedAt).toBe(200);
  });

  it("parses only the strict wire envelope", () => {
    const envelope = {
      schemaVersion: 1,
      taskHandle: "hud_abcdefghijklmnopqrstuvwxyz0123456789",
      eventId: "evt_abcdefghijklmnopqrstuvwxyz0123456789",
      sessionKey: "session_abcdefghijklmnopqrstuvwxyz0123456789",
      hook: "SessionStart",
      receivedAt: 123
    } as const;

    expect(() => parseHookEnvelope({ ...envelope, arbitrary: "discarded" })).toThrow();
    expect(hookEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(parseHookEnvelope(envelope)).toEqual(envelope);
  });
});
