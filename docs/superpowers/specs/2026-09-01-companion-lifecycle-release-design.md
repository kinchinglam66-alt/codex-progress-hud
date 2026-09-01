# Codex Progress HUD Companion Lifecycle and Release Design

**Status:** Approved for planning on 2026-09-01  
**Target release:** 0.2.0  
**Platform:** Windows 10/11 x64 first  
**Related baseline:** `docs/superpowers/specs/2026-09-01-codex-progress-hud-design.md`

## Context

The 0.1.0 plugin can report progress through an MCP process, but that process only sends HTTP requests to `127.0.0.1:17837`. It does not own the Electron companion lifecycle. When the companion is absent or exits, every status or reporting tool returns the same generic offline error. A manually launched development Electron process also dies with its parent execution session, so a successful one-off launch does not provide a publishable installation.

The release must separate task tracking from desktop-window lifecycle, distinguish intentional shutdown from an unexpected interruption, recover from recoverable crashes, and give users a deterministic installation and update path.

## Goals

- Make companion startup, visibility, shutdown, health, and diagnosis controllable from any Codex turn after the plugin has loaded.
- Keep task tracking controls independent from companion process controls.
- Preserve an explicit user shutdown until the user explicitly opens the HUD or starts tracking again.
- Detect crashes and recover once on the next state-changing report when the desired state remains on.
- Eliminate the release-time requirement for users to install Node.js or run `npm start`.
- Produce a Windows per-user installer, a distributable Codex plugin package, checksums, release documentation, and repeatable CI verification.
- Preserve loopback-only networking, bearer authentication, data minimization, and actionable diagnostics.

## Non-goals

- Running as a Windows service.
- Force-killing unknown processes that occupy the configured port.
- Injecting UI into undocumented Codex desktop internals.
- Automatically trusting or relying on plugin lifecycle hooks.
- Supporting macOS, Linux, ARM64, or the public universal plugin directory in the 0.2.0 release.
- Claiming the absence of all unknown defects. Release readiness means all defined gates pass and no unexplained high-priority defect remains.

## Chosen architecture

The release has two coordinated artifacts:

1. A Codex plugin containing its manifest, progress-reporting skill, MCP configuration, and a quiet Windows launcher script.
2. A per-user Windows companion installation containing one packaged Electron executable.

The installed executable supports two modes:

- `CodexProgressHUD.exe --hud` starts or activates the desktop companion.
- `CodexProgressHUD.exe --mcp-stdio` runs only the stdio MCP server and never creates a window or acquires the GUI single-instance lock.

The plugin launcher locates the executable from the installation manifest and starts `--mcp-stdio` without writing anything to stdout before the MCP protocol begins. The launcher writes actionable startup failures to stderr and exits nonzero. This makes Node.js a development dependency rather than an end-user prerequisite and keeps the MCP and companion protocol versions in one installed artifact.

The companion installer is a prerequisite for the release plugin. If it is entirely absent, no MCP process exists to return a normal tool result; the launcher therefore reports `COMPANION_NOT_INSTALLED` through MCP startup diagnostics. Once MCP starts, all lifecycle failures use structured tool results.

The plugin does not directly modify Codex cache files. Local development updates use the supported cachebuster and reinstall flow. End-user installation documentation installs the companion first, then the plugin, then performs one Codex restart so the MCP command and skills are loaded deterministically.

The repository also acts as a Git marketplace without moving the companion source tree. It contains `.agents/plugins/marketplace.json` with marketplace name `kinchinglam66-alt` and a minimal runtime plugin under `plugins/codex-progress-hud/`. A synchronization/check script keeps that runtime package aligned with the canonical manifest, skill, launcher, license, and documentation. Public installation uses `codex plugin marketplace add kinchinglam66-alt/codex-progress-hud --ref main` followed by `codex plugin add codex-progress-hud@kinchinglam66-alt`.

## Runtime components

### MCP entry mode

The MCP entry mode registers the existing eight tools and four lifecycle tools:

- Existing: `progress_report`, `task_outcome`, `task_status`, `tracking_start`, `tracking_pause`, `tracking_resume`, `tracking_stop`, and `tracking_status`.
- New: `hud_open`, `hud_hide`, `hud_close`, and `hud_status`.
- Diagnostic: `hud_diagnose`.

The MCP process owns a `CompanionManager`, but it does not own task state. Task state remains in the companion's local service.

