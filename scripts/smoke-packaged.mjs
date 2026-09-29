import { exercisePassiveControls } from './passive-control-smoke.mjs';
import { assertHookProcess, assertStoppedTurn } from './hook-smoke-assertions.mjs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
// Exercise the artifact outside the repository tree. Otherwise Node can walk up
// from app.asar and resolve a missing production dependency from the checkout's
// node_modules, causing the packaged smoke test to pass while an installation
// fails at runtime.
const packageDirectory = await mkdtemp(join(tmpdir(), "hud-packaged-artifact-"));
const isolatedInstallDirectory = join(packageDirectory, "win-unpacked");
const sourceInstallDirectory = process.env.CODEX_PROGRESS_HUD_SMOKE_PACKAGE_DIR === undefined
  ? resolve(root, "release/win-unpacked")
  : resolve(process.env.CODEX_PROGRESS_HUD_SMOKE_PACKAGE_DIR);
await cp(sourceInstallDirectory, isolatedInstallDirectory, { recursive: true });
const executable = resolve(isolatedInstallDirectory, "Codex Progress HUD.exe");
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
  args: [resolve(isolatedInstallDirectory, "resources/app.asar/dist/main.js"), "--mcp-stdio"],
  cwd: dataDirectory,
  env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
  stderr: "pipe"
});
transport.stderr?.pipe(process.stderr);
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

async function syntheticHook(name, turn) {
  const result = spawnSync(executable,
    [join(installDirectory, "resources/app.asar/dist/main.js"), `--hook-event=${name}`], {
      cwd: dataDirectory, env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true, encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ session_id: "packaged-synthetic-session", turn_id: turn, hook_event_name: name })
    });
  assertHookProcess(result, name);
  return localSnapshot();
}

async function localSnapshot() {
  const token = (await readFile(tokenPath, "utf8")).trim();
  const response = await fetch(`${serviceUrl}/api/snapshot`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000)
  });
  if (!response.ok) throw new Error("packaged snapshot unavailable");
  return response.json();
}

await runPackagedCleanup({
  connect: () => client.connect(transport),
  open: async () => {

  const openedResult = await client.callTool({ name: "hud_open", arguments: {} });
  assertToolSuccess(openedResult, "hud_open");
  if (openedResult.structuredContent?.observedState !== "running") {
    throw new Error(`packaged hud_open did not observe running state: ${JSON.stringify(openedResult.structuredContent ?? {})}`);
  }
  },
  work: async (close) => {
  const health = await waitForAuthenticatedHealth();
  if (health.visibility !== "visible") throw new Error("packaged health was not visible");

  await exercisePassiveControls(client);

  const previousIds = new Set((await localSnapshot()).tasks.map(task => task.id));
  const firstTurn = await syntheticHook("UserPromptSubmit", "a");
  const turnA = firstTurn.selectedTaskId;
  if (!turnA || previousIds.has(turnA) || firstTurn.selected?.task.status !== "running") {
    throw new Error("packaged Hook did not start turn A");
  }
  assertStoppedTurn(await syntheticHook("Stop", "a"), turnA);
  const secondTurn = await syntheticHook("UserPromptSubmit", "b");
  const turnB = secondTurn.selectedTaskId;
  if (!turnB || turnB === turnA || secondTurn.selected?.task.status !== "running") {
    throw new Error("packaged Hook did not start a distinct running turn B");
  }
  const turns = await syntheticHook("Stop", "a");
  assertStoppedTurn(turns, turnA);
  if (turns.selectedTaskId !== turnB || turns.selected?.task.status !== "running") {
    throw new Error("packaged late Stop changed the current turn");
  }

    await close();
  },
  close: closeHud,
  emergencyClose: closeHud,
  release: closeMcp,
  cleanup: async () => {
    if (ownsDataDirectory) await removeTemporaryDirectory(dataDirectory);
    await removeTemporaryDirectory(packageDirectory);
  }
});

  process.stdout.write("Packaged MCP-first HUD, authenticated health, passive controls, restart, and synthetic two-turn Hook isolation passed.\n");
