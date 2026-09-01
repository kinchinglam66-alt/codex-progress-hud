# Codex Progress HUD

A local, privacy-first desktop overlay for Codex task status, structured progress, and honest remaining-time ranges.

> Community project. Not affiliated with, endorsed by, or sponsored by OpenAI. “Codex” is used only to describe compatibility with the Codex product.

## What works in the MVP

- Frameless always-on-top Electron overlay for Windows, with portable core code.
- Structured `progress_report`, `task_outcome`, and `task_status` MCP tools.
- User-controlled `tracking_start`, `tracking_pause`, `tracking_resume`, `tracking_stop`, and `tracking_status` MCP tools.
- Companion lifecycle `hud_open`, `hud_hide`, `hud_close`, `hud_status`, and `hud_diagnose` MCP tools.
- Deterministic lifecycle states that distinguish waiting, failure, interruption, unverified completion, and verified success.
- ETA ranges combining observed plan throughput with the executing model's estimate and confidence.
- Loopback-only authenticated HTTP/SSE transport.
- Chinese compact HUD labels; the internal data model is locale-neutral.

The MVP does not inject UI into undocumented Codex desktop surfaces and does not scrape the Codex window. Automatic attachment to the private App Server instance used by the stock desktop GUI is not guaranteed. A future bridge can feed documented App Server notifications into the existing reducer.

## Quick start

Requirements: Node.js 22 or newer and a current Codex installation.

```powershell
npm ci
npm test -- --run
npm run build
npm start
```

The overlay listens on `127.0.0.1:17837`. Override the port with `CODEX_PROGRESS_HUD_PORT`. The local bearer token is generated under the user's application-data directory; never copy it into the repository.

Build the project before loading the plugin so `.mcp.json` can start `dist/mcp/main.js`. During local plugin development, clone this repository as `codex-progress-hud` under your personal Codex plugins directory and add it through your personal marketplace. After installing or updating it, fully quit and reopen Codex Desktop before starting a new task so the host reloads the plugin version, skill, and MCP tools.

## Troubleshooting plugin loading

If the skill is visible but the MCP tools are missing, run the real stdio handshake diagnostic from the repository:

```powershell
npm run diagnose:mcp
```

A healthy result initializes the server from a different temporary task directory and finds all 13 tools. This catches broken relative entry paths and startup failures, and includes the child-process error in the failure output. It verifies the installed bundle itself; it does not prove that a running Codex Desktop process has activated that bundle version.

The overlay and MCP server are separate processes. Missing tools means the MCP server did not load; an available tool that reports `Progress HUD is not reachable` means the plugin loaded but the desktop companion is not running, so start it with `npm start`.

After every local plugin install or update, fully quit Codex Desktop, confirm its background host processes have exited, reopen it, and test in a new task. A new task alone may still inherit the process-level plugin snapshot. Avoid reinstalling while relying on an older active task: the installer may remove a cache directory that the running host still references, leaving the skill visible while all MCP tools are omitted.

## How progress is calculated

The HUD treats runtime lifecycle events as authoritative and model reports as cooperative semantic evidence. Explicit runtime failure or interruption cannot be overwritten by a model saying that it finished.

When plan progress is measurable, the first ETA signal is:

```text
remaining ≈ active elapsed × (1 − completed weight) / completed weight
```

The estimator blends that value with the executing model's structured estimate according to reported confidence. Exploration widens the interval and lowers confidence. Waiting and terminal states return no active-work ETA.

This is intentionally a range, not a precise countdown. The current estimator is a transparent baseline intended for calibration with opt-in, content-free historical timing samples.

## MCP reporting contract

The bundled skill asks Codex to report on task start, plan changes, phase changes, waiting states, validation failures, and terminal outcomes. Reports contain concise display-safe metadata only:

- Task identifier and short title.
- Current phase and step.
- Optional `0..1` progress and confidence.
- Optional low/high remaining active-work seconds.
- Waiting reason or final semantic outcome.

Prompts, hidden reasoning, source code, command output, file contents, and credentials must not be reported.

Tracking can also be controlled from any turn after the plugin has loaded in the task. `tracking_pause` and `tracking_stop` affect only HUD updates and timing; they do not pause or cancel the underlying Codex task. After installing or updating the plugin, fully restart Codex Desktop and then start a new task so its skill and MCP tool definitions are refreshed together.

## Companion lifecycle and troubleshooting

`tracking_stop` stops tracking and preserves the final snapshot; it does not close the companion. `hud_hide` hides the window without stopping the local service. `hud_close` requests authenticated graceful shutdown and records an explicit off preference. While explicit off is set, background reports, outcomes, pause, resume, and stop writes are suppressed. An explicit `hud_open`, or `tracking_start` after the user asks to start or restart tracking, may clear that preference and reopen the companion. `task_status`, `tracking_status`, and `hud_status` only observe state and never reopen it.

Lifecycle failures use stable structured codes:

- `COMPANION_NOT_INSTALLED`: the install manifest or contained executable is unavailable.
- `MANUALLY_DISABLED`: explicit off suppressed a background write.
- `PORT_CONFLICT`: the configured loopback port belongs to another service.
- `VERSION_MISMATCH`: the companion protocol is incompatible.
- `START_TIMEOUT`: a launched companion did not become healthy within the startup window.
- `AUTH_ERROR`: the local token is missing, unreadable, or rejected.
- `SHUTDOWN_TIMEOUT`: graceful shutdown could not be confirmed safely.
- `COMPANION_CRASHED`: a previously healthy companion disappeared and recovery was unavailable or rate-limited.
- `INTERNAL_ERROR`: an uncategorized local lifecycle operation failed.

The unauthenticated `/health` route proves only service identity and protocol compatibility. Full health requires the bearer token. A PID in `runtime.json` is stale-prone diagnostic metadata, not proof of a live or owned process. On shutdown timeout, the manager may force-terminate only a process it spawned itself and only while authenticated live health still matches both its PID and instance nonce; it never kills a process merely because it occupies the configured port or appears in stale metadata.

Use `hud_diagnose` for a redacted report. Reports contain only allowlisted versions, lifecycle states, path-existence booleans, loopback host/port, runtime age, and categorized error codes. Operational logs likewise contain category fields and timings only. Neither output may contain bearer tokens, prompts, task payloads, source code, file contents, command output, or exception messages.

## Development

```powershell
npm test -- --run
npm run typecheck
npm run build
npm run validate:plugin
npm run diagnose:mcp
```

Architecture and implementation records are under `docs/superpowers/`. Security boundaries are documented in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Open-source checklist before publishing a fork

- Update package and plugin author metadata to the real maintainer identity.
- Add the final GitHub repository, homepage, privacy-policy, and security-contact URLs.
- Enable GitHub private vulnerability reporting, branch protection, Dependabot, and required CI checks.
- Review every dependency license and generated binary before a release.
- Sign release artifacts and publish checksums when installers are added.
- Test plugin loading against the minimum and latest supported Codex versions.
- Do not upload local token files, task snapshots, logs, `.env` files, or screenshots containing private work.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
