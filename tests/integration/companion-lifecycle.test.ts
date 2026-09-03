import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCompanionManager } from "../../src/lifecycle/companion-manager.js";
import type { OperationalLogEntry } from "../../src/diagnostics/logger.js";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import type { ProcessLauncher, SpawnedHud } from "../../src/lifecycle/process-launcher.js";
import { CompanionHttpClient } from "../../src/mcp/report-client.js";
import { createProgressServer } from "../../src/server/http-server.js";
import { holdLifecycleLock } from "../helpers/lifecycle-lock-holder.js";

interface TestOwnedCompanion extends SpawnedHud {
  serviceUrl: string;
  tokenPath: string;
  waitForExit(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

beforeAll(async () => {
  await execFileAsync(
    process.execPath,
    [resolve(pluginRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    { cwd: pluginRoot }
  );
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startTestOwnedCompanion(
  directory: string,
  expectedHideGeneration?: number
): Promise<TestOwnedCompanion> {
  const ownerNonce = randomUUID();
  const tokenPath = join(directory, `auth-${ownerNonce}.token`);
  const fixturePath = join(directory, `companion-${ownerNonce}.mjs`);
  await writeFile(
    fixturePath,
    `import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const ownerNonce = process.env.CODEX_PROGRESS_HUD_TEST_OWNED;
const tokenPath = process.env.CODEX_PROGRESS_HUD_TEST_TOKEN_PATH;
const expectedHideGeneration = process.env.CODEX_PROGRESS_HUD_TEST_HIDE_GENERATION;
if (!ownerNonce || !tokenPath) throw new Error("fixture must be test-owned");
const token = "test-" + ownerNonce;
await writeFile(tokenPath, token + "\\n", { mode: 0o600 });
let visibility = "visible";
let closing = false;
const startedAt = new Date().toISOString();
const sendJson = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};
const authorized = (request) => request.headers.authorization === "Bearer " + token;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { service: "codex-progress-hud", protocolVersion: 1 });
    return;
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      service: "codex-progress-hud",
      pid: process.pid,
      version: "0.1.0-test",
      protocolVersion: 1,
      instanceNonce: ownerNonce,
      startedAt,
      visibility
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/window/show") {
    visibility = "visible";
    sendJson(response, 202, { accepted: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/window/hide") {
    if (
      expectedHideGeneration &&
      request.headers["x-codex-progress-hud-generation"] !== expectedHideGeneration
    ) {
      sendJson(response, 409, { accepted: false });
      return;
    }
    visibility = "hidden";
    sendJson(response, 202, { accepted: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/shutdown") {
    closing = true;
    sendJson(response, 202, { accepted: true });
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }
  sendJson(response, 404, { error: "not found" });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  process.send?.({ type: "ready", port: address.port });
});
process.on("disconnect", () => {
  if (!closing) server.close(() => process.exit(0));
});
`
  );

  const child = spawn(process.execPath, [fixturePath], {
    env: {
      ...process.env,
      CODEX_PROGRESS_HUD_TEST_OWNED: ownerNonce,
      CODEX_PROGRESS_HUD_TEST_TOKEN_PATH: tokenPath,
      ...(expectedHideGeneration === undefined
        ? {}
        : { CODEX_PROGRESS_HUD_TEST_HIDE_GENERATION: String(expectedHideGeneration) })
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("test companion startup timed out")), 5_000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`test companion exited ${code}: ${stderr.trim()}`)));
      child.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready" &&
          "port" in message &&
          typeof message.port === "number"
        ) {
          clearTimeout(timeout);
          resolve(message.port);
        }
      });
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exitPromise;
    throw error;
  }

  return {
    pid: child.pid!,
    serviceUrl: `http://127.0.0.1:${port}`,
    tokenPath,
    async terminate(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await exitPromise;
    },
    waitForExit(): Promise<void> {
      return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : exitPromise;
    }
  };
}

describe("source-mode companion lifecycle", () => {
  it("does not let a second same-generation close report stopped while the first shutdown listener is still live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-concurrent-close-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const paths = {
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    };
    const store = createLifecycleStateStore(paths);
    const on = await store.setDesiredState("on");
    const runtime = {
      pid: process.pid,
      version: "0.2.0-test",
      protocolVersion: 1 as const,
      instanceNonce: randomUUID(),
      startedAt: new Date().toISOString()
    };
    await store.writeRuntime(runtime, on.generation);
    let shutdownRequested!: () => void;
    const shutdownRequest = new Promise<void>((resolve_) => { shutdownRequested = resolve_; });
    const server = createProgressServer({
      port: 0,
      tokenPath: join(directory, "auth.token"),
      health: () => ({ service: "codex-progress-hud", ...runtime, visibility: "visible" }),
      requestShutdown: () => shutdownRequested(),
      runIfGeneration: (generation, desiredState, operation, signal) =>
        store.runIfGeneration(generation, desiredState, operation, { signal })
    });
    await server.listen();
    cleanups.push(() => server.close());
    const makeManager = (logger: { write(entry: OperationalLogEntry): Promise<void> }) => createCompanionManager({
      store: createLifecycleStateStore(paths),
      client: new CompanionHttpClient(server.address().url, join(directory, "auth.token")),
      launcher: { spawnHud: vi.fn() },
      shutdownTimeoutMs: 1_000,
      logger,
      diagnostics: {
        directory: join(directory, "diagnostics"),
        pluginVersion: "0.2.0-test",
        mcpVersion: "0.2.0-test",
        host: "127.0.0.1",
        port: server.address().port,
        installManifestPath: paths.installManifestPath,
        dataDirectoryPath: directory
      }
    });
    const firstLogger = { write: vi.fn(async (_entry: OperationalLogEntry) => undefined) };
    const secondLogger = { write: vi.fn(async (_entry: OperationalLogEntry) => undefined) };
    const firstClosing = makeManager(firstLogger).close();
    await shutdownRequest;

    await expect(makeManager(secondLogger).close()).resolves.toEqual({
      desiredState: "off",
      observedState: "stopped",
      code: "SHUTDOWN_TIMEOUT"
    });
    await expect(firstClosing).resolves.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(await store.readRuntime()).toEqual(runtime);
    expect(secondLogger.write.mock.calls.flatMap(([entry]) => entry.event)).not.toContain(
      "shutdown_complete"
    );
  }, 15_000);

