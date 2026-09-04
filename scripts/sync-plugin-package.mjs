import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "plugins/codex-progress-hud");
const checkOnly = process.argv.includes("--check");
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const rootPlugin = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
const releasePlugin = { ...rootPlugin, version: packageManifest.version };
const releaseMcp = {
  mcpServers: {
    "codex-progress-hud": {
      command: "./scripts/codex-progress-hud-launcher.exe",
      args: ["--mcp-stdio"],
      cwd: "."
    }
  }
};

const generated = new Map([
  [".codex-plugin/plugin.json", `${JSON.stringify(releasePlugin, null, 2)}\n`],
  [".mcp.json", `${JSON.stringify(releaseMcp, null, 2)}\n`],
  ["README.md", (await readFile(resolve(root, "README.md"), "utf8")).replace(
    "[Install on Windows](docs/INSTALL-WINDOWS.md)",
    "[Install on Windows](https://github.com/kinchinglam66-alt/codex-progress-hud/blob/main/docs/INSTALL-WINDOWS.md)"
  )]
]);
const copies = new Map([
  ["hooks/hooks.json", "hooks/hooks.json"],
  ["skills/progress-reporting/SKILL.md", "skills/progress-reporting/SKILL.md"],
  ["scripts/launch-hook.ps1", "scripts/launch-hook.ps1"],
  ["scripts/launch-mcp.ps1", "scripts/launch-mcp.ps1"],
  ["scripts/invoke-node-mode.ps1", "scripts/invoke-node-mode.ps1"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["SECURITY.md", "SECURITY.md"]
]);

for (const [target, source] of copies) {
  generated.set(target, (await readFile(resolve(root, source), "utf8")).replace(/(?:\r?\n)*$/u, "\n"));
}

const drift = [];
for (const [relativePath, content] of generated) {
  const target = resolve(outputRoot, relativePath);
  if (checkOnly) {
    const current = await readFile(target, "utf8").catch(() => undefined);
    if (current !== content) drift.push(relativePath);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

if (drift.length > 0) {
  throw new Error(`release plugin is out of sync: ${drift.join(", ")}`);
}
process.stdout.write(checkOnly ? "Release plugin is synchronized.\n" : "Release plugin synchronized.\n");
