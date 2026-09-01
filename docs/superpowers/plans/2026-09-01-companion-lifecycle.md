# Companion Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Progress HUD start, show, hide, close, diagnose, and recover its local Electron companion predictably while preserving explicit user shutdown.

**Architecture:** A pure lifecycle state layer persists user intent and classifies observations. A `CompanionManager` in MCP mode coordinates a versioned loopback control protocol and an injected process launcher, while Electron GUI mode owns the window, tray, single-instance lock, and HTTP service. The same Electron entry supports `--hud` and `--mcp-stdio` so the packaged release cannot drift between MCP and companion versions.

**Tech Stack:** Node.js 22 development runtime, TypeScript, Electron, Vitest, MCP TypeScript SDK, Zod, native HTTP/SSE

**Spec:** `docs/superpowers/specs/2026-09-01-companion-lifecycle-release-design.md`

## Global Constraints

- Target Windows 10/11 x64 for release while keeping pure core tests portable.
- Protocol version is exactly `1` for this release.
- Preserve the existing eight MCP tools and all current task-event schemas.
- `tracking_stop` never closes the companion.
- `hud_status` and `tracking_status` never start a process.
- Explicit `hud_close` or tray Exit persists `desiredState: "off"`; only `hud_open` or `tracking_start` clears it explicitly.
- A first report may auto-start only when no explicit off preference exists.
- Automatic recovery is one attempt per write and must be rate-limited.
- Bind only to loopback, authenticate every `/api/` route, never kill an unknown process, and never log task payloads or secrets.
- Use TDD for every behavioral change and commit only the files named by the current task.
- Preserve unrelated dirty working-tree changes; never reset or overwrite them.

---

### Task 0: Preserve and checkpoint the already verified bug-fix baseline

**Files:**
- Existing modified files only: `.github/ISSUE_TEMPLATE/bug_report.yml`, `.mcp.json`, `README.md`, `package.json`, `scripts/validate-plugin.mjs`, `skills/progress-reporting/SKILL.md`, `src/core/eta.ts`, `src/core/reducer.ts`, `src/core/schema.ts`, `src/core/types.ts`, `src/mcp/main.ts`, `src/mcp/report-client.ts`, `src/mcp/tools.ts`, `src/ui/view-model.ts`, `tests/core/eta.test.ts`, `tests/core/reducer.test.ts`, `tests/mcp/tools.test.ts`, `tests/mcp/stdio-server.test.ts`, and `tests/ui/view-model.test.ts`.

**Interfaces:**
- Produces a clean historical checkpoint for the current five tracking controls, MCP working-directory fix, cache compatibility diagnostics, and their 48-test baseline.

- [ ] **Step 1: Review every existing dirty diff before staging**

Run: `git diff -- .github/ISSUE_TEMPLATE/bug_report.yml .mcp.json README.md package.json scripts/validate-plugin.mjs skills/progress-reporting/SKILL.md src tests`

Expected: changes correspond only to the already implemented tracking controls, ETA/state support, MCP cwd fix, validation, and tests. Stop if an unrelated user edit is present.

