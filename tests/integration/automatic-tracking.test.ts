import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runHookEvent } from "../../src/hooks/main.js";
import { TaskStore } from "../../src/server/task-store.js";

describe("automatic tracking integration", () => {
  it("does not inject a writable handle from an unidentified SessionStart", async () => {
    const output: string[] = [];
    await runHookEvent("SessionStart", {
      stdin: Readable.from([JSON.stringify({ session_id: "session-before-mcp", hook_event_name: "SessionStart", source: "startup" })]),
      hmacKey: "integration-hmac-key-abcdefghijklmnopqrstuvwxyz",
      postHook: async () => { throw new Error("MCP not connected"); },
      writeStdout: (value) => output.push(value),
      writeStderr: () => undefined
    });
    const result = JSON.parse(output.join(""));
    expect(result).toEqual({continue: true});
  });

  it("starts new work automatically and late-attaches without backfilled elapsed time", () => {
    const store = new TaskStore({ now: () => 5_000 });
    const automatic = store.apply({
      taskId: "hud_automatic_task_abcdefghijklmnopqrstuvwxyz",
      event: { type: "session_attached", origin: "session_start" }
    }, 1_000);
    expect(automatic.selected?.task).toMatchObject({ trackingOrigin: "session_start", trackedFrom: 1_000 });

    const late = store.apply({
      taskId: "hud_late_task_abcdefghijklmnopqrstuvwxyz0123",
      event: { type: "session_attached", origin: "late_attach" }
    }, 5_000);
    expect(late.selected?.task).toMatchObject({ trackingOrigin: "late_attach", trackedFrom: 5_000, activeElapsedMs: 0 });
  });
});
