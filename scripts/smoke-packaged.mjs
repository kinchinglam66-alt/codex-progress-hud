import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertHudCloseStopped,
  assertToolSuccess,
  removeTemporaryDirectory,
  runPackagedCleanup
} from "./packaged-cleanup.mjs";

if (process.platform !== "win32") {
  process.stdout.write("Packaged smoke is Windows-only; skipped.\n");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const executable = resolve(root, "release/win-unpacked/Codex Progress HUD.exe");
const requestedDataDirectory = process.env.CODEX_PROGRESS_HUD_SMOKE_DATA_DIR;
const dataDirectory = requestedDataDirectory === undefined
  ? await mkdtemp(join(tmpdir(), "hud-packaged-smoke-"))
  : resolve(requestedDataDirectory);
const ownsDataDirectory = requestedDataDirectory === undefined;
await mkdir(dataDirectory, { recursive: true });
const installDirectory = dirname(executable);
await writeFile(
  join(dataDirectory, "install.json"),
  `${JSON.stringify({ executablePath: executable, installDirectory, version: packageManifest.version })}\n`,
  "utf8"
);
const port = 20_000 + Math.floor(Math.random() * 20_000);
const serviceUrl = `http://127.0.0.1:${port}`;
const tokenPath = join(dataDirectory, "auth.token");
const environment = {
  ...process.env,
  APPDATA: dataDirectory,
  CODEX_PROGRESS_HUD_DATA_DIR: dataDirectory,
  CODEX_PROGRESS_HUD_PORT: String(port),
  CODEX_PROGRESS_HUD_URL: serviceUrl,
  CODEX_PROGRESS_HUD_TOKEN_PATH: tokenPath
};
const transport = new StdioClientTransport({
  command: executable,
  args: [resolve(root, "release/win-unpacked/resources/app.asar/dist/main.js"), "--mcp-stdio"],
  cwd: dataDirectory,
  env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
  stderr: "pipe"
});
const client = new Client({ name: "packaged-release-smoke", version: packageManifest.version });

async function waitForAuthenticatedHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const token = (await readFile(tokenPath, "utf8")).trim();
      const response = await fetch(`${serviceUrl}/api/health`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const health = await response.json();
        if (health.visibility === "visible") return health;
      }
    } catch { /* startup is still in progress */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("packaged authenticated HUD health did not become visible");
}

async function closeMcp() {
  let firstError;
  try {
    await client.close();
  } catch (error) {
    firstError = error;
  }
  try {
    await transport.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

async function closeHud() {
  const closedResult = await client.callTool({ name: "hud_close", arguments: {} });
  assertHudCloseStopped(closedResult, "packaged");
}

await runPackagedCleanup({
  connect: () => client.connect(transport),
  open: async () => {
  const tools = await client.listTools();
  if (tools.tools.length !== 14) throw new Error(`expected 14 MCP tools, received ${tools.tools.length}`);

  const openedResult = await client.callTool({ name: "hud_open", arguments: {} });
  assertToolSuccess(openedResult, "hud_open");
  if (openedResult.structuredContent?.observedState !== "running") {
    throw new Error(`packaged hud_open did not observe running state: ${JSON.stringify(openedResult.structuredContent ?? {})}`);
  }
  },
  work: async (close) => {
  const health = await waitForAuthenticatedHealth();
  if (health.visibility !== "visible") throw new Error("packaged health was not visible");

  const started = await client.callTool({
    name: "tracking_start",
    arguments: { title: "Packaged smoke" }
  });
  assertToolSuccess(started, "tracking_start");
  if (started.structuredContent?.associationSource !== "mcp_lease") {
    throw new Error("packaged tracking_start did not use the MCP lease association");
  }
  const reported = await client.callTool({
    name: "progress_report",
    arguments: { phase: "packaged smoke" }
  });
  assertToolSuccess(reported, "progress_report");
  if (reported.structuredContent?.associationSource !== "mcp_lease") {
    throw new Error("packaged progress_report did not use the MCP lease association");
  }

    await close();
  },
  close: closeHud,
  emergencyClose: closeHud,
  release: closeMcp,
  cleanup: async () => {
    if (ownsDataDirectory) await removeTemporaryDirectory(dataDirectory);
  }
});

  process.stdout.write("Packaged MCP-first HUD, authenticated health, 14 tools, and handle-free reporting passed.\n");
