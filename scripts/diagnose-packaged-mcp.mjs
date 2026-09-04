import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "win32") {
  process.stdout.write("Packaged MCP diagnostic is Windows-only; skipped.\n");
  process.exit(0);
}
const executablePath = resolve("release/win-unpacked/Codex Progress HUD.exe");
const installDirectory = dirname(executablePath);
const appData = await mkdtemp(join(tmpdir(), "hud-packaged-mcp-"));
const manifestDirectory = join(appData, "codex-progress-hud");
await mkdir(manifestDirectory, { recursive: true });
await writeFile(join(manifestDirectory, "install.json"), `${JSON.stringify({ executablePath, installDirectory, version: "0.2.0" })}\n`, "utf8");
const transport = new StdioClientTransport({
  command: resolve("plugins/codex-progress-hud/scripts/codex-progress-hud-launcher.exe"),
  args: ["--mcp-stdio"],
  cwd: resolve("plugins/codex-progress-hud"),
  env: { ...getDefaultEnvironment(), APPDATA: appData },
  stderr: "inherit"
});
const client = new Client({ name: "packaged-mcp-diagnostic", version: "0.2.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 14) throw new Error(`expected 14 MCP tools, received ${tools.tools.length}`);
  process.stdout.write("Packaged MCP initialize and tools/list passed with 14 tools.\n");
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await rm(appData, { recursive: true, force: true }).catch(() => undefined);
}
