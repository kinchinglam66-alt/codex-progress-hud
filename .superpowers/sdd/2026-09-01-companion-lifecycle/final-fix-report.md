# Companion Lifecycle Final Fix Report

Date: 2026-09-02  
Baseline: `c256ac3`  
Scope: final whole-branch review, 1 Critical + 6 Important + 5 Minor  
Implementation mode: one agent, no delegated or derived agents

## Outcome

All twelve findings are addressed. The lifecycle now uses one cross-process settings/runtime protocol with a monotonic generation. A committed off transition invalidates older startups and writes at runtime publication, window control, event submission, and retry boundaries. HTTP operations have per-request deadlines derived from the remaining startup/shutdown budget and a 64 KiB JSON response limit. Desktop login startup has a distinct launch reason and exits early when desired state is off. Electron navigation and popup boundaries are enforced.

The final verification completed with 264/264 tests passing three consecutive times, followed by the complete seven-command release gate.

## Critical

### C1 — Explicit close overtaken by an older startup/write

- RED: deterministic manager tests reproduced a deferred spawn publishing after close, an ensured write submitting after close, an offline retry after close, and a second independent manager closing the first manager's startup. The real-process integration test froze an event after ensure, closed from a second MCP process, then released the old request.
- GREEN: `HudSettings.generation` is committed with desired-state transitions. Startup revalidates it before runtime publication and show; write operations carry it plus a close-owned abort signal; the HTTP server commits event/window/shutdown mutations only through `runIfGeneration`; shutdown sets a local reject-writes state before callback completion.
- Files: `src/lifecycle/types.ts`, `src/lifecycle/state-store.ts`, `src/lifecycle/companion-manager.ts`, `src/mcp/report-client.ts`, `src/mcp/tools.ts`, `src/server/http-server.ts`, `src/desktop/lifecycle.ts`, manager/server/tools/integration tests.
- Evidence: manager 34/34; real two-MCP race 1/1; full suite 264/264.

## Important

### I1 — HTTP hangs/oversize defeat 8 s and 5 s budgets

- RED: hanging identity/startup, hanging close, non-ending oversized body, and never-resolving launcher tests exceeded the expected operation bound; the launcher case timed out at the test's 2,000 ms ceiling.
- GREEN: every request owns an AbortController deadline derived from remaining operation time; JSON is streamed through a 64 KiB bounded reader; sleeps are clipped to the deadline; launcher wait is raced against the startup deadline and a late stale child cannot publish runtime.
- Files: `src/mcp/report-client.ts`, `src/lifecycle/companion-manager.ts`, `tests/mcp/report-client.test.ts`, `tests/lifecycle/companion-manager.test.ts`.
- Evidence: launcher-hang GREEN in 99 ms with a 90 ms budget; manager 34/34; report client 13/13.

### I2 — Foreign HTTP services misclassified as offline

- RED: identity table cases for 404, 500, HTML, empty JSON body, malformed JSON, wrong service, and incompatible protocol exposed the previous status-first/offline classification.
- GREEN: any established non-exact HTTP identity is `PORT_CONFLICT`; only an exact service with another protocol is `VERSION_MISMATCH`; transport failure/abort is `OFFLINE`. Errors do not include response content.
- Files: `src/mcp/report-client.ts`, `tests/mcp/report-client.test.ts`.
- Evidence: focused hostile-response suite 13/13.

### I3 — Close claims stopped after a failed initial health probe

- RED: initial `AUTH_ERROR`, `VERSION_MISMATCH`, and malformed/unexpected health failures previously followed the success-shaped path.
- GREEN: only `OFFLINE` completes as stopped. Other initial failures return their categorized code while the already committed desired state remains off; shutdown is not falsely reported as complete.
- Files: `src/lifecycle/companion-manager.ts`, `tests/lifecycle/companion-manager.test.ts`.
- Evidence: table-driven initial-close classification cases pass in manager 34/34.

### I4 — Process-local lifecycle-file coordination and unsafe delete

- RED: real child-process contention reproduced Windows sharing risk in the old independent read/write/delete paths.
- GREEN: every settings/runtime/manifest read, settings/runtime write, and runtime delete joins the same local FIFO plus hard-link cross-process lock. The lock has owner PID/token and bigint file identity, stale-owner recovery, bounded Windows sharing retries, and identity-aware unlink. Failed writes clean only their own identity-checked temporary file.
- Files: new `src/lifecycle/state-lock.ts`, `src/lifecycle/state-store.ts`, new `tests/fixtures/state-store-worker.mjs`, `tests/lifecycle/state-store.test.ts`.
- Evidence: six real Node child processes × 20 mixed operations; 25/25 state-store tests; no `EPERM`, valid final JSON, no `.tmp`/lock residue.

### I5 — BrowserWindow navigation/window-open boundary

- RED: external `will-navigate` and popup tests showed no handler, while initial URL validation accepted unapproved shapes.
- GREEN: initial URL must be exactly an HTTP origin on `127.0.0.1` or `[::1]`; later navigation outside that exact origin is prevented; every window-open request is denied; auth injection remains exact-origin scoped.
- Files: `src/desktop/window-controller.ts`, `tests/desktop/window-controller.test.ts`.
- Evidence: desktop/window focused verification included in 93/93 grouped tests and full suite.