- [ ] **Step 2: Re-run the verified baseline**

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run validate:plugin`

Run: `npm run diagnose:mcp`

Expected: all commands exit 0 and the test suite reports 48 passing tests before lifecycle work begins.

- [ ] **Step 3: Commit the baseline files explicitly**

```powershell
git add .github/ISSUE_TEMPLATE/bug_report.yml .mcp.json README.md package.json scripts/validate-plugin.mjs skills/progress-reporting/SKILL.md src/core/eta.ts src/core/reducer.ts src/core/schema.ts src/core/types.ts src/mcp/main.ts src/mcp/report-client.ts src/mcp/tools.ts src/ui/view-model.ts tests/core/eta.test.ts tests/core/reducer.test.ts tests/mcp/tools.test.ts tests/mcp/stdio-server.test.ts tests/ui/view-model.test.ts
git commit -m "fix: restore reliable MCP tracking controls"
```

- [ ] **Step 4: Confirm only intentional non-baseline files remain dirty**

Run: `git status --short`

Expected: no product-code change from the baseline remains unstaged or uncommitted.

### Task 1: Persistent lifecycle state and deterministic classification

**Files:**
- Create: `src/lifecycle/types.ts`
- Create: `src/lifecycle/state-store.ts`
- Create: `src/lifecycle/classify.ts`
- Modify: `src/server/paths.ts`
- Test: `tests/lifecycle/state-store.test.ts`
- Test: `tests/lifecycle/classify.test.ts`

**Interfaces:**
- Produces: `PROTOCOL_VERSION`, `HudSettings`, `RuntimeIdentity`, `InstallManifest`, `HudHealth`, `HudLifecycleSnapshot`, and `HudErrorCode`.
- Produces: `createLifecycleStateStore(paths): LifecycleStateStore` with `readSettings`, `setDesiredState`, `writeRuntime`, `readRuntime`, `clearRuntime`, and `readInstallManifest`.
- Produces: `classifyLifecycle(input): ObservedHudState`.

- [ ] **Step 1: Write failing state-store tests**

Cover missing-file defaults, atomic desired-state persistence, valid runtime/install parsing, malformed JSON rejection without exposing file content, and runtime clearing.

```ts
it("persists explicit off without inventing other settings", async () => {
  const store = createLifecycleStateStore(testPaths);
  await store.setDesiredState("off");
  expect(await store.readSettings()).toEqual({
    desiredState: "off",
    startWithWindows: false
  });
});
```

- [ ] **Step 2: Run the state-store test and confirm RED**

Run: `npm test -- --run tests/lifecycle/state-store.test.ts`

Expected: FAIL because `src/lifecycle/state-store.ts` does not exist.

- [ ] **Step 3: Define the exact lifecycle contracts**

```ts
export const PROTOCOL_VERSION = 1 as const;
export type DesiredHudState = "on" | "off";
export type ObservedHudState =
  | "starting" | "running" | "hidden" | "stopped"
  | "crashed" | "incompatible" | "port_conflict";

export interface HudSettings {
  desiredState?: DesiredHudState;
  startWithWindows: boolean;
}

export interface RuntimeIdentity {
  pid: number;
  version: string;
  protocolVersion: number;
  instanceNonce: string;
  startedAt: string;
}

export interface InstallManifest {
  executablePath: string;
  installDirectory: string;
  version: string;
}

export interface HudHealth extends RuntimeIdentity {
  service: "codex-progress-hud";
  protocolVersion: 1;
  visibility: "visible" | "hidden";
}

export type HudErrorCode =
  | "COMPANION_NOT_INSTALLED" | "MANUALLY_DISABLED" | "PORT_CONFLICT"
  | "VERSION_MISMATCH" | "START_TIMEOUT" | "AUTH_ERROR"
  | "SHUTDOWN_TIMEOUT" | "COMPANION_CRASHED" | "INTERNAL_ERROR";

export interface HudLifecycleSnapshot {
  desiredState?: DesiredHudState;
  observedState: ObservedHudState;
  health?: HudHealth;
  code?: HudErrorCode;
}

export type EnsureResult =
  | { kind: "ready"; snapshot: HudLifecycleSnapshot }
  | { kind: "suppressed"; code: "MANUALLY_DISABLED" }
  | { kind: "error"; code: HudErrorCode; snapshot: HudLifecycleSnapshot };

export interface DiagnosticReport { path: string; }

