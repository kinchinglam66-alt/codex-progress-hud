import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
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
await access(".mcp.json");
await access("skills/progress-reporting/SKILL.md");
process.stdout.write("Plugin manifest references valid local resources.\n");

