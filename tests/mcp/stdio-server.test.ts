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
  it(
    "initializes and exposes every tool with protocol-only public child stdout",
    async () => {
      const taskDirectory = await mkdtemp(join(tmpdir(), "codex-progress-hud-task-"));
      const dataDirectory = join(taskDirectory, "isolated-hud-data");
      const stateStore = createLifecycleStateStore({
        settingsPath: join(dataDirectory, "settings.json"),
        runtimePath: join(dataDirectory, "runtime.json"),
        installManifestPath: join(dataDirectory, "install.json")
      });
      const settings = await stateStore.setDesiredState("on");
      const runtime = {
        pid: process.pid,
        version: "0.2.0-test",
        protocolVersion: 1 as const,
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
        expect(listed.error).toBeUndefined();
        const tools = (listed.result as { tools: Array<{ name: string }> }).tools;

        expect(tools.map((tool) => tool.name).sort()).toEqual(
          [
            "hud_close", "hud_diagnose", "hud_hide", "hud_open", "hud_status",
            "progress_report", "task_outcome", "task_status", "tracking_pause",
            "tracking_resume", "tracking_start", "tracking_status", "tracking_stop",
            "validation_observed"
          ].sort()
        );
        const toolByName = new Map(
          (listed.result as { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }).tools
            .map((tool) => [tool.name, tool] as const)
        );
        expect(toolByName.get("tracking_status")?.description).toContain("observational");
        expect(toolByName.get("hud_open")?.description).toContain("Deprecated");
        expect(toolByName.get("hud_close")?.description).toContain("Deprecated");
        expect(toolByName.get("progress_report")?.inputSchema).toMatchObject({
          required: expect.arrayContaining(["phase"])
        });
        expect(toolByName.get("progress_report")?.inputSchema).not.toHaveProperty("required", expect.arrayContaining(["task_handle"]));
        expect(toolByName.get("progress_report")?.inputSchema).not.toHaveProperty("properties.task_id");
        for (const [toolName, requiredField] of [
          ["progress_report", "phase"],
          ["validation_observed", "result"],
          ["task_outcome", "outcome"]
        ] as const) {
          expect(toolByName.get(toolName)?.inputSchema).toMatchObject({
            required: expect.arrayContaining([requiredField])
          });
          expect(toolByName.get(toolName)?.inputSchema).not.toHaveProperty(
            "required",
            expect.arrayContaining(["task_handle"])
          );
        }
        expect(toolByName.get("tracking_start")?.inputSchema).not.toHaveProperty(
          "required",
          expect.arrayContaining(["task_handle"])
        );
        for (const toolName of [
          "tracking_start", "tracking_pause", "tracking_resume", "tracking_stop",
          "progress_report", "validation_observed", "task_outcome"
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
          arguments: { phase: "verification" }
        });
        const validationObserved = await request(6, "tools/call", {
          name: "validation_observed",
          arguments: { result: "passed" }
        });
        const taskOutcome = await request(7, "tools/call", {
          name: "task_outcome",
          arguments: { outcome: "completed", verified: true }
        });
        for (const response of [trackingStart, progressReport, validationObserved, taskOutcome]) {
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
        expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
        expect(stdoutLines.every((line) => {
          try { return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === "2.0"; }
          catch { return false; }
        }), `non-protocol stdout: ${stdoutLines.join("\n")}`).toBe(true);
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
