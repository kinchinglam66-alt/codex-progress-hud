import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const text = (path: string) => readFile(resolve(root, path), "utf8");

describe("Windows release source contract", () => {
  it("declares a per-user unsigned x64 application package", async () => {
    const config = await text("electron-builder.yml");
    expect(config).toContain("appId: io.github.kinchinglam66alt.codex-progress-hud");
    expect(config).toContain("productName: Codex Progress HUD");
    expect(config).toContain("target: nsis");
    expect(config).toContain("perMachine: false");
    expect(config).toContain("allowElevation: false");
    expect(config).toContain("createDesktopShortcut: false");
    expect(config).toContain("Codex-Progress-HUD-Setup-${version}.${ext}");
  });

  it("writes and removes only the validated installer manifest automatically", async () => {
    const installer = await text("build/installer.nsh");
    const shutdown = await text("build/stop-companion.ps1");
    expect(installer).toContain("!macro customInstall");
    expect(installer).toContain("executablePath");
    expect(installer).toContain("installDirectory");
    expect(installer).toContain("${StrRep}");
    expect(installer).toContain("!ifndef BUILD_UNINSTALLER");
    expect(installer).toContain('${StrRep} $1 "$INSTDIR" "\\" "\\\\"');
    expect(installer).toContain("!macro customUnInstall");
    expect(installer).toContain("install.json");
    expect(shutdown).toContain("Test-Path -LiteralPath");
    expect(shutdown).toContain("http://127.0.0.1:17837/api/shutdown");
    expect(shutdown).not.toMatch(/Write-(?:Output|Host).*token/iu);
  });

  it("contains the release marketplace, plugin mirror, and both Node-free launchers", async () => {
    const marketplace = JSON.parse(await text(".agents/plugins/marketplace.json"));
    expect(marketplace.name).toBe("kinchinglam66-alt");
    expect(marketplace.plugins[0]).toMatchObject({
      name: "codex-progress-hud",
      source: { source: "local", path: "./plugins/codex-progress-hud" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity"
    });
    const mcp = JSON.parse(await text("plugins/codex-progress-hud/.mcp.json"));
    const rootMcp = JSON.parse(await text(".mcp.json"));
    const plugin = JSON.parse(await text("plugins/codex-progress-hud/.codex-plugin/plugin.json"));
    expect(plugin).not.toHaveProperty("hooks");
    expect(Object.keys(rootMcp)).toEqual(["mcpServers"]);
    expect(Object.keys(mcp)).toEqual(["mcpServers"]);
    expect(mcp.mcpServers["codex-progress-hud"].command).toBe("./scripts/codex-progress-hud-launcher.exe");
    expect(mcp).not.toHaveProperty("codex-progress-hud");
    expect(JSON.stringify(mcp)).not.toMatch(/\bnode(?:\.exe)?\b/iu);
    await access(resolve(root, "plugins/codex-progress-hud/scripts/launch-mcp.ps1"));
    await access(resolve(root, "plugins/codex-progress-hud/scripts/launch-hook.ps1"));
    await access(resolve(root, "plugins/codex-progress-hud/scripts/invoke-node-mode.ps1"));
    await access(resolve(root, "plugins/codex-progress-hud/scripts/codex-progress-hud-launcher.exe"));
    await access(resolve(root, "plugins/codex-progress-hud/hooks/hooks.json"));
    for (const name of ["scripts/launch-mcp.ps1", "scripts/launch-hook.ps1"]) {
      const launcher = await text(name);
      expect(launcher).toContain("resources\\app.asar\\dist\\main.js");
      expect(launcher).toContain("invoke-node-mode.ps1");
    }
    expect(await text("scripts/invoke-node-mode.ps1")).toContain('start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"');
    expect(await text("build/native-launcher.cs")).toContain('start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"');
  });

  it("exposes reproducible package and release verification scripts", async () => {
    const pkg = JSON.parse(await text("package.json"));
    expect(pkg.version).toBe("0.2.0");
    for (const name of ["build:launcher", "pack:win", "dist:win", "sync:plugin", "check:plugin-sync", "package:plugin", "checksums", "test:package-contract", "verify:release"]) {
      expect(pkg.scripts[name]).toBeTypeOf("string");
    }
    const mcpMain = await text("src/mcp/main.ts");
    const hookClient = await text("src/hooks/client.ts");
    expect(mcpMain).toContain("RELEASE_CAPABILITIES.buildVersion");
    expect(mcpMain).not.toContain('const version = "0.1.0"');
    expect(hookClient).toContain("RELEASE_CAPABILITIES.buildVersion");
    expect(hookClient).not.toContain('const version = "0.1.0"');
  });

  it("keeps packaged smoke on Windows CI and publication tag-gated", async () => {
    const ci = await text(".github/workflows/ci.yml");
    const release = await text(".github/workflows/release.yml");
    expect(ci).toContain("runner.os == 'Windows'");
    expect(ci).toContain("npm run smoke:packaged");
    expect(release).toContain('tags: ["v*"]');
    expect(release).toContain("contents: write");
    expect(release).toContain("npm run verify:release");
    expect(ci).not.toMatch(/uses:\s+[^\s]+@v\d+/u);
    expect(release).not.toMatch(/uses:\s+[^\s]+@v\d+/u);
    expect(release).toContain("softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228");
    expect(release).toContain("npm ci --registry=https://registry.npmjs.org");
    expect(release).toContain("steps.artifacts.outputs.installer");
    expect(release).toContain("steps.artifacts.outputs.plugin");
    expect(release).not.toContain("Codex-Progress-HUD-Setup-0.2.0.exe");
    expect(release).not.toContain("codex-progress-hud-plugin-0.2.0.zip");
    expect(release).toContain("SHA256SUMS.txt");
  });

  it("rebuilds the native launcher from reviewed source for releases", async () => {
    const pkg = JSON.parse(await text("package.json"));
    const builder = await text("scripts/build-native-launcher.mjs");
    expect(pkg.scripts["build:launcher:release"]).toContain("--force");
    expect(pkg.scripts["release:artifacts"]).toContain("build:launcher:release");
    expect(builder).toContain("native-launcher.binary.sha256");
  });
});