### GUI entry mode

The GUI entry mode owns:

- the Electron `BrowserWindow`;
- the loopback HTTP/SSE service;
- a system tray menu;
- single-instance behavior;
- runtime identity and clean-exit metadata;
- rolling local logs;
- authenticated display and shutdown control handlers.

Only GUI mode calls `app.requestSingleInstanceLock()`. A second GUI launch sends an activation request to the existing instance and exits. MCP-mode processes may run independently for separate Codex tasks.

### Persistent files

The existing per-user data directory remains `%APPDATA%\\codex-progress-hud` to avoid invalidating the current token path. It contains:

- `auth.token`: random bearer token, never logged;
- `settings.json`: desired state and start-with-Windows preference;
- `runtime.json`: current GUI process identity, version, protocol version, start time, and instance nonce;
- `install.json`: installer-written executable path and installed version;
- `logs/companion.log`: size-bounded rolling operational logs;
- `diagnostics/`: user-requested sanitized reports.

Settings, runtime identity, and installation metadata use atomic replace writes. A stale runtime file is evidence, not authority: health probing remains the source of truth for whether an instance is alive.

## Lifecycle state model

The lifecycle model keeps desired and observed state separate.

```text
desiredState: on | off
observedState: starting | running | hidden | stopped | crashed | incompatible | port_conflict
```

Rules:

- Missing settings default to `desiredState: on` only when the user first invokes `hud_open`, `tracking_start`, or a progress report. Installation alone does not open a window.
- `hud_open` sets desired state to on, ensures a compatible companion is running, and shows the overlay.
- `hud_hide` leaves desired state on and hides the overlay while keeping reporting available.
- `hud_close` sets desired state to off before requesting authenticated graceful shutdown.
- Tray **Show** and **Hide** only change visibility.
- Tray **Exit** sets desired state to off and exits.
- The window close affordance hides to tray; it does not terminate the process.
- `hud_status` and `tracking_status` are observational and never launch a process.
- `tracking_stop` stops task tracking and preserves its final snapshot; it never closes the companion.
- `tracking_start` is an explicit user action that sets desired state to on, ensures the companion is running, and starts or restarts tracking.
- A first `progress_report` may start the companion when no explicit off preference exists.
- A `progress_report` received while desired state is off returns a successful suppressed result with reason `MANUALLY_DISABLED`; it does not reopen the window and does not claim the report was displayed.
- When desired state is on and the companion disappears unexpectedly, the next state-changing call performs one restart attempt and retries the original operation once.
- Automatic recovery is limited to one attempt per tool call and is rate-limited across calls to prevent a restart loop.

## Determining intentional shutdown versus interruption

An unavailable companion is classified with the following precedence:

1. `desiredState: off` means an intentional shutdown, regardless of stale runtime metadata.
2. A compatible authenticated health response means running or hidden according to the response.
3. A service identity response with an incompatible protocol means `incompatible`.
4. A listener that does not identify as Codex Progress HUD means `port_conflict`.
5. `desiredState: on` plus a previously healthy runtime record and no current listener means `crashed`.
6. `desiredState: on` without prior healthy runtime evidence means `stopped` and eligible for startup.

The model is not asked to decide whether the process crashed. This classification is deterministic and uses persisted intent plus observable process/service evidence. A model may explain the result to the user but is not an authority for lifecycle truth.

## CompanionManager behavior

`CompanionManager` exposes focused operations:

```ts
type DesiredHudState = "on" | "off";
type ObservedHudState =
  | "starting"
  | "running"
  | "hidden"
  | "stopped"
  | "crashed"
  | "incompatible"
  | "port_conflict";

interface HudHealth {
  service: "codex-progress-hud";
  version: string;
  protocolVersion: 1;
  visibility: "visible" | "hidden";
  instanceNonce: string;
  startedAt: string;
}

interface CompanionManager {
  status(): Promise<HudLifecycleSnapshot>;
  open(): Promise<HudLifecycleSnapshot>;
  hide(): Promise<HudLifecycleSnapshot>;
  close(): Promise<HudLifecycleSnapshot>;
  ensureForWrite(reason: "tracking_start" | "progress_report" | "task_outcome"): Promise<EnsureResult>;
  diagnose(): Promise<DiagnosticReport>;
}
```