export interface LifecycleObservation {
  desiredState?: DesiredHudState;
  starting: boolean;
  identity?: { service: string; protocolVersion: number };
  health?: HudHealth;
  hadHealthyRuntime: boolean;
}
```

Define `LifecycleStateStore` exactly as:

```ts
export interface LifecycleStateStore {
  readSettings(): Promise<HudSettings>;
  setDesiredState(state: DesiredHudState): Promise<HudSettings>;
  writeRuntime(identity: RuntimeIdentity): Promise<void>;
  readRuntime(): Promise<RuntimeIdentity | null>;
  clearRuntime(): Promise<void>;
  readInstallManifest(): Promise<InstallManifest | null>;
}
```

- [ ] **Step 4: Implement state paths and atomic JSON persistence**

Add `defaultSettingsPath`, `defaultRuntimePath`, `defaultInstallManifestPath`, `defaultLogDirectory`, and `defaultDiagnosticsDirectory` under the existing data directory. Validate JSON with Zod, write to a sibling temporary file, and rename into place. Never include malformed file contents in thrown errors.

```ts
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
```

- [ ] **Step 5: Run state-store tests to GREEN**

Run: `npm test -- --run tests/lifecycle/state-store.test.ts`

Expected: all state-store tests PASS.

- [ ] **Step 6: Write failing lifecycle-classification tests**

```ts
it.each([
  [{ desiredState: "off", health: null, hadHealthyRuntime: true }, "stopped"],
  [{ desiredState: "on", health: compatibleHealth, hadHealthyRuntime: true }, "running"],
  [{ desiredState: "on", health: null, hadHealthyRuntime: true }, "crashed"],
  [{ desiredState: "on", identity: { service: "other", protocolVersion: 1 } }, "port_conflict"]
])("classifies %o as %s", (input, expected) => {
  expect(classifyLifecycle(input)).toBe(expected);
});
```

- [ ] **Step 7: Implement classification precedence and run tests**

```ts
export function classifyLifecycle(input: LifecycleObservation): ObservedHudState {
  if (input.desiredState === "off") return "stopped";
  if (input.starting) return "starting";
  if (input.identity?.service !== undefined && input.identity.service !== "codex-progress-hud") return "port_conflict";
  if (input.identity?.protocolVersion !== undefined && input.identity.protocolVersion !== PROTOCOL_VERSION) return "incompatible";
  if (input.health !== undefined) return input.health.visibility === "visible" ? "running" : "hidden";
  return input.hadHealthyRuntime ? "crashed" : "stopped";
}
```

Run: `npm test -- --run tests/lifecycle`

Expected: all lifecycle tests PASS.

- [ ] **Step 8: Commit Task 1**

```powershell
git add src/lifecycle src/server/paths.ts tests/lifecycle
git commit -m "feat: add persistent HUD lifecycle state"
```

### Task 2: Versioned authenticated control protocol

**Files:**
- Modify: `src/server/http-server.ts`
- Test: `tests/server/http-server.test.ts`

**Interfaces:**
- Consumes: `HudHealth` from Task 1.
- Changes: `ProgressServerOptions` gains `health`, `showWindow`, `hideWindow`, and `requestShutdown` callbacks.
- Produces: `GET /health`, `GET /api/health`, `POST /api/window/show`, `POST /api/window/hide`, and `POST /api/shutdown`.

- [ ] **Step 1: Write failing HTTP control tests**

```ts
it("exposes only minimal unauthenticated identity", async () => {
  const response = await fetch(`${baseUrl}/health`);
  expect(await response.json()).toEqual({
    service: "codex-progress-hud",
    protocolVersion: 1
  });
});

it("authenticates and dispatches window control", async () => {
  const response = await fetch(`${baseUrl}/api/window/hide`, {
    method: "POST",
    headers,
    body: "{}"
  });
  expect(response.status).toBe(202);
  expect(hideWindow).toHaveBeenCalledOnce();
});
```

Also test unauthenticated rejection, non-JSON rejection, idempotent callbacks, full authenticated health, and shutdown acknowledgement.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- --run tests/server/http-server.test.ts`

Expected: new routes return 404.

- [ ] **Step 3: Extend `ProgressServerOptions` with injected controls**

```ts
export interface ProgressServerControls {
  health(): HudHealth;
  showWindow(): void | Promise<void>;
  hideWindow(): void | Promise<void>;
  requestShutdown(): void | Promise<void>;
}
```

Default test-safe callbacks may be omitted only when control routes are not exercised; GUI mode supplies all callbacks.

- [ ] **Step 4: Implement minimal identity and authenticated routes**

Keep `/health` outside `/api/` and return only service/protocol fields. Route every `/api/` request through existing constant-time token verification. Parse `{}` for control POSTs through the existing body limit and return `202` after callback acceptance.

```ts
if (request.method === "GET" && url.pathname === "/health") {
  writeJson(response, 200, { service: "codex-progress-hud", protocolVersion: 1 });
  return;
}
if (request.method === "POST" && url.pathname === "/api/window/hide") {
  await readEmptyJson(request);
  await controls.hideWindow();
  writeJson(response, 202, { accepted: true });
  return;
}
```

