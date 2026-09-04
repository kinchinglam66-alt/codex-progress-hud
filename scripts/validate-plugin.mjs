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
if (manifest.hooks !== undefined) {
  throw new Error("plugin.json must omit unsupported hooks metadata; hooks/hooks.json is convention-discovered");
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
const hooksConfigPath = resolve(pluginRoot, "hooks/hooks.json");
const hooksConfig = JSON.parse(await readFile(hooksConfigPath, "utf8"));
const supportedHookNames = [
  "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"
];
const registeredHookNames = Object.keys(hooksConfig.hooks ?? {});
if (registeredHookNames.includes("Interrupt")) {
  throw new Error("hooks.json must not register Interrupt");
}
if (registeredHookNames.sort().join("|") !== supportedHookNames.slice().sort().join("|")) {
  throw new Error("hooks.json must register exactly the supported Hook events");
}
for (const hookName of supportedHookNames) {
  const groups = hooksConfig.hooks[hookName];
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`hooks.json must define a matcher for ${hookName}`);
  }
  for (const group of groups) {
    if (typeof group.matcher !== "string" || group.matcher.trim() === "") {
      throw new Error(`hooks.json matcher is invalid for ${hookName}`);
    }
    if (!Array.isArray(group.hooks) || group.hooks.length !== 1) {
      throw new Error(`hooks.json must define one command for ${hookName}`);
    }
    const command = group.hooks[0];
    if (
      command?.type !== "command" ||
      typeof command.command !== "string" ||
      !command.command.includes("${PLUGIN_ROOT}") ||
      !command.command.includes("scripts/launch-hook.ps1") ||
      !command.command.includes(`-HookName ${hookName}`) ||
      !Number.isSafeInteger(command.timeout) ||
      command.timeout < 1 ||
      command.timeout > 3 ||
      command.async !== undefined
    ) {
      throw new Error(`hooks.json command is invalid for ${hookName}`);
    }
  }
}
if (hooksConfig.hooks.SessionStart[0].matcher !== "startup|resume|clear|compact") {
  throw new Error("SessionStart matcher must include all supported startup sources");
}
const hookLauncher = await readFile(resolve(pluginRoot, "scripts/launch-hook.ps1"), "utf8");
const launcherParameterBlock = hookLauncher.match(/param\s*\(([\s\S]*?)\)/iu)?.[1] ?? "";
if (
  /(?:^|\s)(?:node|npm)(?:\.exe)?(?:\s|$)/imu.test(hookLauncher) ||
  /executablepath/iu.test(launcherParameterBlock) ||
  /-ExecutablePath\b/iu.test(hookLauncher) ||
  !hookLauncher.includes("install.json") ||
  !hookLauncher.includes("executablePath") ||
  !hookLauncher.includes("Test-Path -LiteralPath") ||
  !hookLauncher.includes("--hook-event=")
) {
  throw new Error("Hook launcher must validate install.json and invoke the installed executable directly");
}
const releaseRoot = resolve(pluginRoot, "plugins/codex-progress-hud");
const releaseManifest = JSON.parse(await readFile(resolve(releaseRoot, ".codex-plugin/plugin.json"), "utf8"));
const releaseMcp = JSON.parse(await readFile(resolve(releaseRoot, ".mcp.json"), "utf8"));
const releaseServer = releaseMcp.mcpServers?.[manifest.name];
if (releaseManifest.name !== manifest.name || releaseManifest.version !== packageManifest.version) {
  throw new Error("release plugin identity must match the canonical package");
}
if (releaseServer?.command !== "./scripts/codex-progress-hud-launcher.exe" || releaseServer.cwd !== ".") {
  throw new Error("release MCP must use the native launcher from the plugin root");
}
if (!Array.isArray(releaseServer.args) || releaseServer.args.some((value) => typeof value !== "string" || value.includes("..")) || /\bnode(?:\.exe)?\b/iu.test(JSON.stringify(releaseServer))) {
  throw new Error("release MCP launcher must be plugin-relative and Node-free");
}
for (const relativePath of ["hooks/hooks.json", "scripts/codex-progress-hud-launcher.exe", "scripts/invoke-node-mode.ps1", "scripts/launch-hook.ps1", "scripts/launch-mcp.ps1", "skills/progress-reporting/SKILL.md"]) {
  await access(resolve(releaseRoot, relativePath));
}
const marketplace = JSON.parse(await readFile(resolve(pluginRoot, ".agents/plugins/marketplace.json"), "utf8"));
const marketplacePlugin = marketplace.plugins?.find((entry) => entry.name === manifest.name);
if (marketplace.name !== "kinchinglam66-alt" || marketplacePlugin?.source?.path !== "./plugins/codex-progress-hud") {
  throw new Error("repository marketplace does not expose the release plugin");
}
process.stdout.write("Plugin manifest, Hooks, marketplace, and MCP launch configurations are valid.\n");
