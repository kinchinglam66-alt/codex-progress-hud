# Windows Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified companion lifecycle into a Node-free Windows installation and a reproducible GitHub Release containing the installer, Codex plugin ZIP, and checksums.

**Architecture:** `electron-builder` packages the unified Electron entry as a per-user NSIS application. The Codex plugin uses a quiet PowerShell launcher to find the installer-written manifest and invoke the same executable in `--mcp-stdio` mode. Whitelist-based packaging scripts build the plugin ZIP and checksums, while Windows CI proves both executable modes before a tagged release is uploaded.

**Tech Stack:** Electron, electron-builder, NSIS, PowerShell 5.1+, Node.js build tooling, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-01-companion-lifecycle-release-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-09-01-companion-lifecycle.md` is complete, reviewed, and green.

## Global Constraints

- Release version is `0.2.0`; local Codex cachebusters are build metadata and do not alter release artifact names.
- Target Windows 10/11 x64 with a per-user install under `%LOCALAPPDATA%\\Programs\\Codex Progress HUD`.
- End users do not install Node.js and never run `npm start`.
- The installer does not request elevation and does not enable login startup by default.
- The plugin installer/launcher never writes Codex cache files or hand-edits marketplace configuration.
- No generated Electron binary is committed to Git.
- The MCP launcher writes protocol data only after the installed executable takes over stdout; all launcher failures go to stderr.
- The unsigned state is disclosed until a trusted certificate is configured.
- Preserve unrelated dirty working-tree changes and use the plugin-creator cachebuster/reinstall helpers.
- Windows launcher and packaged-executable tests use `describe.runIf(process.platform === "win32")`; platform-neutral suites continue to run on Ubuntu.

---

### Task 1: Reproducible Electron application packaging

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `electron-builder.yml`
- Modify: `.gitignore`
- Create: `tests/packaging/builder-config.test.ts`

**Interfaces:**
- Produces npm scripts `pack:win` and `dist:win`.
- Produces unpacked application under `release/win-unpacked/` and NSIS artifact `release/Codex-Progress-HUD-Setup-0.2.0.exe`.

- [ ] **Step 1: Write a failing builder-config contract test**

Parse `electron-builder.yml` and assert app ID, product name, x64 NSIS target, per-user mode, no elevation, no desktop shortcut, artifact name, asar use, and exact runtime file inclusions.

```ts
expect(config).toMatchObject({
  appId: "io.github.kinchinglam66alt.codex-progress-hud",
  productName: "Codex Progress HUD",
  asar: true,
  nsis: {
    perMachine: false,
    oneClick: false,
    allowElevation: false,
    createDesktopShortcut: false
  }
});
```

- [ ] **Step 2: Run the config test and confirm RED**

Run: `npm test -- --run tests/packaging/builder-config.test.ts`

Expected: FAIL because the builder config does not exist.

- [ ] **Step 3: Install and lock packaging dependencies**

Run: `npm install --save-dev electron-builder yaml archiver @types/archiver`

Expected: `package.json` and `package-lock.json` change; no global package is installed.

- [ ] **Step 4: Set the application release version without creating a tag**

Run: `npm version 0.2.0 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report version `0.2.0`.

- [ ] **Step 5: Add exact application packaging configuration**

```yaml
appId: io.github.kinchinglam66alt.codex-progress-hud
productName: Codex Progress HUD
asar: true
directories:
  output: release
files:
  - dist/**/*
  - package.json
  - LICENSE
  - NOTICE
win:
  target:
    - target: nsis
      arch: [x64]
  artifactName: Codex-Progress-HUD-Setup-${version}.${ext}
nsis:
  perMachine: false
  oneClick: false
  allowElevation: false
  createDesktopShortcut: false
  createStartMenuShortcut: true
  runAfterFinish: true
  include: build/installer.nsh
```

- [ ] **Step 6: Add scripts and ignore generated artifacts**

Set `"pack:win": "npm run build && electron-builder --win --x64 --dir"` and `"dist:win": "npm run build && electron-builder --win --x64"`. Ignore `release/` except no source fixture is placed beneath it.

