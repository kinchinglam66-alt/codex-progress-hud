import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createHookClient } from "../../src/hooks/client.js";
import { runHookEvent } from "../../src/hooks/main.js";
import { createCompanionManager } from "../../src/lifecycle/companion-manager.js";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import { PROTOCOL_VERSION } from "../../src/lifecycle/types.js";
import { CompanionHttpClient } from "../../src/mcp/report-client.js";
import type { HookEnvelope } from "../../src/hooks/schema.js";

const secret = "protected-token-for-runtime-tests-0123456789";
const input = {
  session_id: "session-1",
  turn_id: "turn-1",
  hook_event_name: "SessionStart",
  source: "startup"
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface ProcessResult { code: number | null; stdout: string; stderr: string; }

function runProcess(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  };
  cleanups.push(close);
  return { url: `http://127.0.0.1:${address.port}`, close };
}

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

  it("cancels the real manager and HTTP status request at the Hook deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-hook-cancel-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tokenPath = join(directory, "auth.token");
    await writeFile(tokenPath, `${secret}\n`);
    let statusEnteredResolve!: () => void;
    let statusClosedResolve!: () => void;
    const statusEntered = new Promise<void>((resolve) => { statusEnteredResolve = resolve; });
    const statusClosed = new Promise<void>((resolve) => { statusClosedResolve = resolve; });
    let hookRequests = 0;
    const fixture = await listen((request, response) => {
      if (request.url === "/health") {
        json(response, 200, { service: "codex-progress-hud", protocolVersion: PROTOCOL_VERSION });
        return;
      }
      if (request.url === "/api/health") {
        json(response, 200, {
          service: "codex-progress-hud",
          pid: 4312,
          version: "0.1.0",
          protocolVersion: PROTOCOL_VERSION,
          instanceNonce: "hook-cancellation-fixture",
          startedAt: "2026-09-03T01:02:03.000Z",
          visibility: "visible"
        });
        return;
      }
      if (request.url === "/api/snapshot") {
        statusEnteredResolve();
        response.once("close", statusClosedResolve);
        return;
      }
      if (request.url === "/api/hooks/events") {
        hookRequests += 1;
        json(response, 200, {
          revision: 1,
          selectedTaskId: null,
          selectionMode: "follow_activity",
          tasks: [],
          selected: null,
          compatibility: { incompatibleClientSeen: false }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    const store = createLifecycleStateStore({
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    });
    await store.setDesiredState("on");
    const progressClient = new CompanionHttpClient(fixture.url, tokenPath);
    const manager = createCompanionManager({
      store,
      client: progressClient,
      launcher: { spawnHud: async () => { throw new Error("unexpected launch"); } },
      startupTimeoutMs: 1_500,
      logger: { write: async () => undefined },
      diagnostics: {
        directory,
        pluginVersion: "0.1.0",
        mcpVersion: "0.1.0",
        host: "127.0.0.1",
        port: Number(new URL(fixture.url).port),
        installManifestPath: join(directory, "install.json"),
        dataDirectoryPath: directory
      }
    });
    const hookClient = createHookClient({ progressClient, companionManager: manager });
    const stdout: string[] = [];
    const running = runHookEvent("Stop", {
      stdin: Readable.from([JSON.stringify({
        session_id: "session-1",
        hook_event_name: "Stop"
      })]),
      hmacKey: secret,
      timeoutMs: 300,
      postHook: (envelope, options) => hookClient.post(envelope, options),
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined
    });
    await Promise.race([
      statusEntered,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("status request was not reached")), 1_000)
      )
    ]);

    await running;
    const requestClosedAtDeadline = await Promise.race([
      statusClosed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 150))
    ]);

    expect(requestClosedAtDeadline).toBe(true);
    expect(hookRequests).toBe(0);
    expect(stdout).toEqual(['{"continue":true}\n']);
  });
});

