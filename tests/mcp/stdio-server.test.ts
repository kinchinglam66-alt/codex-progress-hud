import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

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
      const packageJson = JSON.parse(
        await readFile(resolve(pluginRoot, "package.json"), "utf8")
      ) as { main?: string };
      expect(packageJson.main).toBeDefined();
      const child = spawn(process.execPath, [resolve(pluginRoot, packageJson.main!), "--mcp-stdio"], {
        cwd: taskDirectory,
        env: { ...process.env, CODEX_PROGRESS_HUD_DATA_DIR: dataDirectory },
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
        const observational = await request(3, "tools/call", {
          name: "tracking_status",
          arguments: {}
        });
        expect(observational.error).toBeUndefined();
        await expect(access(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        const noAssociation = await request(4, "tools/call", {
          name: "tracking_pause",
          arguments: {}
        });
        expect(noAssociation.error).toBeUndefined();
        expect(JSON.stringify(noAssociation.result)).toContain('"associationSource":"mcp_lease"');
        expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
        expect(stdoutLines.every((line) => {
          try { return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === "2.0"; }
          catch { return false; }
        }), `non-protocol stdout: ${stdoutLines.join("\n")}`).toBe(true);
      } finally {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
        await rm(taskDirectory, { recursive: true, force: true });
      }
    },
    15_000
  );
});