- [ ] **Step 7: Run config test and unpacked build**

Run: `npm test -- --run tests/packaging/builder-config.test.ts`

Run: `npm run pack:win`

Expected: test PASS and `release/win-unpacked/Codex Progress HUD.exe` exists.

- [ ] **Step 8: Commit Task 1**

```powershell
git add package.json package-lock.json electron-builder.yml .gitignore tests/packaging/builder-config.test.ts
git commit -m "build: package the Windows companion"
```

### Task 2: Installer manifest and safe uninstall behavior

**Files:**
- Create: `build/installer.nsh`
- Create: `build/stop-companion.ps1`
- Create: `tests/packaging/installer-scripts.test.ts`
- Modify: `electron-builder.yml`

**Interfaces:**
- Produces `%APPDATA%\\codex-progress-hud\\install.json` during installation.
- Produces a silent authenticated shutdown helper used only by uninstallation.
- Offers an explicit retain/remove choice for user data.

- [ ] **Step 1: Write failing installer-script tests**

Assert the NSIS include writes `executablePath`, `installDirectory`, and `${VERSION}`, invokes the shutdown helper before removal, deletes `install.json`, and asks before recursively removing the data directory. Assert the PowerShell helper reads the token with `-LiteralPath`, posts only to `http://127.0.0.1:17837/api/shutdown`, and never prints the token.

```ts
expect(installer).toContain("!macro customInstall");
expect(installer).toContain("install.json");
expect(installer).toContain("!macro customUnInstall");
expect(shutdownScript).not.toContain("Write-Output $token");
```

- [ ] **Step 2: Run the installer tests and confirm RED**

Run: `npm test -- --run tests/packaging/installer-scripts.test.ts`

- [ ] **Step 3: Implement the shutdown helper**

```powershell
$ErrorActionPreference = "Stop"
$dataDir = Join-Path $env:APPDATA "codex-progress-hud"
$tokenPath = Join-Path $dataDir "auth.token"
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { exit 0 }
$token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
try {
  Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri "http://127.0.0.1:17837/api/shutdown" `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" -Body "{}" | Out-Null
} catch { exit 0 }
```

The helper treats an already stopped companion as success and writes no stdout.

- [ ] **Step 4: Implement NSIS install/uninstall macros**

`customInstall` creates the data directory and writes valid JSON using `$INSTDIR\\Codex Progress HUD.exe`. `customUnInstall` runs the shutdown helper, removes only `install.json` automatically, then asks whether settings, token, logs, and diagnostics should also be removed. It never deletes a parent directory or an unresolved path.

```nsis
!macro customInstall
  CreateDirectory "$APPDATA\codex-progress-hud"
  FileOpen $0 "$APPDATA\codex-progress-hud\install.json" w
  FileWrite $0 "{$\"executablePath$\":$\"$INSTDIR\\Codex Progress HUD.exe$\",$\"installDirectory$\":$\"$INSTDIR$\",$\"version$\":$\"${VERSION}$\"}"
  FileClose $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\stop-companion.ps1"'
  Delete "$APPDATA\codex-progress-hud\install.json"
  MessageBox MB_YESNO "Remove Codex Progress HUD preferences and diagnostics?" IDNO keepHudData
  RMDir /r "$APPDATA\codex-progress-hud"
  keepHudData:
!macroend
```

- [ ] **Step 5: Include the shutdown helper as an extra resource**

Add this exact builder fragment:

```yaml
extraResources:
  - from: build/stop-companion.ps1
    to: scripts/stop-companion.ps1
