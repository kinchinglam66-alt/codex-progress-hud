# Codex Progress HUD 0.2.0 local release verification

Date: 2026-09-04

The unified one-switch automatic-tracking architecture is implemented and locally packaged for Windows x64. Enabling the Codex plugin allows Hooks and MCP leases to start tracking automatically; disabling/uninstalling the plugin stops new activity and lets the companion exit after the final lease grace period. Window show/hide and per-task pause/resume/stop remain presentation/timing controls, not plugin or Codex execution controls.

Release readiness evidence:

- 36 test files and 545 tests passed in the serialized release gate.
- The packaged HUD passed health, bearer authentication, 14-tool MCP discovery, and controlled shutdown.
- The release plugin's native bridge passed real MCP initialize and `tools/list` without global Node.
- Automatic new-task tracking, late attachment, two-session owner isolation, protocol mismatch, lease expiry, and fail-open Hook behavior have dedicated integration coverage.
- Production dependency audit reported zero vulnerabilities.
- The plugin ZIP is deterministic and contains only its 13-file whitelist.
- Secret, absolute developer-path, cache/junk, and plugin-payload scans were clean.

Local artifacts:

- `release/Codex-Progress-HUD-Setup-0.2.0.exe` — SHA-256 `98800d8af34e5821b097ddb123f2211f1618977e29b0b4becfe5ff97e451e220`
- `release/codex-progress-hud-plugin-0.2.0.zip` — SHA-256 `ee42f117caf91c9b81ac21123ea8b4447c5d59a70e389256e0ea66dabf0db98f`
- `release/SHA256SUMS.txt`

The installer and native bridge are intentionally unsigned at this stage. They have not been installed, pushed, tagged, published, or uploaded. See `docs/INSTALL-WINDOWS.md` and `docs/RELEASE-CHECKLIST.md` before public distribution.
