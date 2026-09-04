# Codex Progress HUD 0.2.0 local release verification

Date: 2026-09-04

The unified one-switch automatic-tracking architecture is implemented and locally packaged for Windows x64. Enabling the Codex plugin allows Hooks and MCP leases to start tracking automatically; disabling/uninstalling the plugin stops new activity and lets the companion exit after the final lease grace period, including when a Hook-started companion never receives its first lease. Window show/hide and per-task pause/resume/stop remain presentation/timing controls, not plugin or Codex execution controls.

Release readiness evidence:

- 36 test files and 551 tests passed in the serialized release gate.
- The packaged HUD passed health, bearer authentication, 14-tool MCP discovery, and controlled shutdown.
- The release plugin's native bridge passed real MCP initialize and `tools/list` without global Node.
- Automatic new-task tracking, late attachment, two-session owner isolation, protocol mismatch, lease expiry, zero-lease Hook shutdown, and fail-open `Interrupt` behavior have dedicated integration coverage.
- The release plugin uses the documented direct MCP server map; release CI rebuilds the native bridge from reviewed C# source, pins Actions to full commit SHAs, derives artifact names from `package.json`, and installs dependencies only from the official npm registry.
- Production dependency audit reported zero vulnerabilities.
- The plugin ZIP is deterministic and contains only its 13-file whitelist.
- Secret, absolute developer-path, cache/junk, and plugin-payload scans were clean.
- The final bounded security/release fix re-review approved the complete remediation range with no remaining material findings.

Local artifacts:

- `release/Codex-Progress-HUD-Setup-0.2.0.exe` — SHA-256 `5e1e6799a54fb03f3992a942999b485696175cca9eb52c923dbf2dff9a130769`
- `release/codex-progress-hud-plugin-0.2.0.zip` — SHA-256 `c6536c8725b303df56f19efa168f2292f2c809f1afc5132452d144fd503d3434`
- `release/SHA256SUMS.txt`

The installer and native bridge are intentionally unsigned at this stage. They have not been installed, pushed, tagged, published, or uploaded. See `docs/INSTALL-WINDOWS.md` and `docs/RELEASE-CHECKLIST.md` before public distribution.
