import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];

async function writeFixture(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plugin package synchronization", () => {
  it("accepts equivalent CRLF PowerShell source and packaged scripts", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "codex-progress-hud-sync-"));
    temporaryRoots.push(fixtureRoot);
    await mkdir(resolve(fixtureRoot, "scripts"), { recursive: true });
    await cp(resolve(root, "scripts/sync-plugin-package.mjs"), resolve(fixtureRoot, "scripts/sync-plugin-package.mjs"));

    await writeFixture(resolve(fixtureRoot, "package.json"), '{"version":"0.2.0"}\n');
    await writeFixture(resolve(fixtureRoot, ".codex-plugin/plugin.json"), '{"name":"fixture"}\n');
    await writeFixture(resolve(fixtureRoot, "README.md"), "[Install on Windows](docs/INSTALL-WINDOWS.md)\n");

    const copiedFiles = [
      "hooks/hooks.json",
      "skills/progress-reporting/SKILL.md",
      "LICENSE",
      "NOTICE",
      "PRIVACY.md",
      "SECURITY.md"
    ];
    for (const relativePath of copiedFiles) {
      await writeFixture(resolve(fixtureRoot, relativePath), `fixture ${relativePath}\n`);
    }

    const powershellFiles = ["scripts/launch-hook.ps1", "scripts/launch-mcp.ps1", "scripts/invoke-node-mode.ps1"];
    for (const relativePath of powershellFiles) {
      await writeFixture(resolve(fixtureRoot, relativePath), "Write-Output 'fixture'\r\n");
    }

    execFileSync(process.execPath, ["scripts/sync-plugin-package.mjs"], { cwd: fixtureRoot, stdio: "pipe" });

    for (const relativePath of powershellFiles) {
      const packagedPath = resolve(fixtureRoot, "plugins/codex-progress-hud", relativePath);
      const content = await readFile(packagedPath, "utf8");
      await writeFile(packagedPath, content.replace(/\r?\n/gu, "\r\n"), "utf8");
    }

    expect(() => execFileSync(process.execPath, ["scripts/sync-plugin-package.mjs", "--check"], {
      cwd: fixtureRoot,
      stdio: "pipe"
    })).not.toThrow();
  });
});