  it("does not report a successor open as running from a shutdown-latched old server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-shutdown-open-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const paths = {
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    };
    const store = createLifecycleStateStore(paths);
    const on = await store.setDesiredState("on");
    const runtime = {
      pid: process.pid,
      version: "0.2.0-test",
      protocolVersion: 1 as const,
      instanceNonce: randomUUID(),
      startedAt: new Date().toISOString()
    };
    await store.writeRuntime(runtime, on.generation);
    let visibility: "visible" | "hidden" = "visible";
    let shutdownRequested!: () => void;
    const shutdownRequest = new Promise<void>((resolve_) => { shutdownRequested = resolve_; });
    const server = createProgressServer({
      port: 0,
      tokenPath: join(directory, "auth.token"),
      health: () => ({ service: "codex-progress-hud", ...runtime, visibility }),
      showWindow: () => undefined,
      requestShutdown: () => shutdownRequested(),
      runIfGeneration: (generation, desiredState, operation, signal) =>
        store.runIfGeneration(generation, desiredState, operation, { signal })
    });
    await server.listen();
    cleanups.push(() => server.close());
    const client = () => new CompanionHttpClient(server.address().url, join(directory, "auth.token"));
    const diagnostics = {
      directory: join(directory, "diagnostics"),
      pluginVersion: "0.2.0-test",
      mcpVersion: "0.2.0-test",
      host: "127.0.0.1",
      port: server.address().port,
      installManifestPath: paths.installManifestPath,
      dataDirectoryPath: directory
    };
    const closing = createCompanionManager({
      store: createLifecycleStateStore(paths),
      client: client(),
      launcher: { spawnHud: vi.fn() },
      shutdownTimeoutMs: 300,
      logger: { write: async () => undefined },
      diagnostics
    }).close();
    await shutdownRequest;
    const launcher = { spawnHud: vi.fn() };
    const openingClient = client();
    const show = vi.spyOn(openingClient, "show");
    const opening = createCompanionManager({
      store: createLifecycleStateStore(paths),
      client: openingClient,
      launcher,
      startupTimeoutMs: 250,
      sleep: async (milliseconds) => {
        visibility = "hidden";
        await new Promise((resolve_) => setTimeout(resolve_, milliseconds));
      },
      logger: { write: async () => undefined },
      diagnostics
    });