describe.runIf(process.platform === "win32")("PowerShell Hook launcher", () => {
  const root = join(import.meta.dirname, "..", "..");
  const launcher = join(root, "scripts", "launch-hook.ps1");
  const probeBuilder = join(import.meta.dirname, "launcher-probe.ps1");
  const powershell = "powershell.exe";

  async function runLauncher(appData: string, extraEnvironment: NodeJS.ProcessEnv = {}) {
    return runProcess(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, "-HookName", "Stop"],
      { ...process.env, APPDATA: appData, ...extraEnvironment }
    );
  }

  it("fails open with one bounded JSON value when validation cannot reach a child", async () => {
    const appData = await mkdtemp(join(tmpdir(), "hud-hook-launcher-missing-"));
    cleanups.push(() => rm(appData, { recursive: true, force: true }));

    const result = await runLauncher(appData);

    expect(result.code).toBe(0);
    expect(result.stdout.replaceAll("\r\n", "\n")).toBe('{"continue":true}\n');
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeLessThanOrEqual(512);
    expect(result.stderr).not.toContain(appData);
  });

  it("fails open when a validated executable path cannot be started", async () => {
    const appData = await mkdtemp(join(tmpdir(), "hud-hook-launcher-invalid-"));
    cleanups.push(() => rm(appData, { recursive: true, force: true }));
    const installDirectory = join(appData, "installed");
    const executablePath = join(installDirectory, "Codex Progress HUD.exe");
    const manifestDirectory = join(appData, "codex-progress-hud");
    await Promise.all([
      mkdir(join(installDirectory, "resources"), { recursive: true }),
      mkdir(manifestDirectory, { recursive: true })
    ]);
    await writeFile(executablePath, "not a Windows executable");
    await writeFile(join(manifestDirectory, "install.json"), JSON.stringify({
      executablePath,
      installDirectory,
      version: "0.1.0"
    }));

    const result = await runLauncher(appData);

    expect(result.code).toBe(0);
    expect(result.stdout.replaceAll("\r\n", "\n")).toBe('{"continue":true}\n');
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeLessThanOrEqual(512);
  });

  it("passes through child stdout and preserves an intentional child exit", async () => {
    const appData = await mkdtemp(join(tmpdir(), "hud-hook-launcher-probe-"));
    cleanups.push(() => rm(appData, { recursive: true, force: true }));
    const installDirectory = join(appData, "installed");
    const executablePath = join(installDirectory, "Codex Progress HUD.exe");
    const manifestDirectory = join(appData, "codex-progress-hud");
    await Promise.all([
      mkdir(join(installDirectory, "resources"), { recursive: true }),
      mkdir(manifestDirectory, { recursive: true })
    ]);
    const built = await runProcess(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probeBuilder, "-OutputPath", executablePath],
      process.env
    );
    expect(built.code).toBe(0);
    await writeFile(join(manifestDirectory, "install.json"), JSON.stringify({
      executablePath,
      installDirectory,
      version: "0.1.0"
    }));

    const success = await runLauncher(appData);
    const intentionalExit = await runLauncher(appData, { CODEX_HOOK_PROBE_EXIT: "7" });

    expect(success.code).toBe(0);
    expect(success.stdout.replaceAll("\r\n", "\n")).toBe('{"continue":true,"probe":"Stop"}\n');
    expect(success.stderr).toBe("");
    expect(intentionalExit.code).toBe(7);
    expect(intentionalExit.stdout.replaceAll("\r\n", "\n")).toBe('{"continue":true,"probe":"Stop"}\n');
    expect(intentionalExit.stderr).toBe("");
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
    expect(manifest.hooks).toBeUndefined();
    expect(launcher).toContain("install.json");
    expect(launcher).toContain("executablePath");
    expect(launcher).toContain("Test-Path -LiteralPath");
    expect(launcher).toContain("--hook-event=");
    expect(launcher).not.toMatch(/(?:^|\s)(?:node|npm)(?:\.exe)?(?:\s|$)/imu);
    const parameterBlock = launcher.match(/param\s*\(([\s\S]*?)\)/iu)?.[1] ?? "";
    expect(parameterBlock).not.toMatch(/executablepath/iu);
    expect(copyAssets).toContain("hooks/hooks.json");
    expect(copyAssets).toContain("scripts/launch-hook.ps1");
    for (const requiredCheck of ["hooks", "PLUGIN_ROOT", "Interrupt", "launch-hook.ps1"]) {
      expect(validator).toContain(requiredCheck);
    }
  });
});
