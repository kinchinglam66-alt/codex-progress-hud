import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const expected = [
  ".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json",
  "scripts/codex-progress-hud-launcher.exe", "scripts/invoke-node-mode.ps1", "scripts/launch-hook.ps1", "scripts/launch-mcp.ps1",
  "README.md", "LICENSE", "NOTICE", "PRIVACY.md", "SECURITY.md"
].sort();

function centralDirectoryNames(zip: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 46 <= zip.length) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe("release plugin ZIP", () => {
  it("contains only the deterministic runtime whitelist", async () => {
    execFileSync(process.execPath, ["scripts/package-plugin.mjs"], { cwd: root, stdio: "pipe" });
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version: string };
    const zip = await readFile(resolve(root, `release/codex-progress-hud-plugin-${pkg.version}.zip`));
    const names = centralDirectoryNames(zip).sort();
    expect(names).toEqual(expected);
    expect(names.join("\n")).not.toMatch(/node_modules|\.git\/|\.token|\.map$|tests\/|skills\//iu);
  });
});