    await expect(opening.open()).resolves.toEqual({
      desiredState: "on",
      observedState: "stopped",
      code: "START_TIMEOUT"
    });
    await expect(closing).resolves.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(await store.readSettings()).toMatchObject({ desiredState: "on", generation: on.generation + 2 });
    expect(await store.readRuntime()).toEqual(runtime);
    expect(launcher.spawnHud).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
  }, 5_000);

  it("lets two managers converge when one replaces the shutdown-latched server between recovery probes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-shutdown-replacement-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const paths = {
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    };
    const store = createLifecycleStateStore(paths);
    const initial = await store.setDesiredState("on");
    const oldRuntime = {
      pid: process.pid,
      version: "0.2.0-test",
      protocolVersion: 1 as const,
      instanceNonce: randomUUID(),
      startedAt: "2026-09-03T00:00:00.000Z"
    };
    const replacementRuntime = {
      pid: process.pid + 1,
      version: "0.2.0-test",
      protocolVersion: 1 as const,
      instanceNonce: randomUUID(),
      startedAt: "2026-09-03T00:00:01.000Z"
    };
    await store.writeRuntime(oldRuntime, initial.generation);
    await writeFile(
      paths.installManifestPath,
      `${JSON.stringify({
        executablePath: process.execPath,
        installDirectory: dirname(process.execPath),
        version: "0.2.0-test"
      })}\n`
    );

    let oldShutdownRequested!: () => void;
    const oldShutdownRequest = new Promise<void>((resolve_) => { oldShutdownRequested = resolve_; });
    const oldShow = vi.fn();
    const oldServer = createProgressServer({
      port: 0,
      tokenPath: join(directory, "auth.token"),
      health: () => ({ service: "codex-progress-hud", ...oldRuntime, visibility: "visible" }),
      showWindow: oldShow,
      requestShutdown: () => oldShutdownRequested(),
      runIfGeneration: (generation, desiredState, operation, signal) =>
        store.runIfGeneration(generation, desiredState, operation, { signal })
    });
    await oldServer.listen();
    let oldServerClosed = false;
    cleanups.push(async () => {
      if (!oldServerClosed) await oldServer.close();
    });
    const port = oldServer.address().port;
    const serviceUrl = oldServer.address().url;
    const tokenPath = join(directory, "auth.token");
    const latchClient = new CompanionHttpClient(serviceUrl, tokenPath);
    const off = await store.setDesiredState("off");
    await latchClient.shutdown({ generation: off.generation, timeoutMs: 1_000 });
    await oldShutdownRequest;

    let replacementServer: ReturnType<typeof createProgressServer> | undefined;
    let replacementVisible = false;
    const replacementShow = vi.fn(() => { replacementVisible = true; });
    cleanups.push(async () => {
      await replacementServer?.close();
    });
    const firstLauncher = {
      spawnHud: vi.fn(async (): Promise<SpawnedHud> => {
        replacementServer = createProgressServer({
          port,
          tokenPath,
          health: () => ({
            service: "codex-progress-hud",
            ...replacementRuntime,
            visibility: replacementVisible ? "visible" : "hidden"
          }),
          showWindow: replacementShow,
          requestShutdown: () => undefined,
          runIfGeneration: (generation, desiredState, operation, signal) =>
            store.runIfGeneration(generation, desiredState, operation, { signal })
        });
        await replacementServer.listen();
        return {
          pid: replacementRuntime.pid,
          terminate: async () => replacementServer?.close()
        };
      })
    };
    const secondLauncher = { spawnHud: vi.fn() };
    let firstRecoveryEntered!: () => void;
    let secondRecoveryEntered!: () => void;
    const firstRecoveryEntry = new Promise<void>((resolve_) => { firstRecoveryEntered = resolve_; });
    const secondRecoveryEntry = new Promise<void>((resolve_) => { secondRecoveryEntered = resolve_; });
    let releaseFirstRecovery!: () => void;
    let releaseSecondRecovery!: () => void;
    const firstRecoveryGate = new Promise<void>((resolve_) => { releaseFirstRecovery = resolve_; });
    const secondRecoveryGate = new Promise<void>((resolve_) => { releaseSecondRecovery = resolve_; });
    let firstSleep = true;
    let secondSleep = true;
    const controlledSleep = (
      which: "first" | "second",
      entered: () => void,
      gate: Promise<void>
    ) => async (milliseconds: number): Promise<void> => {
      const isFirst = which === "first" ? firstSleep : secondSleep;
      if (which === "first") firstSleep = false;
      else secondSleep = false;
      if (isFirst) {
        entered();
        await gate;
        return;
      }
      await new Promise((resolve_) => setTimeout(resolve_, milliseconds));
    };
    const diagnostics = {
      directory: join(directory, "diagnostics"),
      pluginVersion: "0.2.0-test",
      mcpVersion: "0.2.0-test",
      host: "127.0.0.1",
      port,
      installManifestPath: paths.installManifestPath,
      dataDirectoryPath: directory
    };
    const firstManager = createCompanionManager({
      store: createLifecycleStateStore(paths),
      client: new CompanionHttpClient(serviceUrl, tokenPath),
      launcher: firstLauncher,
      sleep: controlledSleep("first", firstRecoveryEntered, firstRecoveryGate),
      startupTimeoutMs: 1_000,
      logger: { write: async () => undefined },
      diagnostics
    });
    const secondManager = createCompanionManager({
      store: createLifecycleStateStore(paths),
      client: new CompanionHttpClient(serviceUrl, tokenPath),
      launcher: secondLauncher,
      sleep: controlledSleep("second", secondRecoveryEntered, secondRecoveryGate),
      startupTimeoutMs: 1_000,
      logger: { write: async () => undefined },
      diagnostics
    });

    const firstOpen = firstManager.open();
    const secondOpen = secondManager.open();
    await Promise.all([firstRecoveryEntry, secondRecoveryEntry]);
    expect(oldShow).not.toHaveBeenCalled();
    await oldServer.close();
    oldServerClosed = true;
    releaseFirstRecovery();
    const firstResult = await firstOpen;
    releaseSecondRecovery();
    const secondResult = await secondOpen;
    const current = await store.readSettings();

    expect(current).toMatchObject({ desiredState: "on", generation: off.generation + 1 });
    expect(firstResult).toMatchObject({
      desiredState: "on",
      observedState: "running",
      health: replacementRuntime
    });
    expect(secondResult).toMatchObject({
      desiredState: "on",
      observedState: "running",
      health: replacementRuntime
    });
    expect(firstLauncher.spawnHud).toHaveBeenCalledTimes(1);
    expect(secondLauncher.spawnHud).not.toHaveBeenCalled();
    expect(replacementShow).toHaveBeenCalledTimes(2);
  }, 10_000);

  it.each(["event", "hide", "shutdown"] as const)(
    "enforces the server deadline for a queued %s mutation before disconnect is observed",
    async (mutation) => {
      const directory = await mkdtemp(join(tmpdir(), `codex-progress-hud-server-deadline-${mutation}-`));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const paths = {
        settingsPath: join(directory, "settings.json"),
        runtimePath: join(directory, "runtime.json"),
        installManifestPath: join(directory, "install.json")
      };
      const store = createLifecycleStateStore(paths);
      const settings = await store.setDesiredState(mutation === "shutdown" ? "off" : "on");
      const held = await holdLifecycleLock(join(directory, ".lifecycle-state.lock"));
      let lockReleased = false;
      cleanups.push(async () => {
        if (!lockReleased) await held.release();
      });
      let guardEntered!: () => void;
      const guardEntry = new Promise<void>((resolve_) => { guardEntered = resolve_; });
      let guardSettled!: () => void;
      const guardSettlement = new Promise<void>((resolve_) => { guardSettled = resolve_; });
      const hideWindow = vi.fn();
      const requestShutdown = vi.fn();
      const server = createProgressServer({
        port: 0,
        tokenPath: join(directory, "auth.token"),
        hideWindow,
        requestShutdown,
        runIfGeneration: (generation, desiredState, operation, signal) => {
          guardEntered();
          return store.runIfGeneration(
            generation,
            desiredState,
            operation,
            { signal }
          ).finally(guardSettled);
        }
      });
      await server.listen();
      cleanups.push(() => server.close());
      const token = (await readFile(join(directory, "auth.token"), "utf8")).trim();
      const client = new CompanionHttpClient(
        server.address().url,
        join(directory, "auth.token"),
        async () => token
      );

      const originalFetch = globalThis.fetch;
      let transportSettled!: () => void;
      const transportSettlement = new Promise<void>((resolve_) => { transportSettled = resolve_; });
      vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        return new Promise<Response>((resolve_, reject) => {
          let clientSettled = false;
          const request = httpRequest(url, {
            method: init?.method ?? "GET",
            headers
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("end", () => {
              transportSettled();
              if (clientSettled) return;
              clientSettled = true;
              resolve_(new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                headers: response.headers as HeadersInit
              }));
            });
          });
          request.once("error", (error) => {
            transportSettled();
            if (clientSettled) return;
            clientSettled = true;
            reject(error);
          });
          const abort = () => {
            if (clientSettled) return;
            clientSettled = true;
            reject(init?.signal?.reason ?? new Error("request aborted"));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
          request.end(typeof init?.body === "string" ? init.body : undefined);
        });
      }) satisfies typeof fetch);

      const startedAt = performance.now();
      const pending = mutation === "event"
        ? client.submit({
            taskId: "late-deadline-task",
            title: "Must expire on the server",
            event: { type: "tracking_started" }
          }, { generation: settings.generation, timeoutMs: 80 })
        : mutation === "hide"
          ? client.hide({ generation: settings.generation, timeoutMs: 80 })
          : client.shutdown({ generation: settings.generation, timeoutMs: 80 });

      try {
        await guardEntry;
        await expect(Promise.race([
          pending,
          new Promise<"watchdog">((resolve_) => setTimeout(() => resolve_("watchdog"), 300))
        ])).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
        expect(performance.now() - startedAt).toBeLessThan(300);
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }

      await held.release();
      lockReleased = true;
      await guardSettlement;
      await transportSettlement;

      expect(hideWindow).not.toHaveBeenCalled();
      expect(requestShutdown).not.toHaveBeenCalled();
      if (mutation === "event") {
        expect((await client.status({ timeoutMs: 300 })).selected?.task.id).not.toBe("late-deadline-task");
      }
      if (mutation === "shutdown") {
        const reopened = await store.setDesiredState("on");
        const snapshot = await client.submit({
          taskId: "after-expired-shutdown",
          title: "Server remains writable",
          event: { type: "tracking_started" }
        }, { generation: reopened.generation, timeoutMs: 300 });
        expect(snapshot.selected?.task.id).toBe("after-expired-shutdown");
      }
    },
    5_000
  );

  it("does not apply an event after its real client disconnects behind the generation lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-disconnected-event-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const paths = {
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    };
    const store = createLifecycleStateStore(paths);
    const settings = await store.setDesiredState("on");
    const held = await holdLifecycleLock(join(directory, ".lifecycle-state.lock"));
    let lockReleased = false;
    cleanups.push(async () => {
      if (!lockReleased) await held.release();
    });
    let guardEntered!: () => void;
    const guardEntry = new Promise<void>((resolve_) => { guardEntered = resolve_; });
    let guardSettled!: () => void;
    const guardSettlement = new Promise<void>((resolve_) => { guardSettled = resolve_; });
    const server = createProgressServer({
      port: 0,
      tokenPath: join(directory, "auth.token"),
      runIfGeneration: (generation, desiredState, operation, signal) => {
        guardEntered();
        return store.runIfGeneration(
          generation,
          desiredState,
          operation,
          { signal }
        ).finally(guardSettled);
      }
    });
    await server.listen();
    cleanups.push(() => server.close());
    const token = (await readFile(join(directory, "auth.token"), "utf8")).trim();
    const client = new CompanionHttpClient(
      server.address().url,
      join(directory, "auth.token"),
      async () => token
    );
    const startedAt = performance.now();

    const pending = client.submit({
      taskId: "late-task",
      title: "Must not be accepted",
      event: { type: "tracking_started" }
    }, { generation: settings.generation, timeoutMs: 20 });
    await guardEntry;
    const result = await Promise.race([
      pending.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) =>
        setTimeout(() => resolve_({ kind: "watchdog" }), 90)
      )
    ]);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toMatchObject({
      kind: "rejected",
      error: { code: "REQUEST_TIMEOUT" }
    });
    expect(elapsedMs).toBeLessThan(90);

    await held.release();
    lockReleased = true;
    await guardSettlement;
    const snapshot = await client.status({ timeoutMs: 90 });

    expect(snapshot.selected?.task.id).not.toBe("late-task");
  }, 5_000);

  it.each([
    ["hide", "on", (client: CompanionHttpClient, generation: number) =>
      client.hide({ generation, timeoutMs: 20 })],
    ["shutdown", "off", (client: CompanionHttpClient, generation: number) =>
      client.shutdown({ generation, timeoutMs: 20 })]
  ] as const)(
    "does not apply a disconnected %s control behind the generation lock",
    async (control, desiredState, invoke) => {
      const directory = await mkdtemp(join(tmpdir(), `codex-progress-hud-disconnected-${control}-`));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const store = createLifecycleStateStore({
        settingsPath: join(directory, "settings.json"),
        runtimePath: join(directory, "runtime.json"),
        installManifestPath: join(directory, "install.json")
      });
      const settings = await store.setDesiredState(desiredState);
      const held = await holdLifecycleLock(join(directory, ".lifecycle-state.lock"));
      let lockReleased = false;
      cleanups.push(async () => {
        if (!lockReleased) await held.release();
      });
      let guardEntered!: () => void;
      const guardEntry = new Promise<void>((resolve_) => { guardEntered = resolve_; });
      let guardSettled!: () => void;
      const guardSettlement = new Promise<void>((resolve_) => { guardSettled = resolve_; });
      const hideWindow = vi.fn();
      const requestShutdown = vi.fn();
      const server = createProgressServer({
        port: 0,
        tokenPath: join(directory, "auth.token"),
        hideWindow,
        requestShutdown,
        runIfGeneration: (generation, state, operation, signal) => {
          guardEntered();
          return store.runIfGeneration(
            generation,
            state,
            operation,
            { signal }
          ).finally(guardSettled);
        }
      });
      await server.listen();
      cleanups.push(() => server.close());
      const token = (await readFile(join(directory, "auth.token"), "utf8")).trim();
      const client = new CompanionHttpClient(
        server.address().url,
        join(directory, "auth.token"),
        async () => token
      );

      const pending = invoke(client, settings.generation);
      await guardEntry;
      await expect(Promise.race([
        pending,
        new Promise<"watchdog">((resolve_) =>
          setTimeout(() => resolve_("watchdog"), 90)
        )
      ])).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      await held.release();
      lockReleased = true;
      await guardSettlement;

      expect(hideWindow).not.toHaveBeenCalled();
      expect(requestShutdown).not.toHaveBeenCalled();
      if (control === "shutdown") {
        const reopened = await store.setDesiredState("on");
        const snapshot = await client.submit({
          taskId: "after-cancelled-shutdown",
          title: "Server remains writable",
          event: { type: "tracking_started" }
        }, { generation: reopened.generation, timeoutMs: 90 });
        expect(snapshot.selected?.task.id).toBe("after-cancelled-shutdown");
      }
    },
    5_000
  );

  it("keeps close authoritative across two real MCP processes after tracking_start leases but before submit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-two-mcp-race-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const paths = {
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    };
    const store = createLifecycleStateStore(paths);
    const on = await store.setDesiredState("on");
    const generationGuardCalls: Array<{
      generation: number;
      desiredState: "on" | "off";
    }> = [];
    const runtime = {
      pid: process.pid,
      version: "0.2.0-test",
      protocolVersion: 1 as const,
      instanceNonce: randomUUID(),
      startedAt: new Date().toISOString()
    };
    await store.writeRuntime(runtime, on.generation);
    let shutdownRequested!: () => void;
    const shutdownRequest = new Promise<void>((resolve) => { shutdownRequested = resolve; });
    const target = createProgressServer({
      port: 0,
      tokenPath: join(directory, "auth.token"),
      health: () => ({
        service: "codex-progress-hud",
        ...runtime,
        visibility: "visible"
      }),
      showWindow: () => undefined,
      hideWindow: () => undefined,
      requestShutdown: () => shutdownRequested(),
      runIfGeneration: (generation, desiredState, operation, signal) => {
        generationGuardCalls.push({ generation, desiredState });
        return store.runIfGeneration(generation, desiredState, operation, { signal });
      }
    });
    await target.listen();
    let targetClosed = false;
    cleanups.push(async () => {
      if (!targetClosed) await target.close();
    });

    let eventArrived!: () => void;
    const eventArrival = new Promise<void>((resolve) => { eventArrived = resolve; });
    let releaseEvent!: () => void;
    const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    let shutdownRelayed!: () => void;
    const shutdownRelay = new Promise<void>((resolve) => { shutdownRelayed = resolve; });
    let shutdownArrived!: () => void;
    const shutdownArrival = new Promise<void>((resolve) => { shutdownArrived = resolve; });
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const acceptedEvents: unknown[] = [];
    let eventRequests = 0;
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url === "/api/events" && request.method === "POST") {
          eventRequests += 1;
          eventArrived();
          await eventGate;
        }
        if (request.url === "/api/shutdown" && request.method === "POST") {
          shutdownArrived();
          await shutdownGate;
        }
        const upstream = await fetch(`${target.address().url}${request.url ?? "/"}`, {
          ...(request.method === undefined ? {} : { method: request.method }),
          headers: request.headers as Record<string, string>,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
        response.end(body);
        if (request.url === "/api/events" && upstream.ok) {
          acceptedEvents.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        }
        if (request.url === "/api/shutdown") shutdownRelayed();
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const proxyAddress = proxy.address();
    if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy address unavailable");
    let proxyClosed = false;
    cleanups.push(async () => {
      if (proxyClosed) return;
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const environment = {
      ...getDefaultEnvironment(),
      CODEX_PROGRESS_HUD_DATA_DIR: directory,
      CODEX_PROGRESS_HUD_TOKEN_PATH: join(directory, "auth.token"),
      CODEX_PROGRESS_HUD_URL: `http://127.0.0.1:${proxyAddress.port}`
    };
    const firstTransport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(pluginRoot, "dist/main.js"), "--mcp-stdio"],
      env: environment,
      stderr: "pipe"
    });
    const secondTransport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(pluginRoot, "dist/main.js"), "--mcp-stdio"],
      env: environment,
      stderr: "pipe"
    });
    const firstClient = new Client({ name: "race-writer", version: "1.0.0" });
    const secondClient = new Client({ name: "race-closer", version: "1.0.0" });

    try {
      await Promise.all([firstClient.connect(firstTransport), secondClient.connect(secondTransport)]);
      const reportPromise = firstClient.callTool({
        name: "tracking_start",
        arguments: { task_handle: "hud_aaaaaaaaaaaaaaaaaaaa", title: "Two MCP race" }
      });
      await eventArrival;
      const closePromise = secondClient.callTool({ name: "hud_close", arguments: {} });
      await vi.waitFor(async () => {
        expect((await store.readSettings()).desiredState).toBe("off");
      });
      const closedGeneration = (await store.readSettings()).generation;
      await shutdownArrival;
      releaseEvent();
      const report = await reportPromise;
      releaseShutdown();
      await shutdownRequest;
      await shutdownRelay;
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      proxyClosed = true;
      const closed = await closePromise;

      expect(report.structuredContent).toMatchObject({
        ok: true,
        desiredState: "off",
        code: "MANUALLY_DISABLED"
      });
      expect(closed.structuredContent).toMatchObject({
        ok: true,
        desiredState: "off",
        observedState: "stopped"
      });
      expect((await store.readSettings()).desiredState).toBe("off");
      expect((await store.readSettings()).generation).toBe(closedGeneration);
      expect(generationGuardCalls).toContainEqual({
        generation: on.generation,
        desiredState: "on"
      });
      expect(eventRequests).toBe(1);
      expect(acceptedEvents).not.toContainEqual(expect.objectContaining({
        event: expect.objectContaining({ type: "tracking_started" })
      }));
    } finally {
      await Promise.all([
        firstClient.close().catch(() => undefined),
        secondClient.close().catch(() => undefined)
      ]);
      await target.close();
      targetClosed = true;
    }
  }, 20_000);

  it("controls a test-owned companion and recovers it once after termination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-lifecycle-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const executablePath = process.execPath;
    const paths = {
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    };
    await writeFile(
      paths.installManifestPath,
      `${JSON.stringify({
        executablePath,
        installDirectory: dirname(executablePath),
        version: "0.1.0-test"
      })}\n`
    );

    let active: TestOwnedCompanion | undefined;
    let client: CompanionHttpClient | undefined;
    let launches = 0;
    const launcher: ProcessLauncher = {
      async spawnHud(_executablePath, options): Promise<SpawnedHud> {
        const spawned = await startTestOwnedCompanion(directory, options.generation);
        active = spawned;
        cleanups.push(() => spawned.terminate());
        client = new CompanionHttpClient(spawned.serviceUrl, spawned.tokenPath);
        launches += 1;
        return spawned;
      }
    };
    const delegatedClient = {
      identity: (options?: Parameters<CompanionHttpClient["identity"]>[0]) =>
        client === undefined ? Promise.reject(new Error("offline")) : client.identity(options),
      health: (options?: Parameters<CompanionHttpClient["health"]>[0]) =>
        client === undefined ? Promise.reject(new Error("offline")) : client.health(options),
      show: (options?: Parameters<CompanionHttpClient["show"]>[0]) =>
        client === undefined ? Promise.reject(new Error("offline")) : client.show(options),
      hide: (options?: Parameters<CompanionHttpClient["hide"]>[0]) =>
        client === undefined ? Promise.reject(new Error("offline")) : client.hide(options),
      shutdown: (options?: Parameters<CompanionHttpClient["shutdown"]>[0]) =>
        client === undefined ? Promise.reject(new Error("offline")) : client.shutdown(options)
    };
    const manager = createCompanionManager({
      store: createLifecycleStateStore(paths),
      client: delegatedClient,
      launcher,
      recoveryCooldownMs: 60_000,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(directory, "diagnostics"),
        pluginVersion: "0.1.0-test",
        mcpVersion: "0.1.0-test",
        host: "127.0.0.1",
        port: 0,
        installManifestPath: paths.installManifestPath,
        dataDirectoryPath: directory
      }
    });

    const opened = await manager.open();
    expect(opened.observedState).toBe("running");
    expect(opened.health?.protocolVersion).toBe(1);
    expect((await manager.hide()).observedState).toBe("hidden");
    expect((await manager.open()).observedState).toBe("running");

    const first = active;
    expect(first).toBeDefined();
    await first!.terminate();
    await first!.waitForExit();
    await expect(manager.ensureForWrite("progress_report")).resolves.toMatchObject({
      kind: "ready",
      snapshot: { observedState: "running" }
    });
    expect(launches).toBe(2);

    await manager.close();
    expect((await manager.status()).desiredState).toBe("off");
    expect(await manager.ensureForWrite("progress_report")).toMatchObject({ kind: "suppressed" });
  }, 20_000);

  it("calls the lifecycle tools over stdio instead of only discovering them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-stdio-lifecycle-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = createLifecycleStateStore({
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    });
    const settings = await store.setDesiredState("on");
    const companion = await startTestOwnedCompanion(directory, settings.generation);
    cleanups.push(() => companion.terminate());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(pluginRoot, "dist/main.js"), "--mcp-stdio"],
      cwd: directory,
      env: {
        ...getDefaultEnvironment(),
        CODEX_PROGRESS_HUD_DATA_DIR: directory,
        CODEX_PROGRESS_HUD_TOKEN_PATH: companion.tokenPath,
        CODEX_PROGRESS_HUD_URL: companion.serviceUrl
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "lifecycle-integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const status = await client.callTool({ name: "hud_status", arguments: {} });
      expect(status.structuredContent).toMatchObject({
        ok: true,
        observedState: "running"
      });

      const hidden = await client.callTool({ name: "hud_hide", arguments: {} });
      expect(hidden.structuredContent).toMatchObject({ ok: true, observedState: "hidden" });

      const opened = await client.callTool({ name: "hud_open", arguments: {} });
      expect(opened.structuredContent).toMatchObject({
        ok: true,
        desiredState: "on",
        observedState: "running"
      });

      const diagnosed = await client.callTool({ name: "hud_diagnose", arguments: {} });
      expect(diagnosed.structuredContent).toMatchObject({ ok: true });
      expect((diagnosed.structuredContent as { reportPath: string }).reportPath).toContain(
        join(directory, "diagnostics")
      );

      const closed = await client.callTool({ name: "hud_close", arguments: {} });
      expect(closed.structuredContent).toMatchObject({
        ok: true,
        desiredState: "off",
        observedState: "stopped"
      });
      await companion.waitForExit();

      const suppressed = await client.callTool({
        name: "progress_report",
        arguments: {
          task_handle: "hud_aaaaaaaaaaaaaaaaaaaa",
          title: "Lifecycle integration",
          phase: "verification"
        }
      });
      expect(suppressed.structuredContent).toMatchObject({
        ok: true,
        desiredState: "off",
        code: "MANUALLY_DISABLED"
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);
});