### I6 — Automatic desktop startup ignores manual off

- RED: automatic-login off/on and explicit-off reopen tests exposed the prior single undifferentiated HUD launch path.
- GREEN: `selectEntryIntent` distinguishes MCP, explicit HUD, and `automatic-login`. Plain/default `--hud` and second-instance are explicit activation. Automatic-login with desired state off quits before runtime, server, or window publication. Login items use `args: ["--automatic-login"]`; login startup remains disabled by default and its preference is persisted.
- Files: `src/main.ts`, `src/desktop/lifecycle.ts`, `tests/desktop/entry-mode.test.ts`, `tests/desktop/lifecycle.test.ts`.
- Evidence: desktop suites 55/55 in focused verification; full suite 264/264.

## Minor

### M1 — `trackingStatus` receiver binding

- RED: destructuring `trackingStatus` failed because it called `this.taskStatus()`.
- GREEN: one closed-over `taskStatus` function backs both handlers.
- Files: `src/mcp/tools.ts`, `tests/mcp/tools.test.ts`.

### M2 — Strict persisted schemas and semantic invalid-JSON table

- RED/GREEN note: this was a coverage finding. The new semantic-invalid table was written first and passed immediately for several already-strict fields; generation and exact protocol/path constraints were then added with the state protocol. No failing product behavior is claimed where the baseline already rejected the input.
- Coverage: unknown keys, negative generation, fractional PID, empty version/nonce, wrong protocol, malformed timestamp, relative install paths, and extra manifest fields.
- Files: `src/lifecycle/state-store.ts`, `tests/lifecycle/state-store.test.ts`.

### M3 — Empty control payload malformed branches

- RED/GREEN note: this was a direct-coverage gap; malformed, null, array, primitive, and non-empty object cases passed immediately against the existing parser. The tests now prevent regression without inventing a production defect.
- Files: `tests/server/http-server.test.ts`.

### M4 — SDK-private `_readBuffer` in stdout test

- RED: the old test depended on a private SDK receiver field and could not prove the packaged child process emitted protocol-only stdout.
- GREEN: the replacement spawns the built MCP child, communicates by public stdin/stdout JSON-RPC, initializes, lists all 13 tools, and parses every stdout line as JSON-RPC. Repository search finds no `_readBuffer` usage.
- Files: `tests/mcp/stdio-server.test.ts`.
- Evidence: `npm run diagnose:mcp` 1/1; 13 tools observed; clean public stdout.

### M5 — Complete window options and tray failure wrappers

- RED/GREEN note: this was residual coverage. Exact `WINDOW_OPTIONS` and every tray action's sync/async failure wrapper were table-tested; the existing production behavior passed immediately. No unnecessary production rewrite was made.
- Files: `tests/desktop/window-controller.test.ts`, `tests/desktop/tray-controller.test.ts`.

## Verification Evidence

Focused verification:

- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `npx vitest --run tests/lifecycle/state-store.test.ts` — 25/25, including fresh-process Windows stress.
- `npx vitest --run tests/integration/companion-lifecycle.test.ts -t "two real MCP"` — 1/1.
- Six HTTP/server/desktop/stdout suites — 93/93.
- `npx vitest --run tests/lifecycle/companion-manager.test.ts` — 34/34.

Three consecutive complete suites:

1. 18 files, 264/264, 5.87 s.
2. 18 files, 264/264, 5.68 s.
3. 18 files, 264/264, 5.78 s.

Seven-command gate:

1. `npm test -- --run` — 18 files, 264/264, 5.73 s.
2. `npm run typecheck` — exit 0.
3. `npm run build` — exit 0.
4. `npm run smoke` — protocol health, authenticated event flow, and shutdown callback passed.
5. `npm run diagnose:mcp` — 1/1, public child stdout and all tools verified.
6. `npm run validate:plugin` — manifest and MCP launch configuration valid.
7. `git diff --check` — exit 0, no output.

## Risk and Self-review

- Cross-process locking uses hard links and PID liveness. Stale locks are reclaimed only after owner death and exact bigint identity confirmation; malformed lock metadata fails closed. The bounded 5 s acquisition timeout can surface contention instead of silently losing state.
- Generation is optional only for legacy persisted settings and normalizes to zero. Network mutation endpoints require it whenever the desktop supplies the state-store generation guard.
- A launcher that returns after its operation deadline is deliberately detached from the timed-out caller. If its generation has become stale/off it is retired; it cannot publish through the old manager generation.
- Response bodies are never included in errors. Oversized/malformed bodies are categorized without content leakage.
- Start-with-Windows is configured only from the tray action, with the dedicated automatic-login argument; no startup-default change was introduced.
- Reviewed the full diff for Tasks 1–8 semantics, 13-tool registration, stdout cleanliness, log/body privacy, exact loopback auth scope, 8/5-second budgets, and unrelated changes. No unresolved finding or high-risk Minor conflict remains.