Startup uses the absolute executable path from `install.json`, validates that it remains inside the recorded installation directory, spawns without a shell, detaches from the MCP process, and polls health with bounded backoff for no more than eight seconds. Concurrent startup calls share one in-flight promise.

Shutdown persists desired state off first, sends an authenticated shutdown request, and waits up to five seconds for health to disappear. A forced termination is permitted only for a process spawned by the current MCP process whose identity is still confirmed. Other shutdown timeouts return `SHUTDOWN_TIMEOUT` without killing a PID from stale metadata.

## Local protocol

Protocol version 1 adds:

- `GET /health`: unauthenticated minimal identity containing only service name and protocol version, used to distinguish a port conflict. It contains no task data, version path, PID, nonce, or token.
- `GET /api/health`: authenticated full `HudHealth` response.
- `POST /api/window/show`: authenticated, idempotent show operation.
- `POST /api/window/hide`: authenticated, idempotent hide operation.
- `POST /api/shutdown`: authenticated graceful shutdown request.
- Existing authenticated task snapshot, event submission, and SSE routes remain compatible.

All `/api/` routes require the bearer token. Mutating routes require JSON with a maximum 64 KiB body, even when the current payload is empty. Responses include `cache-control: no-store`, MIME hardening, and no permissive CORS headers.

The HTTP server receives callbacks for show, hide, and shutdown rather than importing Electron. This keeps server tests independent from the desktop runtime.

## Tool behavior and messages

Lifecycle tools return concise text plus structured content suitable for clients. Expected error codes are:

- `COMPANION_NOT_INSTALLED`
- `MANUALLY_DISABLED`
- `PORT_CONFLICT`
- `VERSION_MISMATCH`
- `START_TIMEOUT`
- `AUTH_ERROR`
- `SHUTDOWN_TIMEOUT`
- `COMPANION_CRASHED`
- `INTERNAL_ERROR`

Errors name the next safe action. They never include bearer tokens, raw prompts, source code, command output, or full environment dumps.

The reporting skill maps ordinary Chinese or English requests such as “打开进度窗”, “关闭进度窗”, “查看插件状态”, and “诊断进度插件” to the lifecycle tools. Once installed and loaded, the plugin can be selected or invoked in any turn; only installation or an updated tool manifest requires a new task or Codex restart.

## Tray and desktop behavior

The tray menu contains:

- Show HUD
- Hide HUD
- Start with Windows (unchecked by default)
- Diagnose
- Exit

Start-with-Windows uses Electron's per-user login item support and is never enabled silently. The overlay remains frameless, transparent, always on top, sandboxed, and excluded from the taskbar. Activating a second GUI instance shows the existing window.

## Diagnostics and logs

`hud_diagnose` creates a Markdown report and returns its absolute path. The report contains:

- plugin, MCP, companion, and protocol versions;
- desired and observed lifecycle states;
- redacted installation and data-directory existence checks;
- configured host and port;
- health and authentication result categories;
- runtime metadata age;
- last bounded operational errors;
- exact verification commands the user can run.

It excludes task titles, task IDs, prompts, reasoning, source text, command output, environment values, tokens, and file contents. Logs use bounded rotation and record event categories rather than report payloads.

## Security boundaries

- Bind only to `127.0.0.1` or `::1` and reject other listener hosts.
- Authenticate every `/api/` request with the existing random bearer token and constant-time comparison.
- Use exact executable paths and `shell: false` for all process creation.
- Treat the installation manifest as user-scoped configuration and validate its schema and expected location before use.
- Never kill an unknown port owner.
- Never trust a PID from `runtime.json` without live identity confirmation.
- Keep the BrowserWindow sandboxed with context isolation, no Node integration, restrictive CSP, and no navigation to non-loopback origins.
- Do not use plugin lifecycle hooks for automatic startup. Plugin hook trust remains an explicit Codex user decision.

## Packaging and installation

The Windows installer uses `electron-builder` with a per-user NSIS target and a fixed default installation under `%LOCALAPPDATA%\\Programs\\Codex Progress HUD`. It writes `install.json`, creates Start Menu and uninstall entries, and does not require elevation. The source repository does not commit generated Electron binaries.

Release assets are:

- `Codex-Progress-HUD-Setup-0.2.0.exe`
- `codex-progress-hud-plugin-0.2.0.zip`
- `SHA256SUMS.txt`
- release notes describing supported Windows versions and known limitations

