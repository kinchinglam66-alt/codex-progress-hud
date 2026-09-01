import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8")
);
const requiredStrings = ["name", "version", "description"];
for (const field of requiredStrings) {
  if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
    throw new Error(`plugin.json requires a non-empty ${field}`);
  }
}
if (manifest.name !== "codex-progress-hud") {
  throw new Error("plugin folder and manifest name must match");
}
if (manifest.mcpServers !== "./.mcp.json") {
  throw new Error("plugin.json must reference ./.mcp.json");
}

const mcpConfigPath = resolve(pluginRoot, manifest.mcpServers);
const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
const mcpServer = mcpConfig.mcpServers?.[manifest.name];
if (!mcpServer) {
  throw new Error(`.mcp.json must define mcpServers.${manifest.name}`);
}
if (mcpServer.cwd !== ".") {
  throw new Error(
    `.mcp.json must set mcpServers.${manifest.name}.cwd to "." so relative entry paths resolve from the plugin root`
  );
}
if (!Array.isArray(mcpServer.args) || typeof mcpServer.args[0] !== "string") {
  throw new Error(`.mcp.json must define an entry path in mcpServers.${manifest.name}.args`);
}

await access(resolve(pluginRoot, mcpServer.cwd, mcpServer.args[0]));
await access(resolve(pluginRoot, "skills/progress-reporting/SKILL.md"));
process.stdout.write("Plugin manifest and MCP launch configuration are valid.\n");