- [ ] **Step 5: Run server and security regression tests**

Run: `npm test -- --run tests/server`

Expected: all server tests PASS, including existing task/SSE behavior.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/server/http-server.ts tests/server/http-server.test.ts
git commit -m "feat: add authenticated HUD control protocol"
```

### Task 3: Companion HTTP client and lifecycle manager

**Files:**
- Modify: `src/mcp/report-client.ts`
- Create: `src/lifecycle/companion-manager.ts`
- Create: `src/lifecycle/process-launcher.ts`
- Create: `src/diagnostics/report.ts`
- Test: `tests/mcp/report-client.test.ts`
- Test: `tests/lifecycle/companion-manager.test.ts`
- Test: `tests/diagnostics/report.test.ts`

**Interfaces:**
- Produces: `CompanionHttpClient` with `identity`, `health`, `show`, `hide`, `shutdown`, `submit`, and `status`.
- Produces: `ProcessLauncher.spawnHud(executablePath): Promise<SpawnedHud>`.
- Produces: `createCompanionManager(dependencies): CompanionManager` matching the approved spec.
- Produces: `writeDiagnosticReport(input): Promise<{path: string}>` with a minimal redacted report implementation.

Define the process and manager contracts before implementation:

```ts
export interface SpawnedHud {
  pid: number;
  terminate(): Promise<void>;
}

export interface ProcessLauncher {
  spawnHud(executablePath: string): Promise<SpawnedHud>;
}

export interface CompanionManager {
  status(): Promise<HudLifecycleSnapshot>;
  open(): Promise<HudLifecycleSnapshot>;
  hide(): Promise<HudLifecycleSnapshot>;
  close(): Promise<HudLifecycleSnapshot>;
  ensureForWrite(reason: "tracking_start" | "progress_report" | "task_outcome"): Promise<EnsureResult>;
  diagnose(): Promise<DiagnosticReport>;
}
```

- [ ] **Step 1: Write failing client tests against an ephemeral HTTP fixture**

Assert that `/health` is called without a token, `/api/health` and controls include the bearer token, network refusal is categorized separately from HTTP 401, and no raw response body is included in errors.

```ts
await expect(client.health()).rejects.toMatchObject({ code: "AUTH_ERROR" });
expect(seenHeaders.authorization).toBe("Bearer test-token");
expect(seenIdentityHeaders.authorization).toBeUndefined();
```

- [ ] **Step 2: Run client tests and confirm RED**

Run: `npm test -- --run tests/mcp/report-client.test.ts`

Expected: FAIL because lifecycle client methods do not exist.

- [ ] **Step 3: Implement typed client errors and methods**

```ts
export class HudClientError extends Error {
  constructor(
    readonly code: "OFFLINE" | "AUTH_ERROR" | "PORT_CONFLICT" | "VERSION_MISMATCH",
    message: string
  ) { super(message); }
}
```

`identity()` accepts only `{service, protocolVersion}`. `health()` validates the full `HudHealth`. Other methods preserve current task submission behavior.

- [ ] **Step 4: Run client tests to GREEN**

Run: `npm test -- --run tests/mcp/report-client.test.ts`

- [ ] **Step 5: Write failing manager and diagnostic-report tests**

Cover read-only status, explicit-off suppression, startup path validation, coalesced concurrent starts, readiness backoff capped at eight seconds, one retry after crash, recovery cooldown, graceful close, and no force-kill of an unowned PID.

The report test passes fixtures containing a bearer token, task title, task ID, source path, and command output; it asserts that none occur in the Markdown output while safe version/state fields do.

```ts
it("does not start from status", async () => {
  const result = await manager.status();
  expect(result.observedState).toBe("stopped");
  expect(launcher.spawnHud).not.toHaveBeenCalled();
});