The plugin ZIP contains only runtime files required by the plugin. The setup executable contains the packaged companion. Until a trusted code-signing certificate is configured, the release notes and installation guide state that the installer is unsigned and may trigger Windows SmartScreen.

Installation order:

1. Verify the checksum and install the Windows companion.
2. Install or update the Codex plugin through a supported marketplace/plugin command.
3. Restart Codex once so the plugin's MCP command and skills are reloaded.
4. In any task, ask Codex to open the Progress HUD or start tracking.

Uninstall first disables start-with-Windows, requests companion shutdown, and removes binaries and shortcuts. User task state is not persisted. The uninstaller offers an explicit choice to retain or remove preferences, logs, token, and diagnostics.

## Development and update flow

Development continues to use TypeScript source, Vitest, and a locally installed Electron dependency. Source-mode scripts may launch the development MCP and GUI directly. Release packaging must exercise the installed executable modes.

Existing personal-marketplace updates use the plugin-creator workflow:

1. Read and validate the marketplace name.
2. Update the single Codex cachebuster suffix with the provided helper.
3. Reinstall with `codex plugin add <plugin>@<marketplace>`.
4. Restart Codex for deterministic pickup of changed tools.

Marketplace files and Codex configuration are not hand-edited during this update loop.

## Verification strategy

### Unit tests

- Desired/observed lifecycle classification.
- Explicit-off suppression.
- Startup coalescing, bounded backoff, retry limits, and recovery rate limiting.
- Installation manifest and protocol compatibility validation.
- Structured error mapping and diagnostic redaction.
- Tracking controls remain independent from HUD process controls.

### Integration tests

- Authenticated health, show, hide, shutdown, task event, and SSE endpoints.
- Single-instance activation behavior through injected Electron adapters.
- Real MCP initialize, tools/list, and tools/call over stdio.
- MCP process output contains no non-protocol stdout.
- Actual child process startup, health readiness, graceful shutdown, and crash recovery with a test companion fixture.

### Packaging tests

- Build the unpacked Electron application and NSIS installer on Windows CI.
- Run `--mcp-stdio` against the built executable and complete an MCP handshake.
- Start `--hud` from the built executable, probe health, and shut it down.
- Verify release ZIP contents and SHA-256 generation.
- Continue running platform-neutral core tests on Windows and Ubuntu.

### Manual acceptance on the target machine

1. Stop every existing development companion and confirm the port is free.
2. Install the release candidate from the generated installer.
3. Install the cachebusted plugin and restart Codex.
4. Invoke `hud_open` from a task and verify the overlay appears.
5. Exercise `tracking_start`, `tracking_pause`, `tracking_resume`, `tracking_stop`, and `tracking_status`.
6. Submit progress and outcome reports and verify live rendering.
7. Exercise hide, show, explicit close, and status.
8. Confirm status and background progress do not restart an explicitly closed companion.
9. Confirm explicit `tracking_start` restarts it.
10. Terminate a test-owned GUI process unexpectedly and confirm the next write recovers once.
11. Run `hud_diagnose` and inspect the generated report for usefulness and redaction.
12. Uninstall, reinstall, and repeat the startup and shutdown smoke path.

## Release gates

The 0.2.0 release candidate is acceptable only when:

- all Vitest suites pass;
- TypeScript type checking passes;
- development and production builds pass;
- plugin validation passes;
- the real stdio MCP diagnostic passes against source and packaged executable modes;
- Windows lifecycle and installer smoke tests pass;
- `git diff --check` passes;
- no unexplained P0 or P1 defect remains;
- documentation covers installation, update, disable, uninstall, diagnostics, privacy, security, unsigned-installer behavior, and Windows-only scope;
- the manual acceptance sequence succeeds from a stopped companion and after a clean reinstall.

## Migration and compatibility

- Preserve existing task event schemas and tool names.
- Additive lifecycle tools do not change the semantics of the existing five tracking controls.
- Preserve the current auth token and data directory where valid.
- Protocol mismatches fail closed with `VERSION_MISMATCH`; they do not submit events to an unknown service.
- The old development command remains available under a clearly named development script, but the release plugin uses the installed executable launcher.
- The plugin semantic version becomes 0.2.0. Local Codex cachebusters remain build metadata and never accumulate multiple suffixes.