```

- [ ] **Step 6: Run tests and build the NSIS installer**

Run: `npm test -- --run tests/packaging/installer-scripts.test.ts`

Run: `npm run dist:win`

Expected: tests PASS and the versioned setup EXE exists.

- [ ] **Step 7: Commit Task 2**

```powershell
git add build electron-builder.yml tests/packaging/installer-scripts.test.ts
git commit -m "build: add safe per-user installer lifecycle"
```

### Task 3: Git marketplace plugin package and Node-free MCP launcher

**Files:**
- Create: `scripts/launch-mcp.ps1`
- Create: `scripts/sync-plugin-package.mjs`
- Create: `scripts/diagnose-packaged-mcp.mjs`
- Create: `.agents/plugins/marketplace.json`
- Create: `plugins/codex-progress-hud/.codex-plugin/plugin.json`
- Create: `plugins/codex-progress-hud/.mcp.json`
- Create: `plugins/codex-progress-hud/skills/progress-reporting/SKILL.md`
- Create: `plugins/codex-progress-hud/scripts/launch-mcp.ps1`
- Create: `plugins/codex-progress-hud/README.md`
- Create: `plugins/codex-progress-hud/LICENSE`
- Create: `plugins/codex-progress-hud/NOTICE`
- Create: `plugins/codex-progress-hud/PRIVACY.md`
- Create: `plugins/codex-progress-hud/SECURITY.md`
- Create: `tests/packaging/mcp-launcher.test.ts`
- Create: `tests/packaging/plugin-marketplace.test.ts`
- Modify: `scripts/validate-plugin.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces a PowerShell launcher that validates `install.json` and executes `Codex Progress HUD.exe --mcp-stdio`.
- Produces Git marketplace `kinchinglam66-alt` with plugin selector `codex-progress-hud@kinchinglam66-alt`.
- Keeps root `.mcp.json` as the cross-platform source-development configuration; the nested release plugin uses the launcher.

- [ ] **Step 1: Write failing marketplace, synchronization, and launcher tests**

Assert the marketplace has name `kinchinglam66-alt`, policy `AVAILABLE`/`ON_INSTALL`, category `Productivity`, and source path `./plugins/codex-progress-hud`. Assert `sync-plugin-package.mjs --check` detects drift. On Windows, use temporary APPDATA directories and a fake executable script to cover missing manifest, malformed manifest, path outside install directory, missing executable, successful argument forwarding, nonzero child exit propagation, and zero launcher stdout before child takeover.

```ts
expect(marketplace.plugins[0]).toMatchObject({
  name: "codex-progress-hud",
  source: { source: "local", path: "./plugins/codex-progress-hud" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity"
});
```

- [ ] **Step 2: Run launcher tests and confirm RED**

Run: `npm test -- --run tests/packaging/plugin-marketplace.test.ts tests/packaging/mcp-launcher.test.ts`

- [ ] **Step 3: Scaffold the repo marketplace with the plugin-creator helper**

Run:

```powershell
& '<bundled-python>' '<plugin-creator>/scripts/create_basic_plugin.py' codex-progress-hud --path '<repo>/plugins' --marketplace-path '<repo>/.agents/plugins/marketplace.json' --marketplace-name kinchinglam66-alt --with-skills --with-scripts --with-mcp --with-marketplace
```

Expected: the helper creates the nested plugin and marketplace without changing the existing personal marketplace.

- [ ] **Step 4: Implement the quiet launcher**

The launcher reads `%APPDATA%\\codex-progress-hud\\install.json`, resolves full paths, requires the executable to be a file inside the manifest's installation directory, writes one-line coded failures to `[Console]::Error`, and invokes:

```powershell
$manifestPath = Join-Path $env:APPDATA "codex-progress-hud\install.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  [Console]::Error.WriteLine("COMPANION_NOT_INSTALLED: Install Codex Progress HUD and retry.")
  exit 2
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$installDirectory = [IO.Path]::GetFullPath([string]$manifest.installDirectory)
$executablePath = [IO.Path]::GetFullPath([string]$manifest.executablePath)
$allowedPrefix = $installDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $executablePath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  [Console]::Error.WriteLine("INVALID_INSTALL_MANIFEST: Executable is outside the install directory.")
  exit 3
}
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
  [Console]::Error.WriteLine("COMPANION_EXECUTABLE_MISSING: Reinstall Codex Progress HUD.")
  exit 4
}
& '.\scripts\codex-progress-hud-launcher.exe' --mcp-stdio
exit $LASTEXITCODE
```

