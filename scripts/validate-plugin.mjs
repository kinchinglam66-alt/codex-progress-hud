import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8")
);
const packageManifest = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8"));
const capabilitySource = JSON.parse(
  await readFile(resolve(pluginRoot, "config/release-capabilities.json"), "utf8")
);
const generatedCapabilities = await readFile(
  resolve(pluginRoot, "src/generated/capabilities.ts"),
  "utf8"
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
if (typeof packageManifest.version !== "string" || manifest.version !== packageManifest.version) {
  throw new Error("package.json and plugin.json versions must match");
}
const generatedVersion = generatedCapabilities.match(/\"buildVersion\":\s+\"([^\"]+)\"/)?.[1];
if (generatedVersion !== packageManifest.version) {
  throw new Error("generated capability version must match package.json");
}
for (const field of ["current", "minimumClient", "maximumClient"]) {
  const value = capabilitySource.protocol?.[field];
  if (!Number.isSafeInteger(value)) throw new Error(`capability protocol ${field} must be a safe integer`);
  if (!generatedCapabilities.includes(`\"${field}\": ${value}`)) {
    throw new Error(`generated capability protocol ${field} must match authored capabilities`);
  }
}
if (
  capabilitySource.protocol.current < capabilitySource.protocol.minimumClient ||
  capabilitySource.protocol.current > capabilitySource.protocol.maximumClient
) {
  throw new Error("capability protocol current must be inside the accepted client range");
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
