import { describe, expect, it } from "vitest";
import { normalizeHookInput } from "../../src/hooks/adapter.js";

const hookNames = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd"
] as const;

const secret = "protected-token-for-hook-tests-0123456789";

describe("privacy-bounded Hook adapter", () => {
  it.each(hookNames)("normalizes %s using only opaque identity data", (hook) => {
    const normalized = normalizeHookInput(hook, {
      session_id: "raw-session-id",
      turn_id: "raw-turn-id",
      tool_use_id: "raw-tool-use-id",
      hook_event_name: hook,
      source: "resume",
      prompt: "private prompt",
      transcript_path: "C:\\private\\transcript.jsonl",
      tool_input: { command: "private command" },
      tool_output: "private output",
      cwd: "C:\\private\\repo",
      arbitrary: "discard this"
    }, 1_700_000_000_123, secret);

    expect(Object.keys(normalized.envelope).sort()).toEqual([
      "eventId", "hook", "receivedAt", "schemaVersion", "sessionKey", "source", "taskHandle", "turnKey"
    ]);
    expect(normalized.envelope).toMatchObject({
      schemaVersion: 1,
      hook,
      source: "resume",
      receivedAt: 1_700_000_000_123,
      taskHandle: expect.stringMatching(/^hud_[A-Za-z0-9_-]{43}$/u),
      eventId: expect.stringMatching(/^evt_[A-Za-z0-9_-]{43}$/u),
      sessionKey: expect.stringMatching(/^session_[A-Za-z0-9_-]{43}$/u),
      turnKey: expect.stringMatching(/^turn_[A-Za-z0-9_-]{43}$/u)
    });

    const wire = JSON.stringify(normalized);
    for (const privateValue of [
      "raw-session-id", "raw-turn-id", "raw-tool-use-id", "private prompt",
      "transcript.jsonl", "private command", "private output", "private repo", "discard this"
    ]) {
      expect(wire).not.toContain(privateValue);
    }
  });

  it.each(["SessionStart", "UserPromptSubmit"] as const)(
    "returns only a concise nested context for %s",
    (hook) => {
      const normalized = normalizeHookInput(hook, {
        session_id: "session-1",
        hook_event_name: hook
      }, 100, secret);

      expect(normalized.result.continue).toBe(true);
      expect(normalized.result.hookSpecificOutput).toEqual({
        hookEventName: hook,
        additionalContext: expect.stringContaining(normalized.envelope.taskHandle)
      });
      expect(normalized.result).not.toHaveProperty("additionalContext");
      expect(normalized.result.hookSpecificOutput?.additionalContext.length).toBeLessThan(180);
    }
  );

  it.each(["PostToolUse", "Stop", "Interrupt", "SessionEnd"] as const)(
    "returns no context for %s",
    (hook) => {
      expect(normalizeHookInput(hook, {
        session_id: "session-1",
        hook_event_name: hook
      }, 100, secret).result).toEqual({ continue: true });
    }
  );

  it("derives deterministic identifiers from the token and changes them with the token", () => {
    const input = {
      session_id: "session-1",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      hook_event_name: "PostToolUse" as const
    };
    const first = normalizeHookInput("PostToolUse", input, 100, secret);
    const repeated = normalizeHookInput("PostToolUse", input, 200, secret);
    const otherSecret = normalizeHookInput("PostToolUse", input, 100, `${secret}-other`);

    expect(repeated.envelope.taskHandle).toBe(first.envelope.taskHandle);
    expect(repeated.envelope.eventId).toBe(first.envelope.eventId);
    expect(repeated.envelope.sessionKey).toBe(first.envelope.sessionKey);
    expect(repeated.envelope.turnKey).toBe(first.envelope.turnKey);
    expect(repeated.envelope.receivedAt).toBe(200);
    expect(otherSecret.envelope.taskHandle).not.toBe(first.envelope.taskHandle);
    expect(otherSecret.envelope.eventId).not.toBe(first.envelope.eventId);
  });

  it("distinguishes bounded PostToolUse deliveries while keeping raw tool IDs private", () => {
    const first = normalizeHookInput("PostToolUse", {
      session_id: "session-1", turn_id: "turn-1", tool_use_id: "tool-1", hook_event_name: "PostToolUse"
    }, 100, secret);
    const repeated = normalizeHookInput("PostToolUse", {
      session_id: "session-1", turn_id: "turn-1", tool_use_id: "tool-1", hook_event_name: "PostToolUse"
    }, 200, secret);
    const second = normalizeHookInput("PostToolUse", {
      session_id: "session-1", turn_id: "turn-1", tool_use_id: "tool-2", hook_event_name: "PostToolUse"
    }, 100, secret);

    expect(repeated.envelope.eventId).toBe(first.envelope.eventId);
    expect(second.envelope.eventId).not.toBe(first.envelope.eventId);
    expect(JSON.stringify(first.envelope)).not.toContain("tool-1");
    expect(JSON.stringify(second.envelope)).not.toContain("tool-2");
  });

  it("rejects invalid Hook fields and unsafe receipt times", () => {
    expect(() => normalizeHookInput("Stop", { session_id: "" }, 100, secret)).toThrow();
    expect(() => normalizeHookInput("Stop", {
      session_id: "session-1", hook_event_name: "SessionEnd"
    }, 100, secret)).toThrow();
    expect(() => normalizeHookInput("Stop", { session_id: "session-1" }, -1, secret)).toThrow();
  });
});