Use exit code 2 for `COMPANION_NOT_INSTALLED`, 3 for `INVALID_INSTALL_MANIFEST`, and 4 for `COMPANION_EXECUTABLE_MISSING`.

- [ ] **Step 5: Generate the nested release package from canonical files**

`sync-plugin-package.mjs` copies the canonical skill, launcher, README, LICENSE, NOTICE, PRIVACY, and SECURITY files; derives release plugin metadata from the root manifest but sets version from `package.json`; and writes this nested `.mcp.json` using Codex's documented direct server map and the native streaming bridge selected during implementation:

```json
{
  "codex-progress-hud": {
    "command": "./scripts/codex-progress-hud-launcher.exe",
    "args": ["--mcp-stdio"],
    "cwd": "."
  }
}
```

- [ ] **Step 6: Extend plugin and marketplace validation**

Require the nested launcher, reject a nested release `.mcp.json` command that invokes Node, verify its executable path is plugin-relative without `..`, validate the repo marketplace, and run synchronization in check mode. The root development `.mcp.json` remains valid with its Node command.

```js
if (releaseServer.command !== "./scripts/codex-progress-hud-launcher.exe") fail("release MCP must use native streaming launcher");
if (releaseServer.args.some((value) => value.includes(".."))) fail("release MCP path escapes plugin root");
if (marketplace.name !== "kinchinglam66-alt") fail("unexpected marketplace name");
```

- [ ] **Step 7: Add and run a packaged MCP diagnostic**

Add `"sync:plugin": "node scripts/sync-plugin-package.mjs"`, `"check:plugin-sync": "node scripts/sync-plugin-package.mjs --check"`, and `"diagnose:mcp:packaged": "node scripts/diagnose-packaged-mcp.mjs"`. On Windows, use temporary APPDATA pointing at `release/win-unpacked/Codex Progress HUD.exe` and launch the nested `.mcp.json`.

Run: `npm run sync:plugin`

Run: `npm test -- --run tests/packaging/plugin-marketplace.test.ts tests/packaging/mcp-launcher.test.ts`

Run: `npm run diagnose:mcp:packaged`

Expected: initialize and tools/list succeed with all thirteen tools.

- [ ] **Step 8: Commit Task 3**

```powershell
git add scripts/launch-mcp.ps1 scripts/sync-plugin-package.mjs scripts/diagnose-packaged-mcp.mjs .agents/plugins/marketplace.json plugins/codex-progress-hud tests/packaging/mcp-launcher.test.ts tests/packaging/plugin-marketplace.test.ts scripts/validate-plugin.mjs package.json
git commit -m "build: add Git marketplace release plugin"
```

### Task 4: Whitelist-based plugin ZIP and checksums

