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

class CapturingStdioClientTransport extends StdioClientTransport {
  readonly stdoutChunks: Buffer[] = [];

  override async start(): Promise<void> {
    const readBuffer = (this as unknown as {
      _readBuffer: { append(chunk: Buffer): void };
    })._readBuffer;
    const append = readBuffer.append.bind(readBuffer);
    readBuffer.append = (chunk: Buffer): void => {
      this.stdoutChunks.push(Buffer.from(chunk));
      append(chunk);
    };
    await super.start();
  }

  stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }
}

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

describe("plugin MCP stdio server", () => {
  it(
    "initializes and exposes every tool when Codex starts it from another task directory",
    async () => {
      const taskDirectory = await mkdtemp(join(tmpdir(), "codex-progress-hud-task-"));
      const packageJson = JSON.parse(
        await readFile(resolve(pluginRoot, "package.json"), "utf8")
      ) as { main?: string };
      const server = packageJson.main === undefined
        ? undefined
        : {
            command: process.execPath,
            args: [resolve(pluginRoot, packageJson.main), "--mcp-stdio"]
          };

      expect(server).toBeDefined();

      const transport = new CapturingStdioClientTransport({
        command: server!.command,
        ...(server!.args ? { args: server!.args } : {}),
        cwd: taskDirectory,
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
            "hud_close",
            "hud_diagnose",
            "hud_hide",
            "hud_open",
            "hud_status",
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
        const stdoutLines = transport.stdout().split(/\r?\n/u).filter(Boolean);
        expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
        expect(stdoutLines.every((line) => {
          try {
            const message = JSON.parse(line) as { jsonrpc?: unknown };
            return message.jsonrpc === "2.0";
          } catch {
            return false;
          }
        }), `non-protocol stdout: ${transport.stdout()}`).toBe(true);
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
