import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expected = [
  ".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json",
  "skills/progress-reporting/SKILL.md", "scripts/codex-progress-hud-launcher.exe", "scripts/invoke-node-mode.ps1", "scripts/launch-hook.ps1", "scripts/launch-mcp.ps1",
  "README.md", "LICENSE", "NOTICE", "PRIVACY.md", "SECURITY.md"
].toSorted();
const stage = await mkdtemp(join(tmpdir(), "hud-package-contract-"));
try {
  for (const name of expected) {
    const content = await readFile(resolve(root, "plugins/codex-progress-hud", name));
    const target = resolve(stage, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  async function walk(path, prefix = "") {
    const output = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) output.push(...await walk(resolve(path, entry.name), name));
      else output.push(name);
    }
    return output;
  }
  const actual = (await walk(stage)).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("staged plugin tree differs from the release whitelist");
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(resolve(stage, ".codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(resolve(stage, ".mcp.json"), "utf8"));
  const hooks = JSON.parse(await readFile(resolve(stage, "hooks/hooks.json"), "utf8"));
  const capabilities = JSON.parse(await readFile(resolve(root, "config/release-capabilities.json"), "utf8"));
  const generated = await readFile(resolve(root, "dist/generated/capabilities.js"), "utf8");
  if (pkg.version !== plugin.version || !generated.includes(`\"buildVersion\": \"${pkg.version}\"`)) throw new Error("release versions are not synchronized");
  if (mcp.mcpServers?.[plugin.name]?.command !== "./scripts/codex-progress-hud-launcher.exe" || /\bnode(?:\.exe)?\b/iu.test(JSON.stringify(mcp))) throw new Error("release MCP path must use the Node-free native launcher");
  if (hooks.hooks?.Interrupt !== undefined || Object.keys(hooks.hooks ?? {}).length !== 5) throw new Error("release Hook set is invalid");
  if (!generated.includes(`\"current\": ${capabilities.protocol.current}`)) throw new Error("generated protocol is stale");
  for (const mode of ["--hud", "--mcp-stdio", "--hook-event=SessionStart"]) {
    const builtMain = await readFile(resolve(root, "dist/main.js"), "utf8");
    if (!builtMain.includes(mode.split("=")[0])) throw new Error(`built executable entry mode is missing: ${mode}`);
  }
  process.stdout.write("Release package contract is valid.\n");
} finally {
  await rm(stage, { recursive: true, force: true });
}
