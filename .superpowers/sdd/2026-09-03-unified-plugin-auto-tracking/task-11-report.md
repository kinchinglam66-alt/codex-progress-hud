# Task 11 report — Node-free Windows release and end-to-end verification

Date: 2026-09-04

## Outcome

Task 11 is implemented on `feat/unified-plugin-auto-tracking`. The Windows x64 companion, release plugin ZIP, marketplace metadata, Hooks, MCP launcher, CI/release workflows, installation guidance, and automatic-tracking integration tests are present. Nothing was installed into Codex, published, pushed, or uploaded.

Implementation commits:

- `f5c0184` — `build: package Windows companion and release plugin`
- `d3c108b` — `fix: normalize release plugin text files`
- `adbe42a` — `test: verify automatic tracking release contract`
- `4856141` — `docs: record task 11 release evidence`

## Important architecture correction

The detailed older packaging plan expected PowerShell to own the long-lived MCP stdio stream. A new streaming test proved that Windows PowerShell waits for redirected stdin EOF in this launch shape, so MCP initialize timed out while one-shot Hook input still worked. The release `.mcp.json` therefore invokes the checked-in 9 KB native C# bridge directly. Its source is `build/native-launcher.cs`; it strictly validates `%APPDATA%\codex-progress-hud\install.json`, checks the exact installed EXE and `resources/app.asar`, sets `ELECTRON_RUN_AS_NODE=1`, and relays UTF-8 JSON lines without requiring global Node. Both requested PowerShell launchers remain staged and validated for compatibility/manual diagnostics.

The plugin manifest intentionally omits an unsupported `hooks` property. Codex discovers the conventional `hooks/hooks.json` file. The `.mcp.json` now uses Codex's documented direct server map rather than the legacy `mcpServers` wrapper. This matches the installed plugin-creator validator's allowed manifest keys and avoids the earlier plugin/tool-visibility risks.

The final release/security review initially rejected the range. Its seven findings were addressed with regression coverage: direct-map MCP configuration, Hook-started zero-lease shutdown, registered fail-open `Interrupt`, release-time native-bridge recompilation plus binary integrity stamping, SHA-pinned GitHub Actions and official npm registry URLs, generated Hook-client versioning, and version-derived release artifact paths. A follow-up contract check also made both successful and fail-open `Interrupt` executions emit `{}`, avoiding unsupported turn-control fields. The local .NET Framework compiler does not produce byte-for-byte identical EXEs across rebuilds, so the project does not claim reproducible native builds; the release job instead compiles from reviewed source every time.

## Artifacts

All paths are relative to the worktree and are ignored build outputs:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `release/Codex-Progress-HUD-Setup-0.2.0.exe` | 112,969,968 | `5e1e6799a54fb03f3992a942999b485696175cca9eb52c923dbf2dff9a130769` |
| `release/codex-progress-hud-plugin-0.2.0.zip` | 44,294 | `c6536c8725b303df56f19efa168f2292f2c809f1afc5132452d144fd503d3434` |
| `release/SHA256SUMS.txt` | 203 | contains both hashes above |

`Get-AuthenticodeSignature` reports `NotSigned`, as disclosed in the installation and security documentation.

## Verification evidence

- `npm run verify:release` — PASS: 36 test files / 551 tests, typecheck, build, source smoke, native-launcher integrity, plugin synchronization, plugin validation, and package contract.
- `npm run smoke:packaged` — PASS: packaged HUD health/authentication, MCP connection, all 14 tools, and shutdown. Five consecutive runs passed after the harness was isolated and made to await Electron exit.
- `npm run diagnose:mcp:packaged` — PASS: real release bridge completed MCP initialize and `tools/list` with 14 tools.
- `npm run release:artifacts` — PASS: NSIS installer, deterministic whitelist ZIP, and checksum file.
- ZIP reproducibility — PASS: two consecutive packages produced the same hash and exactly 13 whitelisted entries.
- Lifecycle cleanup stress — PASS: 12 consecutive runs of the three previously timing-sensitive branches.
- `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org` — PASS: 0 production vulnerabilities.
- `git diff --check`, secret-pattern scan, absolute developer-path scan, plugin payload scan, and unexpected-root-directory scan — PASS after normalizing two release text files, anonymizing three old report/plan paths, and removing test-generated spelling-cache directories.

The packaged smoke harness uses `--no-sandbox`, `--disable-gpu`, and `--in-process-gpu` only because it runs Electron inside an already restricted automated host. Production keeps `sandbox: true`, context isolation, no renderer Node integration, disabled hardware acceleration, and no spellcheck; these settings are independently covered by unit tests.

## Known limitations

- The local installer and native bridge are unsigned. Public releases should add trusted Authenticode signing.
- Windows 10/11 x64 is the only packaged target in 0.2.0.
- Codex currently provides no supported persistent custom sidebar surface, so the durable UI is the floating HUD plus MCP tool results.
- Codex `Interrupt` Hooks provide authoritative user-interruption evidence. Missing heartbeats and lease loss remain suspected evidence and are never labeled verified completion.
- An older conversation can attach on its first post-install observed Hook, but elapsed time before attachment is not reconstructed.
- The installed official Python plugin validator could not execute in this host because its Python runtime lacked PyYAML. The repository validator, package contract, plugin-creator manifest-key ruling, and real MCP launch were all exercised instead. A real Codex marketplace install/enable/restart remains an explicit pre-publication acceptance step.

## Publication boundary

No Codex cache installation, companion installation, GitHub push, Git tag, GitHub release, or marketplace publication was performed. Those remain separate user-authorized actions.
