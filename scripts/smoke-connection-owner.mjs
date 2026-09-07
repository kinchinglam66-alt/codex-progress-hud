import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { removeTemporaryDirectory } from "./packaged-cleanup.mjs";

if (process.platform !== "win32") throw new Error("Windows-only acceptance");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "hud-connection-owner-"));
const executable = resolve(root, "release/win-unpacked/Codex Progress HUD.exe");
await writeFile(join(directory, "install.json"), JSON.stringify({
  executablePath: executable, installDirectory: dirname(executable), version: "0.2.1"
}));
// Model an upgrade, not only a fresh install. Never use production state.
await writeFile(join(directory, "runtime.json"), JSON.stringify({
  pid: 2147483647, version: "0.2.1", protocolVersion: 1,
  instanceNonce: "synthetic-prior-install", startedAt: "2026-09-05T06:26:22.199Z"
}));
const port = 20000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const tokenPath = join(directory, "auth.token");
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1", APPDATA: directory,
  CODEX_PROGRESS_HUD_DATA_DIR: directory, CODEX_PROGRESS_HUD_TOKEN_PATH: tokenPath,
  CODEX_PROGRESS_HUD_PORT: String(port), CODEX_PROGRESS_HUD_URL: url };
const clients = [];
async function connect() {
  const transport = new StdioClientTransport({ command: executable,
    args: [join(dirname(executable), "resources/app.asar/dist/main.js"), "--mcp-stdio"],
    cwd: directory, env: environment, stderr: "inherit" });
  const client = new Client({ name: "isolated-owner-acceptance", version: "0.1.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}
async function snapshot() {
  const token = (await readFile(tokenPath, "utf8")).trim();
  const response = await fetch(`${url}/api/snapshot`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000)
  });
  if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
  return response.json();
}
async function ownsLease(client) {
  const result = await client.callTool({ name: "hud_diagnose", arguments: {} });
  if (result.isError || !result.structuredContent?.ok) return false;
  const report = result.structuredContent;
  const markdown = typeof report.reportPath === "string"
    ? await readFile(report.reportPath, "utf8") : report.reportMarkdown;
  return typeof markdown === "string" && markdown.includes("MCP lease: connected (1)");
}
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("connection owner acceptance deadline exceeded");
}
let passed = false;
try {
  const first = await connect();
  const second = await connect();
  await until(async () => {
    try { return await ownsLease(first) && await ownsLease(second); }
    catch { return false; }
  });
  if ((await snapshot()).tasks.length !== 0) throw new Error("initialization created a task");
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  console.log("Two initialized owners, no task tool calls, zero tasks: passed.");
  await new Promise(r => setTimeout(r, 50000));
  const alive = await snapshot();
  if (!await ownsLease(first) || !await ownsLease(second) || alive.tasks.length !== 0) throw new Error("idle ownership was lost");
  console.log("Both owners survive beyond 45-second grace: passed.");
  await first.close();
  await until(async () => await ownsLease(second));
  await snapshot();
  console.log("Closing one owner preserves the other: passed.");
  await second.close();
  // Prove the listener was reachable when the final owner disconnected.
  // The 60-second limit is shorter than renewal expiry plus shutdown grace.
  await snapshot();
  await until(async () => {
    try { await snapshot(); return false; }
    catch (error) { return error?.cause?.code === "ECONNREFUSED"; }
  }, 60000);
  await until(async () => {
    try { process.kill(runtime.pid, 0); return false; }
    catch (error) { if (error?.code === "ESRCH") return true; throw error; }
  }, 15000);
  passed = true;
  console.log("Final disconnect automatically shuts down the companion: passed.");
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  // On failure keep the isolated fixture for diagnosis instead of deleting
  // state that might still belong to a running test companion.
  if (passed) await until(async () => {
    try { await removeTemporaryDirectory(directory); return true; }
    catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      return false;
    }
  }, 15000);
}
