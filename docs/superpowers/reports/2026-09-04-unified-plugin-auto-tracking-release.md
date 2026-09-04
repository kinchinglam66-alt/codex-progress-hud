# Codex Progress HUD 0.2.0 local release verification

Date: 2026-09-04

The unified one-switch automatic-tracking architecture is implemented and locally packaged for Windows x64. Enabling the Codex plugin allows Hooks and MCP leases to start tracking automatically; disabling/uninstalling the plugin stops new activity and lets the companion exit after the final lease grace period, including when a Hook-started companion never receives its first lease. Window show/hide and per-task pause/resume/stop remain presentation/timing controls, not plugin or Codex execution controls.

Release readiness evidence:

- 36 test files and 548 tests passed in the serialized release gate.
- The packaged HUD passed health, bearer authentication, 14-tool MCP discovery, and controlled shutdown.
- The release plugin's native bridge passed real MCP initialize and `tools/list` without global Node.
- Automatic new-task tracking, late attachment, two-session owner isolation, protocol mismatch, lease expiry, zero-lease Hook shutdown, and fail-open `Interrupt` behavior have dedicated integration coverage.
- The release plugin uses the documented direct MCP server map; release CI rebuilds the native bridge from reviewed C# source, pins Actions to full commit SHAs, derives artifact names from `package.json`, and installs dependencies only from the official npm registry.
- Production dependency audit reported zero vulnerabilities.
- The plugin ZIP is deterministic and contains only its 13-file whitelist.
- Secret, absolute developer-path, cache/junk, and plugin-payload scans were clean.

Local artifacts:

- `release/Codex-Progress-HUD-Setup-0.2.0.exe` — SHA-256 `c310d4fea1b740dcc651639f1283b3225fbe346a4a5d87583ad5fa99b43827c3`
- `release/codex-progress-hud-plugin-0.2.0.zip` — SHA-256 `71e6c6542f4c6f4c3e592f9ebeb7146f92ace73feb6c37495b4e9c6bac7888fc`
- `release/SHA256SUMS.txt`

The installer and native bridge are intentionally unsigned at this stage. They have not been installed, pushed, tagged, published, or uploaded. See `docs/INSTALL-WINDOWS.md` and `docs/RELEASE-CHECKLIST.md` before public distribution.
