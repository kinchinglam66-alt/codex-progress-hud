import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHookClient } from "../../src/hooks/client.js";
import { runHookEvent } from "../../src/hooks/main.js";
import type { HookEnvelope } from "../../src/hooks/schema.js";

const secret = "protected-token-for-runtime-tests-0123456789";
const input = {
  session_id: "session-1",
  turn_id: "turn-1",
  hook_event_name: "SessionStart",
  source: "startup"
};

function runtime(overrides: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const posted: HookEnvelope[] = [];
  return {
    stdout,
    stderr,
    posted,
    dependencies: {
      stdin: Readable.from([JSON.stringify(input)]),
      readToken: async () => secret,
      postHook: async (envelope: HookEnvelope) => { posted.push(envelope); },
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
      ...overrides
    }
  };
}

describe("Hook command runtime", () => {
  it("reads one bounded JSON value and emits exactly one JSON result", async () => {
    const fixture = runtime();

    await runHookEvent("SessionStart", fixture.dependencies);

    expect(fixture.posted).toHaveLength(1);
    expect(fixture.stdout).toHaveLength(1);
    expect(JSON.parse(fixture.stdout[0]!)).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining(fixture.posted[0]!.taskHandle)
      }
    });
    expect(fixture.stderr).toEqual([]);
  });

  it("fails open for malformed and oversized stdin without protocol noise", async () => {
    for (const stdin of [
      Readable.from(["not-json"]),
      Readable.from(["{".padEnd(70_000, "x")])
    ]) {
      const fixture = runtime({ stdin });
      await runHookEvent("PostToolUse", fixture.dependencies);
      expect(fixture.posted).toEqual([]);
      expect(fixture.stdout).toEqual(['{"continue":true}\n']);
      expect(fixture.stderr.join("").length).toBeLessThanOrEqual(2_048);
    }
  });

  it("fails open when the companion is offline and keeps the context result", async () => {
    const fixture = runtime({
      postHook: async () => { throw new Error("offline private path and prompt"); }
    });

    await expect(runHookEvent("SessionStart", fixture.dependencies)).resolves.toBeUndefined();

    expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: "SessionStart" }
    });
    expect(fixture.stderr.join("")).not.toContain("private path");
    expect(fixture.stderr.join("").length).toBeLessThanOrEqual(2_048);
  });

  it("aborts a hung companion operation at the hard timeout", async () => {
    const fixture = runtime({
      timeoutMs: 20,
      postHook: async (_envelope: HookEnvelope, options: { signal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(), { once: true });
        })
    });
    const started = Date.now();

    await runHookEvent("SessionStart", fixture.dependencies);

    expect(Date.now() - started).toBeLessThan(500);
    expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({ continue: true });
    expect(fixture.stderr.join("").length).toBeLessThanOrEqual(2_048);
  });

  it("produces the same opaque event ID for duplicate deliveries", async () => {
    const first = runtime();
    const second = runtime();

    await runHookEvent("SessionStart", first.dependencies);
    await runHookEvent("SessionStart", second.dependencies);

    expect(first.posted[0]!.eventId).toBe(second.posted[0]!.eventId);
    expect(first.posted[0]!.taskHandle).toBe(second.posted[0]!.taskHandle);
  });
});

describe("Hook client", () => {
  it("refreshes the revision once after a stale delivery", async () => {
    const envelope = {
      schemaVersion: 1 as const,
      taskHandle: "hud_abcdefghijklmnopqrstuvwxyz0123456789",
      eventId: "evt_abcdefghijklmnopqrstuvwxyz0123456789",
      sessionKey: "session_abcdefghijklmnopqrstuvwxyz0123456789",
      hook: "Stop" as const,
      receivedAt: 100
    };
    const revisions: number[] = [];
    let submissions = 0;
    const hookClient = createHookClient({
      progressClient: {
        status: async () => ({ revision: revisions.length === 0 ? 1 : 2 } as never),
        submitHook: async (_event, options) => {
          revisions.push(options!.revision!);
          submissions += 1;
          if (submissions === 1) throw { code: "STALE_REVISION" };
          return {} as never;
        }
      },
      companionManager: {
        executeWrite: async (_reason, operation) => ({
          kind: "completed" as const,
          value: await operation(() => ({
            generation: 3,
            signal: new AbortController().signal,
            timeoutMs: 1_000
          }))
        })
      }
    });

    await hookClient.post(envelope);

    expect(revisions).toEqual([1, 2]);
  });
});

describe("packaged Hook contract", () => {
  const root = join(import.meta.dirname, "..", "..");

  it("declares only supported command Hooks with PLUGIN_ROOT and short deadlines", async () => {
    const config = JSON.parse(await readFile(join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number; async?: boolean }> }>>
    };
    expect(Object.keys(config.hooks).sort()).toEqual([
      "PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"
    ]);
    for (const [name, groups] of Object.entries(config.hooks)) {
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group.hooks).toHaveLength(1);
        const command = group.hooks[0]!;
        expect(command.type).toBe("command");
        expect(command.command).toContain("${PLUGIN_ROOT}");
        expect(command.command).toContain(`-HookName ${name}`);
        expect(command.timeout).toBeGreaterThan(0);
        expect(command.timeout).toBeLessThanOrEqual(3);
        expect(command).not.toHaveProperty("async");
      }
    }
    expect(config.hooks.SessionStart![0]!.matcher).toBe("startup|resume|clear|compact");
  });

  it("packages and validates a manifest-bound Node-free launcher", async () => {
    const [manifestText, launcher, copyAssets, validator] = await Promise.all([
      readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"),
      readFile(join(root, "scripts", "launch-hook.ps1"), "utf8"),
      readFile(join(root, "scripts", "copy-assets.mjs"), "utf8"),
      readFile(join(root, "scripts", "validate-plugin.mjs"), "utf8")
    ]);
    const manifest = JSON.parse(manifestText) as { hooks?: string };
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(launcher).toContain("install.json");
    expect(launcher).toContain("executablePath");
    expect(launcher).toContain("Test-Path -LiteralPath");
    expect(launcher).toContain("--hook-event=");
    expect(launcher.toLowerCase()).not.toContain("node");
    const parameterBlock = launcher.match(/param\s*\(([\s\S]*?)\)/iu)?.[1] ?? "";
    expect(parameterBlock).not.toMatch(/executablepath/iu);
    expect(copyAssets).toContain("hooks/hooks.json");
    expect(copyAssets).toContain("scripts/launch-hook.ps1");
    for (const requiredCheck of ["hooks", "PLUGIN_ROOT", "Interrupt", "launch-hook.ps1"]) {
      expect(validator).toContain(requiredCheck);
    }
  });
});