it("suppresses background reporting after explicit close", async () => {
  await store.setDesiredState("off");
  expect(await manager.ensureForWrite("progress_report")).toEqual({
    kind: "suppressed",
    code: "MANUALLY_DISABLED"
  });
});
```

- [ ] **Step 6: Run manager tests and confirm RED**

Run: `npm test -- --run tests/lifecycle/companion-manager.test.ts`

- [ ] **Step 7: Implement shell-free spawning, manager orchestration, and the minimal report writer**

Use `spawn(executablePath, ["--hud"], {detached: true, stdio: "ignore", shell: false})`, call `unref()`, validate the manifest path with `resolve` and `relative`, share an in-flight startup promise, and use injected sleep intervals `[100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000, 500]` capped by elapsed time.

`CompanionManager.diagnose()` collects only version, desired/observed state, safe path-existence booleans, host/port, runtime age, and categorized errors, then delegates to `writeDiagnosticReport`.

```ts
async function ensureForWrite(reason: EnsureReason): Promise<EnsureResult> {
  const settings = await store.readSettings();
  if (settings.desiredState === "off" && reason !== "tracking_start") {
    return { kind: "suppressed", code: "MANUALLY_DISABLED" };
  }
  if (reason === "tracking_start") await store.setDesiredState("on");
  return ensureRunningOnce();
}
```

- [ ] **Step 8: Run lifecycle and client tests to GREEN**

Run: `npm test -- --run tests/lifecycle tests/mcp/report-client.test.ts tests/diagnostics/report.test.ts`

- [ ] **Step 9: Commit Task 3**

```powershell
git add src/lifecycle src/diagnostics/report.ts src/mcp/report-client.ts tests/lifecycle tests/diagnostics/report.test.ts tests/mcp/report-client.test.ts
git commit -m "feat: manage companion startup and recovery"
```

### Task 4: Lifecycle MCP tools and tracking integration

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/main.ts`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/mcp/stdio-server.test.ts`

**Interfaces:**
- Consumes: `CompanionManager` and `ProgressClient`.
- Produces: `hud_open`, `hud_hide`, `hud_close`, `hud_status`, and `hud_diagnose` handlers and registrations.
- Changes: state-changing reporting and tracking calls use `ensureForWrite` before accessing task state.

- [ ] **Step 1: Refactor the handler factory test contract without changing behavior**

Change the factory to accept named dependencies:

```ts
createToolHandlers({
  progressClient,
  companionManager
});
```

Use a no-op manager test double returning `{kind: "ready"}` so every existing test remains green.

- [ ] **Step 2: Run existing MCP tests to verify the refactor stays GREEN**

Run: `npm test -- --run tests/mcp/tools.test.ts`

- [ ] **Step 3: Write failing lifecycle-tool and recovery tests**

Assert exact manager calls, structured error codes, explicit-off suppression, `tracking_start` reopening, `tracking_stop` not closing, observational status, and a single reattempt of the original report after recovered startup.

```ts
it("tracking stop never closes the HUD", async () => {
  await handlers.trackingStop({});
  expect(companionManager.close).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `npm test -- --run tests/mcp/tools.test.ts`

- [ ] **Step 5: Implement lifecycle tool results and integrate `ensureForWrite`**

Return human-readable text plus structured content shaped as:

```ts
interface HudToolPayload {
  ok: boolean;
  desiredState?: "on" | "off";
  observedState?: ObservedHudState;
  code?: HudErrorCode;
  reportPath?: string;
}
```

Do not mark `MANUALLY_DISABLED` as a transport failure for `progress_report`; say the report was suppressed and not displayed.

```ts
const ensured = await companionManager.ensureForWrite("progress_report");
if (ensured.kind === "suppressed") {
  return structuredResult("HUD is manually closed; progress was not displayed.", {
    ok: true,
    desiredState: "off",
    code: "MANUALLY_DISABLED"
  });
}
if (ensured.kind === "error") return lifecycleErrorResult(ensured);
```

- [ ] **Step 6: Register all thirteen tools and update stdio expectations**

The expected sorted list contains the existing eight names plus `hud_open`, `hud_hide`, `hud_close`, `hud_status`, and `hud_diagnose`.

```ts
server.registerTool("hud_open", { title: "Open Progress HUD" }, () => handlers.hudOpen());
server.registerTool("hud_hide", { title: "Hide Progress HUD" }, () => handlers.hudHide());
server.registerTool("hud_close", { title: "Close Progress HUD" }, () => handlers.hudClose());
server.registerTool("hud_status", { title: "Read Progress HUD lifecycle" }, () => handlers.hudStatus());
server.registerTool("hud_diagnose", { title: "Diagnose Progress HUD" }, () => handlers.hudDiagnose());
```

- [ ] **Step 7: Run MCP tests to GREEN**

Run: `npm test -- --run tests/mcp`

- [ ] **Step 8: Commit Task 4**

```powershell
git add src/mcp tests/mcp
git commit -m "feat: expose HUD lifecycle tools"
```

### Task 5: Electron window, tray, single instance, and runtime identity

**Files:**
- Create: `src/desktop/window-controller.ts`
- Create: `src/desktop/tray-controller.ts`
- Modify: `src/desktop/lifecycle.ts`
- Modify: `src/desktop/main.ts`
- Test: `tests/desktop/window-controller.test.ts`
- Test: `tests/desktop/tray-controller.test.ts`
- Modify: `tests/desktop/lifecycle.test.ts`

**Interfaces:**
- Produces: `WindowController` with `create`, `show`, `hide`, `visibility`, and `dispose`.
- Produces: `createTrayController({onShow,onHide,onDiagnose,onExit,onToggleLogin})`.
- Produces: `runDesktop(dependencies?): Promise<void>`.

- [ ] **Step 1: Write failing pure adapter tests**

Use injected BrowserWindow/Tray/Menu-like interfaces. Verify close prevents default destruction and hides, show is idempotent, tray Exit sets desired off before quit, and a second-instance callback shows the existing window.

```ts
it("hides rather than destroys on window close", () => {
  const event = { preventDefault: vi.fn() };
  window.emit("close", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(window.hide).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run desktop tests and confirm RED**

Run: `npm test -- --run tests/desktop`

- [ ] **Step 3: Extract the window controller without changing security options**

Preserve `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, transparent frameless rendering, `alwaysOnTop`, and `skipTaskbar`. Add `window.on("close", event => { if (!quitting) { event.preventDefault(); window.hide(); } })`.

```ts
window.on("close", (event) => {
  if (quitting()) return;
  event.preventDefault();
  window.hide();
});
```

- [ ] **Step 4: Implement tray commands and explicit Exit semantics**

The menu order is Show HUD, Hide HUD, separator, Start with Windows, Diagnose, separator, Exit. The login checkbox reflects `app.getLoginItemSettings()` and updates only after explicit user selection.

```ts
const template = [
  { label: "Show HUD", click: onShow },
  { label: "Hide HUD", click: onHide },
  { type: "separator" as const },
  { label: "Start with Windows", type: "checkbox" as const, checked: loginEnabled, click: onToggleLogin },
  { label: "Diagnose", click: onDiagnose },
  { type: "separator" as const },
  { label: "Exit", click: onExit }
];
```

- [ ] **Step 5: Implement GUI single-instance and runtime identity**

Acquire `app.requestSingleInstanceLock()` only in GUI mode. If it fails, call `app.quit()` before creating a server. On successful readiness, write runtime metadata with `process.pid`, package version, protocol 1, `randomUUID()` nonce, and ISO start time. Clear it during clean exit.

```ts
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on("second-instance", () => windowController.show());
```

- [ ] **Step 6: Connect HTTP callbacks to window and app lifecycle**

Pass `health`, `showWindow`, `hideWindow`, and `requestShutdown` into `createProgressServer`. Set a `quitting` flag before authenticated shutdown or tray Exit so the close handler permits destruction.

```ts
controls: {
  health: () => runtimeHealth(windowController.visibility()),
  showWindow: () => windowController.show(),
  hideWindow: () => windowController.hide(),
  requestShutdown: async () => { quitting = true; app.quit(); }
}
```

- [ ] **Step 7: Run desktop and server suites to GREEN**

Run: `npm test -- --run tests/desktop tests/server`

- [ ] **Step 8: Commit Task 5**

```powershell
git add src/desktop tests/desktop
git commit -m "feat: add tray and single-instance HUD lifecycle"
```

### Task 6: Unified executable modes with clean stdio

**Files:**
- Create: `src/main.ts`
- Modify: `src/mcp/main.ts`
- Modify: `src/desktop/main.ts`
- Modify: `package.json`
- Test: `tests/desktop/entry-mode.test.ts`
- Modify: `tests/mcp/stdio-server.test.ts`

**Interfaces:**
- Produces: `selectEntryMode(argv): "hud" | "mcp-stdio"`.
- Produces: exported `runMcpServer()` and `runDesktop()` functions.
- Changes package main entry to `dist/main.js`.

- [ ] **Step 1: Write failing mode-selection tests**

```ts
expect(selectEntryMode(["app.exe", "--mcp-stdio"])).toBe("mcp-stdio");
expect(selectEntryMode(["app.exe", "--hud"])).toBe("hud");
expect(selectEntryMode(["app.exe"])).toBe("hud");
```

- [ ] **Step 2: Run the entry-mode tests and confirm RED**

Run: `npm test -- --run tests/desktop/entry-mode.test.ts`

- [ ] **Step 3: Refactor MCP and desktop modules into callable entry functions**

Neither module performs startup at import time. `src/main.ts` dynamically imports exactly one mode and writes fatal errors only to stderr. MCP mode never imports BrowserWindow or creates a GUI lock.

```ts
export function selectEntryMode(argv: string[]): "hud" | "mcp-stdio" {
  return argv.includes("--mcp-stdio") ? "mcp-stdio" : "hud";
}

const mode = selectEntryMode(process.argv);
if (mode === "mcp-stdio") await (await import("./mcp/main.js")).runMcpServer();
else await (await import("./desktop/main.js")).runDesktop();
```

- [ ] **Step 4: Set package entry and preserve development scripts**

Use `"main": "dist/main.js"`, keep `npm run mcp` for source diagnostics, and add `start:hud` plus `start:mcp` names that make the mode explicit.

- [ ] **Step 5: Assert stdout protocol cleanliness**

Extend the real stdio test to collect stderr separately and complete initialize/tools-list without any application text on MCP stdout. Add all thirteen expected tool names.

- [ ] **Step 6: Run build, entry, and stdio tests**

Run: `npm run build`

Run: `npm test -- --run tests/desktop/entry-mode.test.ts tests/mcp/stdio-server.test.ts`

Expected: build and tests PASS.

- [ ] **Step 7: Commit Task 6**

```powershell
git add src/main.ts src/mcp/main.ts src/desktop/main.ts package.json tests/desktop/entry-mode.test.ts tests/mcp/stdio-server.test.ts
git commit -m "feat: support HUD and MCP executable modes"
```

### Task 7: Sanitized diagnostics and bounded logging

**Files:**
- Create: `src/diagnostics/logger.ts`
- Modify: `src/diagnostics/report.ts`
- Test: `tests/diagnostics/logger.test.ts`
- Modify: `tests/diagnostics/report.test.ts`
- Modify: `src/lifecycle/companion-manager.ts`
- Modify: `src/desktop/main.ts`

**Interfaces:**
- Produces: `createOperationalLogger({logDirectory,maxBytes,maxFiles})`.
- Produces: `writeDiagnosticReport(input): Promise<{path: string}>`.
- `CompanionManager.diagnose()` delegates to the report writer.

- [ ] **Step 1: Write failing redaction and rotation tests**

Use fixtures containing `Bearer secret`, `token=secret`, task IDs, titles, source paths, and command output. Assert none appear in the report or log. Write enough entries to exceed a 256 KiB test limit and assert bounded rotation.

- [ ] **Step 2: Run diagnostics tests and confirm RED**

Run: `npm test -- --run tests/diagnostics`

- [ ] **Step 3: Implement category-only operational logging**

Allowed fields are timestamp, level, event code, lifecycle state, protocol version, HTTP status category, and elapsed milliseconds. Reject arbitrary metadata keys at the TypeScript interface.

```ts
export interface OperationalLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  event: string;
  lifecycleState?: ObservedHudState;
  protocolVersion?: number;
  httpStatusCategory?: "2xx" | "4xx" | "5xx" | "network";
  elapsedMs?: number;
}
```

- [ ] **Step 4: Implement the Markdown diagnostic report**

Include versions, state, file-existence booleans, host/port, runtime age, categorized recent errors, and safe verification commands. Show `%APPDATA%`-relative labels instead of full personal paths in report content while returning the absolute report path to the caller.

```ts
const markdown = [
  "# Codex Progress HUD Diagnostic",
  `- Protocol: ${input.protocolVersion}`,
  `- Desired state: ${input.desiredState ?? "unset"}`,
  `- Observed state: ${input.observedState}`,
  `- Install manifest present: ${input.installManifestPresent}`
].join("\n");
```

- [ ] **Step 5: Integrate diagnostics and logging into manager and desktop boundaries**

Record startup requested/ready/failed, shutdown requested/complete/timeout, port conflict, protocol mismatch, and crash recovery. Never pass event envelopes into the logger.

```ts
logger.write({
  at: new Date(clock.now()).toISOString(),
  level: "info",
  event: "startup_ready",
  lifecycleState: "running",
  elapsedMs
});
```

- [ ] **Step 6: Run diagnostics, lifecycle, and MCP tests to GREEN**

Run: `npm test -- --run tests/diagnostics tests/lifecycle tests/mcp`

- [ ] **Step 7: Commit Task 7**

```powershell
git add src/diagnostics src/lifecycle/companion-manager.ts src/desktop/main.ts tests/diagnostics
git commit -m "feat: add safe HUD diagnostics"
```

### Task 8: Skill behavior, regression suite, and lifecycle acceptance gate

**Files:**
- Modify: `skills/progress-reporting/SKILL.md`
- Modify: `README.md`
- Modify: `docs/THREAT_MODEL.md`
- Create: `tests/integration/companion-lifecycle.test.ts`
- Modify: `scripts/smoke-test.mjs`

**Interfaces:**
- Produces: natural-language lifecycle mappings and an automated source-mode lifecycle smoke test.
- Provides the prerequisite boundary for the Windows packaging plan.

- [ ] **Step 1: Update the skill with exact control semantics**

Document Chinese and English trigger examples, the separation of `tracking_stop` from `hud_close`, observational status behavior, explicit-off suppression, and when `tracking_start` may reopen the companion. Keep secrets and task payload restrictions unchanged.

- [ ] **Step 2: Write the failing source-mode lifecycle integration test**

Launch a test companion fixture on an ephemeral port, verify health, hide, show, shutdown, explicit-off suppression, and one recovery after fixture termination. Mark the child as test-owned so cleanup never targets another process.

```ts
const opened = await manager.open();
expect(opened.observedState).toBe("running");
await manager.close();
expect((await manager.status()).desiredState).toBe("off");
expect(await manager.ensureForWrite("progress_report")).toMatchObject({ kind: "suppressed" });
```

- [ ] **Step 3: Run the integration test and confirm RED**

Run: `npm test -- --run tests/integration/companion-lifecycle.test.ts`

- [ ] **Step 4: Extend the smoke script to exercise health and graceful shutdown**

The script must create a temporary data directory, verify authenticated event flow plus protocol health, request shutdown through the injected callback, and remove only its own temporary directory.

- [ ] **Step 5: Document lifecycle troubleshooting and threat-model changes**

Add the structured error codes, manual-off behavior, port ownership rule, runtime metadata limitations, and diagnostic redaction contract. Do not yet document an installer command; that belongs to the packaging plan.

- [ ] **Step 6: Run the complete lifecycle release gate**

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run smoke`

Run: `npm run diagnose:mcp`

Run: `npm run validate:plugin`

Run: `git diff --check`

Expected: every command exits 0, the test count is reported, and no unrelated dirty file is staged.

- [ ] **Step 7: Commit Task 8**

```powershell
git add skills/progress-reporting/SKILL.md README.md docs/THREAT_MODEL.md tests/integration/companion-lifecycle.test.ts scripts/smoke-test.mjs
git commit -m "docs: define HUD lifecycle operation"
```

- [ ] **Step 8: Stop before packaging review**

Review the Task 1-8 diff and test evidence. Do not begin the Windows packaging plan until lifecycle behavior is accepted as a working source-mode deliverable.
