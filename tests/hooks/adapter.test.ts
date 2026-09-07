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
  it("gives distinct turns immutable handles within one conversation group", () => {
    const first = normalizeHookInput("UserPromptSubmit", { session_id: "same", turn_id: "a" }, 100, secret);
    const second = normalizeHookInput("UserPromptSubmit", { session_id: "same", turn_id: "b" }, 200, secret);
    expect(first.envelope.taskHandle).not.toBe(second.envelope.taskHandle);
    expect(first.envelope.sessionKey).toBe(second.envelope.sessionKey);
    expect(first.result).toEqual({continue: true});
  });

  it("does not collapse unkeyed invocations or inject a writable turn association", () => {
    const first = normalizeHookInput("UserPromptSubmit", { session_id: "same" }, 100, secret);
    const second = normalizeHookInput("UserPromptSubmit", { session_id: "same" }, 100, secret);
    expect(first.envelope.eventId).not.toBe(second.envelope.eventId);
    expect(first.result).toEqual({continue: true});
  });
  it("rejects normalization without an explicit secure HMAC key", () => {
    const callWithoutKey = normalizeHookInput as unknown as (
      hook: "Stop",
      input: unknown,
      nowMs: number
    ) => unknown;

    expect(() => callWithoutKey("Stop", {
      session_id: "session-1",
      hook_event_name: "Stop"
    }, 100)).toThrow("Hook HMAC key is required");
  });

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
      schemaVersion: 2,
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
    "acknowledges %s without injecting model instructions or handles",
    (hook) => {
      const normalized = normalizeHookInput(hook, {
        session_id: "session-1",
        turn_id: "turn-1",
        hook_event_name: hook
      }, 100, secret);

      expect(normalized.result).toEqual({continue: true});
    }
  );

  it.each(["PostToolUse", "Stop", "SessionEnd"] as const)(
    "returns no context for %s",
    (hook) => {
      expect(normalizeHookInput(hook, {
        session_id: "session-1",
        hook_event_name: hook
      }, 100, secret).result).toEqual({ continue: true });
    }
  );

  it("returns only valid empty JSON for Interrupt", () => {
    expect(normalizeHookInput("Interrupt", {
      session_id: "session-1",
      turn_id: "turn-1",
      hook_event_name: "Interrupt"
    }, 100, secret).result).toEqual({});
  });

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
