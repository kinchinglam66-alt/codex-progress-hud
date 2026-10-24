import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "plugins/codex-progress-hud");
const checkOnly = process.argv.includes("--check");
const normalizeText = (content) => content.replace(/\r\n/gu, "\n").replace(/\n*$/u, "\n");
// These files are not copied into the plugin ZIP. Keep its documentation usable
// without assuming that the repository's docs directory exists beside it.
const pluginDocumentLinks = (content) => content.replace(
  /\]\(((?:docs\/|examples\/|research\/)[^)]+|README\.zh-CN\.md|CITATION\.cff|CONTRIBUTING\.md)\)/gu,
  "](https://github.com/kinchinglam66-alt/codex-progress-hud/blob/main/$1)"
);
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
  ["README.md", pluginDocumentLinks(await readFile(resolve(root, "README.md"), "utf8"))]
]);
const copies = new Map([
  ["hooks/hooks.json", "hooks/hooks.json"],
  ["scripts/launch-hook.ps1", "scripts/launch-hook.ps1"],
  ["scripts/launch-mcp.ps1", "scripts/launch-mcp.ps1"],
  ["scripts/invoke-node-mode.ps1", "scripts/invoke-node-mode.ps1"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["SECURITY.md", "SECURITY.md"]
]);

for (const [target, source] of copies) {
  const content = normalizeText(await readFile(resolve(root, source), "utf8"));
  generated.set(target, source.endsWith(".md") ? pluginDocumentLinks(content) : content);
}

const drift = [];
for (const [relativePath, content] of generated) {
  const target = resolve(outputRoot, relativePath);
  if (checkOnly) {
    const current = await readFile(target, "utf8").catch(() => undefined);
    if (current === undefined || normalizeText(current) !== normalizeText(content)) drift.push(relativePath);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

if (drift.length > 0) {
  throw new Error(`release plugin is out of sync: ${drift.join(", ")}`);
}
process.stdout.write(checkOnly ? "Release plugin is synchronized.\n" : "Release plugin synchronized.\n");
