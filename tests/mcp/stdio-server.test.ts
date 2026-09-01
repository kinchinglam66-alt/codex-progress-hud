import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type McpConfig = {
  mcpServers: Record<
    string,
    {
      command: string;
      args?: string[];
      cwd?: string;
    }
  >;
};

beforeAll(async () => {
  try {
    await access(resolve(pluginRoot, "dist/mcp/main.js"));
  } catch {
    await execFileAsync(
      process.execPath,
      [resolve(pluginRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
      { cwd: pluginRoot }
    );
  }
});

describe("plugin MCP stdio server", () => {
  it(
    "initializes and exposes every tool when Codex starts it from another task directory",
    async () => {
      const taskDirectory = await mkdtemp(join(tmpdir(), "codex-progress-hud-task-"));
      const config = JSON.parse(
        await readFile(resolve(pluginRoot, ".mcp.json"), "utf8")
      ) as McpConfig;
      const server = config.mcpServers["codex-progress-hud"];

      expect(server).toBeDefined();

      const transport = new StdioClientTransport({
        command: server!.command,
        ...(server!.args ? { args: server!.args } : {}),
        cwd: server!.cwd ? resolve(pluginRoot, server!.cwd) : taskDirectory,
        stderr: "pipe"
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const client = new Client({ name: "plugin-integration-test", version: "1.0.0" });

      try {
        await client.connect(transport);
        const result = await client.listTools();

        expect(result.tools.map((tool) => tool.name).sort()).toEqual(
          [
            "progress_report",
            "task_outcome",
            "task_status",
            "tracking_pause",
            "tracking_resume",
            "tracking_start",
            "tracking_status",
            "tracking_stop"
          ].sort()
        );
      } catch (error) {
        throw new Error(
          `MCP server failed when launched for a different task directory. ${stderr.trim()}`,
          { cause: error }
        );
      } finally {
        await client.close().catch(() => undefined);
        await rm(taskDirectory, { recursive: true, force: true });
      }
    },
    15_000
  );
});