**Files:**
- Create: `scripts/package-plugin.mjs`
- Create: `scripts/write-checksums.mjs`
- Create: `tests/packaging/plugin-package.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `release/codex-progress-hud-plugin-0.2.0.zip`.
- Produces `release/SHA256SUMS.txt` covering the installer and plugin ZIP.

- [ ] **Step 1: Write a failing package-content test**

Assert the ZIP contains the whitelisted contents of `plugins/codex-progress-hud/`: `.codex-plugin/plugin.json`, `.mcp.json`, `skills/progress-reporting/SKILL.md`, `scripts/launch-mcp.ps1`, `README.md`, `LICENSE`, `NOTICE`, `PRIVACY.md`, and `SECURITY.md`; reject `node_modules`, source maps, tests, tokens, logs, and `.git` entries.

```ts
expect(entries.sort()).toEqual(expectedRuntimeEntries.sort());
expect(entries.some((name) => /node_modules|\.token|\.git\//.test(name))).toBe(false);
```

- [ ] **Step 2: Run the package test and confirm RED**

Run: `npm test -- --run tests/packaging/plugin-package.test.ts`

- [ ] **Step 3: Implement deterministic whitelist packaging**

Use `plugins/codex-progress-hud/` as the archive root. Use `archiver` with sorted file names, normalized `/` separators, and a fixed archive timestamp from `SOURCE_DATE_EPOCH` or `2026-09-01T00:00:00Z`. Fail if any required file is absent or `npm run check:plugin-sync` fails.

```js
for (const relativePath of runtimeFiles.toSorted()) {
  archive.file(resolve(pluginRoot, relativePath), {
    name: relativePath.replaceAll("\\", "/"),
    date: archiveDate
  });
}
await archive.finalize();
```

- [ ] **Step 4: Implement checksum generation**

Read only the two expected release artifacts, compute SHA-256 with `createHash("sha256")`, and write lines in lexicographic filename order using 64 lowercase hexadecimal characters, two spaces, and the exact filename.

```js
const digest = createHash("sha256").update(await readFile(path)).digest("hex");
lines.push(`${digest}  ${basename(path)}`);
```

- [ ] **Step 5: Add release scripts**

Set `"package:plugin": "node scripts/package-plugin.mjs"`, `"checksums": "node scripts/write-checksums.mjs"`, and `"release:artifacts": "npm run dist:win && npm run package:plugin && npm run checksums"`.

- [ ] **Step 6: Run packaging tests and create artifacts**

Run: `npm test -- --run tests/packaging/plugin-package.test.ts`

Run: `npm run release:artifacts`

Expected: installer, plugin ZIP, and checksums exist with exact 0.2.0 names.

- [ ] **Step 7: Commit Task 4**

```powershell
git add scripts/package-plugin.mjs scripts/write-checksums.mjs tests/packaging/plugin-package.test.ts package.json package-lock.json
git commit -m "build: create reproducible release artifacts"
```

### Task 5: Windows package smoke tests and CI release workflow

**Files:**
- Create: `scripts/smoke-packaged.mjs`
- Create: `tests/packaging/release-workflow.test.ts`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`

**Interfaces:**
- Produces npm script `smoke:packaged`.
- Produces a tag-gated release workflow for `v0.2.0`-style tags.

- [ ] **Step 1: Write a failing workflow contract test**

Parse both YAML files. Assert Windows CI runs the packaged smoke, release has `contents: write`, triggers only `v*` tags, verifies package version equals tag, uploads exactly three artifacts, and never publishes on pull requests.

```ts
expect(release.on.push.tags).toEqual(["v*"]);
expect(release.permissions.contents).toBe("write");
expect(JSON.stringify(release)).toContain("smoke:packaged");
```

- [ ] **Step 2: Run the workflow test and confirm RED**

Run: `npm test -- --run tests/packaging/release-workflow.test.ts`

- [ ] **Step 3: Implement packaged executable smoke**

Spawn `release/win-unpacked/Codex Progress HUD.exe --hud` with an isolated data directory and port, poll authenticated health, then launch the same EXE with `--mcp-stdio` through MCP SDK and call tools/list. Request authenticated shutdown in `finally`; terminate only the child created by the smoke test if graceful cleanup times out.

```js
const child = spawn(executable, ["--hud"], {
  env: { ...process.env, CODEX_PROGRESS_HUD_DATA_DIR: dataDir, CODEX_PROGRESS_HUD_PORT: String(port) },
  stdio: "ignore",
  shell: false
});
try {
  await waitForHealth(baseUrl, tokenPath);
  await verifyMcp(executable, dataDir);
} finally {
  await requestShutdown(baseUrl, tokenPath);
  await stopOwnedChildIfNeeded(child);
}
```

- [ ] **Step 4: Extend CI without weakening current Linux coverage**

Keep test/typecheck/build/plugin validation on Windows and Ubuntu. Add `pack:win` plus `smoke:packaged` only on Windows. Cache npm from `package-lock.json`.

```yaml
- if: runner.os == 'Windows'
  run: npm run pack:win
- if: runner.os == 'Windows'
  run: npm run smoke:packaged
```

- [ ] **Step 5: Add the tag release workflow**

The workflow checks out, sets up Node 22, runs `npm ci`, full verification, `npm run release:artifacts`, verifies checksums, and uploads the setup EXE, plugin ZIP, and checksum file with `softprops/action-gh-release@v2`.

```yaml
- uses: softprops/action-gh-release@v2
  with:
    files: |
      release/Codex-Progress-HUD-Setup-0.2.0.exe
      release/codex-progress-hud-plugin-0.2.0.zip
      release/SHA256SUMS.txt
```

- [ ] **Step 6: Run workflow tests and local packaged smoke**

Run: `npm test -- --run tests/packaging/release-workflow.test.ts`

Run: `npm run pack:win`

Run: `npm run smoke:packaged`

Expected: all commands exit 0 and no test-owned process remains.

- [ ] **Step 7: Commit Task 5**

```powershell
git add scripts/smoke-packaged.mjs tests/packaging/release-workflow.test.ts .github/workflows package.json
git commit -m "ci: verify and publish Windows release artifacts"
```

### Task 6: Release-grade installation and support documentation

**Files:**
- Modify: `README.md`
- Create: `docs/INSTALL-WINDOWS.md`
- Create: `docs/RELEASE-CHECKLIST.md`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Modify: `.codex-plugin/plugin.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces end-user contracts for install, first use, any-turn controls, update, disable, uninstall, diagnostics, privacy, and unsigned installer behavior.

- [ ] **Step 1: Synchronize 0.2.0 release metadata**

Verify `package.json` is already `0.2.0`; set the root and nested `.codex-plugin/plugin.json` base versions to `0.2.0`, then run `npm run sync:plugin`. Keep cachebuster build metadata only in temporary local test copies. Update plugin descriptions to mention the required Windows companion without claiming automatic installation.

- [ ] **Step 2: Write the exact Windows installation guide**

Document checksum verification with `Get-FileHash`, companion-first installation, `codex plugin marketplace add kinchinglam66-alt/codex-progress-hud --ref main`, `codex plugin add codex-progress-hud@kinchinglam66-alt`, one Codex restart, and natural-language examples for opening and tracking. State that no per-task activation phrase is required after loading.

- [ ] **Step 3: Document update, disable, and uninstall semantics**

Explain that disabling the plugin stops new MCP calls but does not silently kill an already running desktop process; `hud_close` or tray Exit stops it. Explain data-retention choice during uninstall and how to clear explicit-off state with `hud_open` or `tracking_start`.

- [ ] **Step 4: Document diagnostics and known limitations**

List every structured error code and safe next action, Windows x64 scope, PowerShell requirement, unsigned SmartScreen warning, full Codex restart after tool updates, and the diagnostic report's privacy exclusions.

- [ ] **Step 5: Update support and security forms**

Ask reporters for plugin/companion/protocol versions, desired/observed states, error code, and sanitized diagnostic attachment. Explicitly forbid tokens, prompts, source files, and unredacted logs.

- [ ] **Step 6: Write the release checklist**

Include clean-clone verification, version sync, tests, package builds, checksums, installer install/uninstall, manual lifecycle matrix, GitHub draft review, and post-release download verification with checkbox syntax.

- [ ] **Step 7: Run documentation and plugin validation**

Run: `npm run validate:plugin`

Run: `git diff --check`

Expected: both exit 0.

- [ ] **Step 8: Commit Task 6**

```powershell
git add README.md docs/INSTALL-WINDOWS.md docs/RELEASE-CHECKLIST.md PRIVACY.md SECURITY.md .github/ISSUE_TEMPLATE/bug_report.yml .codex-plugin/plugin.json plugins/codex-progress-hud package.json package-lock.json
git commit -m "docs: prepare the 0.2.0 Windows release"
```

### Task 7: Local plugin reinstall and end-to-end acceptance

**Files:**
- Modify only files required by verified defects.
- Evidence target: a sanitized diagnostic report outside tracked source, plus terminal command output retained in the Codex task.

**Interfaces:**
- Produces an installed release candidate and evidence for every manual acceptance item.

- [ ] **Step 1: Run the complete clean release gate**

Run: `npm ci`

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run validate:plugin`

Run: `npm run release:artifacts`

Run: `npm run smoke:packaged`

Run: `git diff --check`

Expected: every command exits 0.

- [ ] **Step 2: Install the generated setup EXE per user**

Before installation, resolve and stop only the known development companion. Install `release/Codex-Progress-HUD-Setup-0.2.0.exe`, then confirm `install.json` points inside `%LOCALAPPDATA%\\Programs\\Codex Progress HUD` and health is available after explicit launch.

- [ ] **Step 3: Install the repository marketplace and release plugin**

Run `codex plugin marketplace list`. If `kinchinglam66-alt` is absent, run `codex plugin marketplace add <checkout-path>`. Then run `codex plugin add codex-progress-hud@kinchinglam66-alt`. Do not hand-edit marketplace JSON or Codex config.

- [ ] **Step 4: Restart Codex and execute the manual lifecycle matrix**

Verify open, five tracking controls, report rendering, hide, show, close, observational status, suppressed background report, explicit tracking restart, test-owned crash recovery, diagnose, uninstall, reinstall, and a second smoke pass.

- [ ] **Step 5: Fix only reproduced defects with TDD and rerun the relevant gate**

For each defect, add the smallest failing automated test, confirm RED, implement the minimal correction, confirm GREEN, and rerun `npm run sync:plugin`. If Codex must reload the same semantic version during this local loop, use the plugin-creator cachebuster helper on `plugins/codex-progress-hud`, reinstall from `kinchinglam66-alt`, and restart Codex. Before release artifact generation, rerun synchronization to restore the canonical `0.2.0` version. Record the defect code and evidence in the current task; do not add raw task content to Git.

- [ ] **Step 6: Inspect repository and artifact hygiene**

Run: `git status --short`

Run: `git diff --check`

Run: `git ls-files | rg "(release/|node_modules/|auth\\.token|diagnostics/)"`

Expected: generated binaries, dependencies, tokens, and diagnostics are not tracked; only intentional source changes remain.

- [ ] **Step 7: Commit verified acceptance fixes**

Stage explicit fixed files only and use a defect-specific message, for example:

```powershell
git add tests/lifecycle/companion-manager.test.ts src/lifecycle/companion-manager.ts
git commit -m "fix: prevent HUD restart after explicit close"
```

Skip this commit when no acceptance defect required a source change.

### Task 8: GitHub Release publication

**Files:**
- No source edits unless release verification finds a documented defect.

**Interfaces:**
- Produces Git tag `v0.2.0` and a GitHub Release with three verified assets.

- [ ] **Step 1: Verify branch, remote, authentication, and clean release diff**

Run: `git remote -v`

Run: `gh auth status`

Run: `git status --short`

Expected: origin is `kinchinglam66-alt/codex-progress-hud`, GitHub authentication is valid, and all intended release changes are committed. Existing unrelated user changes must be resolved by their owner before tagging.

- [ ] **Step 2: Review generated checksums locally**

Run: `Get-FileHash -Algorithm SHA256 release\Codex-Progress-HUD-Setup-0.2.0.exe`

Run: `Get-FileHash -Algorithm SHA256 release\codex-progress-hud-plugin-0.2.0.zip`

Expected: values match `release/SHA256SUMS.txt` exactly.

- [ ] **Step 3: Create and push the signed-or-annotated release tag**

Run: `git tag -a v0.2.0 -m "Codex Progress HUD 0.2.0"`

Run: `git push origin main`

Run: `git push origin v0.2.0`

Expected: the release workflow starts from the tag. Do not recreate or force-move an existing tag.

- [ ] **Step 4: Wait for CI and inspect the published release**

Run: `gh run list --workflow release.yml --limit 1`

Run: `gh release view v0.2.0`

Expected: workflow success and exactly the setup EXE, plugin ZIP, and checksum file are attached.

- [ ] **Step 5: Download and verify public assets**

Download the three assets to a new temporary directory, verify checksums, and run the installer/plugin smoke from those downloaded files rather than the local build output.

- [ ] **Step 6: Record final evidence and outcome**

Report automated test counts, packaged smoke result, install/uninstall result, public checksum verification, release URL, unsigned/signed status, and any remaining non-blocking limitations. Do not claim release success until every item is directly observed.
