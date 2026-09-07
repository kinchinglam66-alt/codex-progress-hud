import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import { CompanionHttpClient } from "../../src/mcp/report-client.js";
import { createProgressServer } from "../../src/server/http-server.js";

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

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: unknown;
}

describe("plugin MCP stdio server", () => {
  it.each(["on", "off"] as const)(
    "initializes with desired state %s and exposes every tool with protocol-only stdout",
    async (initialState) => {
      const taskDirectory = await mkdtemp(join(tmpdir(), "codex-progress-hud-task-"));
      const dataDirectory = join(taskDirectory, "isolated-hud-data");
      const stateStore = createLifecycleStateStore({
        settingsPath: join(dataDirectory, "settings.json"),
        runtimePath: join(dataDirectory, "runtime.json"),
        installManifestPath: join(dataDirectory, "install.json")
      });
      const settings = await stateStore.setDesiredState(initialState);
      const runtime = {
        pid: process.pid,
        version: "0.2.0-test",
        protocolVersion: 3 as const,
        instanceNonce: randomUUID(),
        startedAt: new Date().toISOString()
      };
      await stateStore.writeRuntime(runtime, settings.generation);
      const companion = createProgressServer({
        port: 0,
        tokenPath: join(dataDirectory, "auth.token"),
        health: () => ({ service: "codex-progress-hud" as const, ...runtime, visibility: "visible" as const }),
        showWindow: () => undefined,
        hideWindow: () => undefined,
        requestShutdown: () => undefined,
        runIfGeneration: (generation, desiredState, operation, signal) =>
          stateStore.runIfGeneration(generation, desiredState, operation, { signal })
      });
      await companion.listen();
      const observer = new CompanionHttpClient(
        companion.address().url,
        join(dataDirectory, "auth.token")
      );
      const packageJson = JSON.parse(
        await readFile(resolve(pluginRoot, "package.json"), "utf8")
      ) as { main?: string };
      expect(packageJson.main).toBeDefined();
      const child = spawn(process.execPath, [resolve(pluginRoot, packageJson.main!), "--mcp-stdio"], {
        cwd: taskDirectory,
        env: {
          ...process.env,
          CODEX_PROGRESS_HUD_DATA_DIR: dataDirectory,
          CODEX_PROGRESS_HUD_TOKEN_PATH: join(dataDirectory, "auth.token"),
          CODEX_PROGRESS_HUD_URL: companion.address().url
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      const stdoutLines: string[] = [];
      const pending = new Map<number, {
        resolve(response: JsonRpcResponse): void;
        reject(error: Error): void;
      }>();
      let stdoutBuffer = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          stdoutLines.push(line);
          try {
            const message = JSON.parse(line) as JsonRpcResponse;
            if (typeof message.id === "number") {
              pending.get(message.id)?.resolve(message);
              pending.delete(message.id);
            }
          } catch {
            // The final protocol-only assertion reports the exact public stdout line.
          }
        }
      });
      const exit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.once("exit", (code) => {
        for (const waiter of pending.values()) {
          waiter.reject(new Error(`MCP child exited ${code}: ${stderr.trim()}`));
        }
        pending.clear();
      });
      const request = (id: number, method: string, params?: unknown): Promise<JsonRpcResponse> => {
        const response = new Promise<JsonRpcResponse>((resolveResponse, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP request ${method} timed out: ${stderr.trim()}`));
          }, 5_000);
          pending.set(id, {
            resolve(value) { clearTimeout(timer); resolveResponse(value); },
            reject(error) { clearTimeout(timer); reject(error); }
          });
        });
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params })
        })}\n`);
        return response;
      };

      try {
        const initialized = await request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "public-stdio-test", version: "1.0.0" }
        });
        expect(initialized.error).toBeUndefined();
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        })}\n`);
        const listed = await request(2, "tools/list", {});
        if (initialState === "on") {
          await expect.poll(() => companion.leaseStore.active().length).toBe(1);
        } else {
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(companion.leaseStore.active()).toHaveLength(0);
          expect((await stateStore.readSettings()).desiredState).toBe("off");
        }
        expect(companion.store.snapshot().tasks).toHaveLength(0);
        expect(listed.error).toBeUndefined();
        const tools = (listed.result as { tools: Array<{ name: string }> }).tools;

        expect(tools.map((tool) => tool.name).sort()).toEqual(
          [
            "hud_close", "hud_diagnose", "hud_hide", "hud_open", "hud_status",
            "task_status", "tracking_pause",
            "tracking_resume", "tracking_start", "tracking_status", "tracking_stop"
          ].sort()
        );
        const toolByName = new Map(
          (listed.result as { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }).tools
            .map((tool) => [tool.name, tool] as const)
        );
        expect(toolByName.get("tracking_status")?.description).toContain("observational");
        expect(toolByName.get("hud_open")?.description).toContain("Deprecated");
        expect(toolByName.get("hud_close")?.description).toContain("Deprecated");
        expect(toolByName.get("tracking_start")?.inputSchema).not.toHaveProperty(
          "required",
          expect.arrayContaining(["task_handle"])
        );
        for (const toolName of [
          "tracking_start", "tracking_pause", "tracking_resume", "tracking_stop"
        ]) {
          const description = toolByName.get(toolName)?.description ?? "";
          expect(description).toContain("opaque task_handle");
          expect(description).toContain("MCP-lease");
          expect(description).not.toContain("injected by Hooks");
        }
        const observational = await request(3, "tools/call", {
          name: "tracking_status",
          arguments: {}
        });
        expect(observational.error).toBeUndefined();
        const trackingStart = await request(4, "tools/call", {
          name: "tracking_start",
          arguments: { title: "Handle-free stdio task" }
        });
        const progressReport = await request(5, "tools/call", {
          name: "progress_report",
          arguments: {
            phase: "verification",
            progress: 0.8,
            eta_low_seconds: 10,
            eta_high_seconds: 20
          }
        });
        const validationObserved = await request(6, "tools/call", {
          name: "validation_observed",
          arguments: { result: "passed" }
        });
        const taskOutcome = await request(7, "tools/call", {
          name: "task_outcome",
          arguments: { outcome: "completed", verified: true }
        });
        for (const response of [progressReport, validationObserved, taskOutcome]) {
          expect(response.error !== undefined || (response.result as {isError?: boolean})?.isError === true).toBe(true);
        }
        for (const response of [trackingStart]) {
          expect(response.error).toBeUndefined();
          expect(response.result).toMatchObject({
            structuredContent: { ok: true, associationSource: "mcp_lease" }
          });
          expect(JSON.stringify(response.result)).not.toContain("ownerNonce");
          expect(JSON.stringify(response.result)).not.toContain("lease_");
        }
        const snapshotStatus = await request(8, "tools/call", {
          name: "tracking_status",
          arguments: {}
        });
        expect(snapshotStatus.error).toBeUndefined();
        const snapshot = JSON.parse(
          ((snapshotStatus.result as { content: Array<{ text: string }> }).content[0]!).text
        ) as { tasks: unknown[] };
        expect(snapshot.tasks).toHaveLength(1);
        expect((await observer.status()).tasks).toHaveLength(1);

        for (const [id, name, expectedStatus] of [
          [20, 'tracking_pause', 'paused'], [21, 'tracking_resume', 'running'], [22, 'tracking_stop', 'stopped']
        ] as const) {
          const controlled = await request(id, 'tools/call', {name, arguments: {}});
          expect(controlled.error).toBeUndefined();
          expect(controlled.result).toMatchObject({structuredContent: {ok: true}});
          expect((await observer.status()).selected?.task.status).toBe(expectedStatus);
        }

        const secondTrackingStart = await request(9, "tools/call", {
          name: "tracking_start",
          arguments: { title: "Handle-free second stdio task" }
        });
        const secondProgressReport = await request(10, "tools/call", {
          name: "progress_report",
          arguments: {
            phase: "second verification",
            progress: 0.2,
            eta_low_seconds: 30,
            eta_high_seconds: 40
          }
        });
        expect(secondProgressReport.error !== undefined || (secondProgressReport.result as {isError?: boolean})?.isError === true).toBe(true);
        for (const response of [secondTrackingStart]) {
          expect(response.error).toBeUndefined();
          expect(response.result).toMatchObject({
            structuredContent: { ok: true, associationSource: "mcp_lease" }
          });
          expect(JSON.stringify(response.result)).not.toContain("ownerNonce");
          expect(JSON.stringify(response.result)).not.toContain("lease_");
        }
        const restartedStatus = await request(11, "tools/call", {
          name: "tracking_status",
          arguments: {}
        });
        const restartedSnapshot = JSON.parse(
          ((restartedStatus.result as { content: Array<{ text: string }> }).content[0]!).text
        ) as {
          tasks: Array<{ status: string }>;
          selected: { task: {
            status: string;
            progress?: number;
            verificationEvidence?: unknown;
          } } | null;
        };
        expect(restartedSnapshot.tasks).toHaveLength(1);
        expect(restartedSnapshot.tasks.map((task) => task.status)).toEqual(
          expect.arrayContaining(["running"])
        );
        expect(restartedSnapshot.selected?.task).toMatchObject({
          status: "running"
        });
        expect(restartedSnapshot.selected?.task.progress).toBeUndefined();
        expect(restartedSnapshot.selected?.task.verificationEvidence).toBeUndefined();
        const restartedObserverSnapshot = await observer.status();
        expect(restartedObserverSnapshot.tasks).toHaveLength(1);
        expect(restartedObserverSnapshot.tasks.map((task) => task.status)).toEqual(
          expect.arrayContaining(["running"])
        );
        const scenarioPath = resolve(pluginRoot, 'scripts/passive-control-smoke.mjs');
        const { exercisePassiveControls } = await import(scenarioPath);
        let scenarioId = 100;
        const scenarioResult = await exercisePassiveControls({
          listTools: async () => (await request(scenarioId++, 'tools/list', {})).result,
          callTool: async (params: unknown) => {
            const response = await request(scenarioId++, 'tools/call', params);
            if (response.error) throw new Error(JSON.stringify(response.error));
            return response.result;
          }
        });
        expect(scenarioResult).toEqual({statuses: ['running', 'paused', 'running', 'stopped', 'running']});
        expect((await observer.status()).selected?.task.status).toBe('running');
        expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
        expect(stdoutLines.every((line) => {
          try { return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === "2.0"; }
          catch { return false; }
        }), `non-protocol stdout: ${stdoutLines.join("\n")}`).toBe(true);
        child.stdin.end();
        await exit;
        await expect.poll(() => companion.leaseStore.active().length).toBe(0);
      } finally {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
        await companion.close();
        await rm(taskDirectory, { recursive: true, force: true });
      }
    },
    15_000
  );
});
