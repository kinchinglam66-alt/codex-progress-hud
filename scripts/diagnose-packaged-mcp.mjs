import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "win32") {
  process.stdout.write("Packaged MCP diagnostic is Windows-only; skipped.\n");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const executablePath = resolve(root, "release/win-unpacked/Codex Progress HUD.exe");
const installDirectory = dirname(executablePath);
const appData = await mkdtemp(join(tmpdir(), "hud-packaged-mcp-"));
const manifestDirectory = join(appData, "codex-progress-hud");
await mkdir(manifestDirectory, { recursive: true });
await writeFile(
  join(manifestDirectory, "install.json"),
  `${JSON.stringify({ executablePath, installDirectory, version: packageManifest.version })}\n`,
  "utf8"
);
const port = 20_000 + Math.floor(Math.random() * 20_000);
const environment = {
  ...getDefaultEnvironment(),
  APPDATA: appData,
  CODEX_PROGRESS_HUD_PORT: String(port),
  CODEX_PROGRESS_HUD_URL: `http://127.0.0.1:${port}`,
  CODEX_PROGRESS_HUD_TOKEN_PATH: join(manifestDirectory, "auth.token")
};
const transport = new StdioClientTransport({
  command: resolve(root, "plugins/codex-progress-hud/scripts/codex-progress-hud-launcher.exe"),
  args: ["--mcp-stdio"],
  cwd: resolve(root, "plugins/codex-progress-hud"),
  env: environment,
  stderr: "inherit"
});
const client = new Client({ name: "packaged-mcp-diagnostic", version: packageManifest.version });
let opened = false;

function assertToolSuccess(result, name) {
  if (result.isError === true || result.structuredContent?.ok !== true) {
    throw new Error(`packaged ${name} failed: ${JSON.stringify(result.structuredContent ?? {})}`);
  }
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 14) throw new Error(`expected 14 MCP tools, received ${tools.tools.length}`);
  const openedResult = await client.callTool({ name: "hud_open", arguments: {} });
  assertToolSuccess(openedResult, "hud_open");
  if (openedResult.structuredContent?.observedState !== "running") {
    throw new Error(`installed launcher did not open a running HUD: ${JSON.stringify(openedResult.structuredContent ?? {})}`);
  }
  opened = true;
  const started = await client.callTool({
    name: "tracking_start",
    arguments: { title: "Packaged diagnostic" }
  });
  assertToolSuccess(started, "tracking_start");
  if (started.structuredContent?.associationSource !== "mcp_lease") {
    throw new Error("installed launcher tracking_start did not use the MCP lease association");
  }
  const reported = await client.callTool({
    name: "progress_report",
    arguments: { phase: "packaged diagnostic" }
  });
  assertToolSuccess(reported, "progress_report");
  if (reported.structuredContent?.associationSource !== "mcp_lease") {
    throw new Error("installed launcher progress_report did not use the MCP lease association");
  }
  process.stdout.write("Packaged MCP installed-launcher path, 14 tools, and handle-free reporting passed.\n");
} finally {
  if (opened) await client.callTool({ name: "hud_close", arguments: {} }).catch(() => undefined);
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await rm(appData, { recursive: true, force: true }).catch(() => undefined);
}
