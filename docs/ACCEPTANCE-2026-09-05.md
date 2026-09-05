# Local acceptance: MCP lease fallback

Scope: Windows companion 0.2.1 and local plugin 0.2.1+codex.20260905020923, loaded after restarting Codex and continuing an existing conversation. This is a local acceptance record, not a public release announcement.

## Observed results

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Start tracking without a supplied task handle | Passed | Installed MCP tool returned ok, associationSource=mcp_lease |
| Report phase and current step | Passed | Installed tool accepted report; snapshot showed supplied phase and running state |
| Start / pause / resume / stop / status | Passed for nonterminal task | Snapshot transitions running → paused → running → stopped → running |
| Report an ETA range | Accepted | Snapshot contained model estimate and confidence; visual rendering not inspected |
| Verified completion | Passed | Prior validation_passed evidence followed by succeeded_verified |
| Required Hook activity | None observed | hooks.activitySeen=false throughout successful reporting |
| Companion health | Passed | hud_status observedState=running, companionVersion=0.2.1 |
| Cross-process lease isolation and expired explicit lease recovery | Passed | Focused real-process integration tests: 2 passed, 12 intentionally skipped; test-owned server |
| Start new work after verified completion | Failed in installed build | start/report returned ok but snapshot remained succeeded_verified |

## Acceptance limitation

Terminal restart was a release-blocking usability defect discovered during sequential use. The reducer correctly preserved terminal history, but the process-static fallback still targeted that history. Commit `d06f831` now allocates a fresh fallback on an explicit start after terminal completion and preserves the old record. Installed-runtime reload remains required.

Window visibility, live host disable/uninstall behavior, and the final patched runtime must not be inferred from tool success or isolated unit tests. No screenshot-based visual inspection was performed in this acceptance run.

## Patched artifact verification

- `npm run verify:release`: passed, 40 test files and 623 tests; typecheck, build, authenticated service smoke, launcher integrity, plugin synchronization/validation and package contract all passed.
- `npm run release:artifacts`: passed after granting access to download required build resources.
- `npm run smoke:packaged`: passed against rebuilt 0.2.1 artifact, including terminal completion followed by a fresh running task and preserved old completion. Before rebuilding, the same assertion failed on the old artifact (RED/GREEN evidence).
- `npm run diagnose:mcp:packaged`: passed, native installed-launcher path, 14 tools and handle-free reporting.
- Packaged desktop tests ran serially with the installed HUD temporarily closed. When the installed HUD was running, its Electron single-instance lock prevented the isolated smoke desktop from starting; this is a known local test constraint.

These results do not claim that the current Codex process hot-reloaded the new runtime or that the package is publicly released.

## Installed runtime after final host restart

The existing conversation loaded plugin `0.2.1+codex.20260905024605` after a full host restart. Handle-free start and progress writes returned `running`. A passing validation followed by verified completion produced a terminal record. A subsequent handle-free start/report created a second record: the previous record remained `succeeded_verified`, the new record was `running`, and the new record had no inherited verification evidence. All writes returned `associationSource=mcp_lease` and success. This closes the installed-runtime terminal-restart checkpoint; it is a tool/snapshot observation, not screenshot-based visual inspection.
