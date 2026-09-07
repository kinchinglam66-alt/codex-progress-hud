import { exercisePassiveControls } from './passive-control-smoke.mjs';
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertHudCloseStopped,
  assertToolSuccess,
  removeTemporaryDirectory,
  runPackagedCleanup
} from "./packaged-cleanup.mjs";

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
  CODEX_PROGRESS_HUD_DATA_DIR: manifestDirectory,
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
  assertHudCloseStopped(closedResult, "installed launcher");
}

await runPackagedCleanup({
  connect: () => client.connect(transport),
  open: async () => {
  const openedResult = await client.callTool({ name: "hud_open", arguments: {} });
  assertToolSuccess(openedResult, "hud_open");
  if (openedResult.structuredContent?.observedState !== "running") {
    throw new Error(`installed launcher did not open a running HUD: ${JSON.stringify(openedResult.structuredContent ?? {})}`);
  }
  },
  work: async (close) => {
  const diagnosed = await client.callTool({ name: "hud_diagnose", arguments: {} });
  assertToolSuccess(diagnosed, "hud_diagnose");
  const diagnostic = diagnosed.structuredContent ?? {};
  const markdown = typeof diagnostic.reportPath === "string"
    ? await readFile(diagnostic.reportPath, "utf8")
    : diagnostic.reportMarkdown;
  if (typeof markdown !== "string" || !markdown.includes("trust not confirmed")) {
    throw new Error("packaged diagnostics did not preserve unknown Hook trust");
  }
  await exercisePassiveControls(client);

    await close();
  },
  close: closeHud,
  emergencyClose: closeHud,
  release: closeMcp,
  cleanup: () => removeTemporaryDirectory(appData)
});

  process.stdout.write("Packaged MCP installed-launcher path, passive controls, and handle-free restart passed.\n");
