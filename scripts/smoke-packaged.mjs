import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "win32") {
  process.stdout.write("Packaged smoke is Windows-only; skipped.\n");
  process.exit(0);
}

const executable = resolve("release/win-unpacked/Codex Progress HUD.exe");
const requestedDataDirectory = process.env.CODEX_PROGRESS_HUD_SMOKE_DATA_DIR;
const dataDirectory = requestedDataDirectory === undefined
  ? await mkdtemp(join(tmpdir(), "hud-packaged-smoke-"))
  : resolve(requestedDataDirectory);
const ownsDataDirectory = requestedDataDirectory === undefined;
await mkdir(dataDirectory, { recursive: true });
const port = 20_000 + Math.floor(Math.random() * 20_000);
const serviceUrl = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  CODEX_PROGRESS_HUD_DATA_DIR: dataDirectory,
  CODEX_PROGRESS_HUD_PORT: String(port),
  CODEX_PROGRESS_HUD_URL: serviceUrl,
  CODEX_PROGRESS_HUD_TOKEN_PATH: join(dataDirectory, "auth.token")
};
const electronUserData = join(dataDirectory, "electron-user-data");
await mkdir(electronUserData, { recursive: true });
const hud = spawn(executable, ["--no-sandbox", "--disable-gpu", "--in-process-gpu", `--user-data-dir=${electronUserData}`, "--hud"], {
  cwd: dataDirectory,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  shell: false
});
const hudExited = new Promise((resolveExit) => hud.once("exit", resolveExit));
let startupOutput = "";
const retainStartupOutput = (chunk) => {
  startupOutput = `${startupOutput}${chunk.toString("utf8")}`.slice(-2_048);
};
hud.stdout.on("data", retainStartupOutput);
hud.stderr.on("data", retainStartupOutput);

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (hud.exitCode !== null) {
      throw new Error(`packaged HUD exited with ${hud.exitCode}: ${startupOutput.trim() || "no output"}`);
    }
    try {
      const token = (await readFile(environment.CODEX_PROGRESS_HUD_TOKEN_PATH, "utf8")).trim();
      const response = await fetch(`${serviceUrl}/api/health`, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return token;
    } catch { /* startup is still in progress */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`packaged HUD health did not become ready: ${startupOutput.trim() || "no output"}`);
}

let client;
let transport;
try {
  await waitForHealth();
  transport = new StdioClientTransport({
    command: executable,
    args: [resolve("release/win-unpacked/resources/app.asar/dist/main.js"), "--mcp-stdio"],
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stderr: "pipe"
  });
  client = new Client({ name: "packaged-release-smoke", version: "0.2.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 14) throw new Error(`expected 14 MCP tools, received ${tools.tools.length}`);
  const closed = await client.callTool({ name: "hud_close", arguments: {} });
  if (closed.isError === true || closed.structuredContent?.ok !== true) throw new Error("packaged hud_close failed");
  process.stdout.write("Packaged HUD and all 14 MCP tools passed.\n");
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (hud.exitCode === null) hud.kill();
  await Promise.race([
    hudExited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("packaged HUD did not exit within 5 seconds")), 5_000))
  ]);
  if (ownsDataDirectory) {
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
