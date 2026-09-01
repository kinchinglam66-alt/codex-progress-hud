import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCompanionManager } from "../../src/lifecycle/companion-manager.js";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import type { ProcessLauncher, SpawnedHud } from "../../src/lifecycle/process-launcher.js";
import { CompanionHttpClient } from "../../src/mcp/report-client.js";

interface TestOwnedCompanion extends SpawnedHud {
  serviceUrl: string;
  tokenPath: string;
  waitForExit(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

beforeAll(async () => {
  try {
    await access(resolve(pluginRoot, "dist/main.js"));
  } catch {
    await execFileAsync(
      process.execPath,
      [resolve(pluginRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
      { cwd: pluginRoot }
    );
  }
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startTestOwnedCompanion(directory: string): Promise<TestOwnedCompanion> {
  const ownerNonce = randomUUID();
  const tokenPath = join(directory, `auth-${ownerNonce}.token`);
  const fixturePath = join(directory, `companion-${ownerNonce}.mjs`);
  await writeFile(
    fixturePath,
    `import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const ownerNonce = process.env.CODEX_PROGRESS_HUD_TEST_OWNED;
const tokenPath = process.env.CODEX_PROGRESS_HUD_TEST_TOKEN_PATH;
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
      CODEX_PROGRESS_HUD_TEST_TOKEN_PATH: tokenPath
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
      async spawnHud(): Promise<SpawnedHud> {
        const spawned = await startTestOwnedCompanion(directory);
        active = spawned;
        cleanups.push(() => spawned.terminate());
        client = new CompanionHttpClient(spawned.serviceUrl, spawned.tokenPath);
        launches += 1;
        return spawned;
      }
    };
    const delegatedClient = {
      identity: () => client === undefined ? Promise.reject(new Error("offline")) : client.identity(),
      health: () => client === undefined ? Promise.reject(new Error("offline")) : client.health(),
      show: () => client === undefined ? Promise.reject(new Error("offline")) : client.show(),
      hide: () => client === undefined ? Promise.reject(new Error("offline")) : client.hide(),
      shutdown: () => client === undefined ? Promise.reject(new Error("offline")) : client.shutdown()
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
    const companion = await startTestOwnedCompanion(directory);
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
          task_id: "stdio-lifecycle",
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
