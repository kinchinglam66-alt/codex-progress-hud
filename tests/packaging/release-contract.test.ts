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

  it('retains user data during upgrades and defaults explicit uninstall cleanup to No',async()=>{
    const installer=await text('build/installer.nsh');
    const uninstall=installer.split('!macro customUnInstall')[1]!.split('!macroend')[0]!;
    const guarded=uninstall.match(/\$\{ifNot\} \$\{isUpdated\}([\s\S]*?)\$\{endif\}/u)?.[1];
    expect(guarded).toContain('Delete "$PROFILE\\.codex-progress-hud\\install.json"');
    expect(guarded).toContain('RMDir /r "$PROFILE\\.codex-progress-hud"');
    expect(guarded).toContain('MB_DEFBUTTON2');
    expect(guarded).toContain('/SD IDNO IDNO keepUserData');
    expect(uninstall.replace(guarded!, '')).not.toMatch(/\b(?:RMDir|Delete|MessageBox)\b/u);
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
    expect(plugin.version).toBe("0.2.1");
    expect(plugin).not.toHaveProperty('skills');
    // The host validator requires a starter prompt; passive tracking still has no skill.
    const prompts = plugin.interface.defaultPrompt ?? plugin.interface.default_prompt;
    expect(typeof prompts === "string"
      ? prompts.trim().length > 0
      : Array.isArray(prompts) && prompts.length > 0 && prompts.every(prompt => typeof prompt === "string" && prompt.trim().length > 0)).toBe(true);
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
    expect(pkg.version).toBe("0.2.1");
    expect(pkg.dependencies["zod-to-json-schema"]).toBeTypeOf("string");
    for (const name of ["build:launcher", "pack:win", "dist:win", "sync:plugin", "check:plugin-sync", "package:plugin", "checksums", "test:package-contract", "verify:release"]) {
      expect(pkg.scripts[name]).toBeTypeOf("string");
    }
    const mcpMain = await text("src/mcp/main.ts");
    expect(mcpMain).toContain("RELEASE_CAPABILITIES.buildVersion");
    expect(mcpMain).not.toContain('const version = "0.1.0"');
  });

  it("requires MCP-first packaged smoke and handle-free installed diagnostics", async () => {
    const smoke = await text("scripts/smoke-packaged.mjs");
    const diagnostic = await text("scripts/diagnose-packaged-mcp.mjs");
    expect(smoke).toContain('readFile(resolve(root, "package.json"), "utf8")');
    expect(smoke).toContain('mkdtemp(join(tmpdir(), "hud-packaged-artifact-")');
    expect(smoke).toContain('cp(resolve(root, "release/win-unpacked"), isolatedInstallDirectory, { recursive: true })');
    expect(smoke).toContain('resolve(isolatedInstallDirectory, "resources/app.asar/dist/main.js")');
    expect(smoke).toContain("APPDATA: dataDirectory");
    expect(smoke).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(smoke).toContain('name: "hud_open"');
    expect(smoke).toContain("/api/health");
    expect(smoke).toContain('observedState !== "running"');
    // Control behavior is exercised over real stdio by the shared smoke scenario.
    expect(smoke).toContain('name: "hud_close"');
    expect(smoke).toContain('assertHudCloseStopped,');
    expect(smoke).toContain('assertToolSuccess,');
    expect(smoke).toContain("await runPackagedCleanup");
    expect(smoke).toContain("emergencyClose: closeHud");
    expect(smoke).not.toContain('"--hud"');
    expect(smoke).not.toContain("const hud = spawn");
    expect(diagnostic).toContain('readFile(resolve(root, "package.json"), "utf8")');
    expect(diagnostic).toContain("plugins/codex-progress-hud/scripts/codex-progress-hud-launcher.exe");
    expect(diagnostic).toContain('name: "hud_open"');
    expect(diagnostic).toContain('name: "hud_close"');
    expect(diagnostic).toContain('assertHudCloseStopped,');
    expect(diagnostic).toContain('assertToolSuccess,');
    expect(diagnostic).toContain("await runPackagedCleanup");
    expect(diagnostic).toContain("emergencyClose: closeHud");
    expect(diagnostic).not.toContain('version: "0.2.0"');
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
