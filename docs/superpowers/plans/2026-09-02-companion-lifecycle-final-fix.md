# Companion Lifecycle Final Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This execution is explicitly single-agent; do not dispatch subagents.

**Goal:** Resolve all 1 Critical, 6 Important, and 5 Minor final-review findings while preserving the Tasks 1–8 behavior and release budgets.

**Architecture:** Persist a monotonically increasing lifecycle generation with desired state and serialize all lifecycle-file operations behind one cross-process lock. Carry the accepted generation from `CompanionManager` through each mutating HTTP request; the desktop server commits show/event/shutdown side effects only while holding the same lifecycle lock and only when the request generation/state remains current. Bound every HTTP request and JSON response, and make desktop launch intent explicit (`explicit` versus `automatic-login`).

**Tech Stack:** TypeScript 7, Node.js 22+, Electron 44, Zod 4, Vitest 4, MCP SDK 1.30.

**Spec:** `docs/superpowers/specs/2026-09-01-companion-lifecycle-release-design.md`

## Global Constraints

- Plain `--hud` and second-instance launches are explicit user activation.
- Start-with-Windows uses a distinct automatic-login argument and remains unchecked by default.
- Automatic login with persisted `desiredState: off` exits before runtime, server, or window publication.
- Startup and close remain bounded to 8 seconds and 5 seconds respectively.
- Preserve all thirteen tools, clean stdout, diagnostic privacy, loopback/authentication boundaries, and existing Tasks 1–8 semantics.
- Every production change follows a witnessed RED, minimal GREEN, and focused regression run.

---

### Task 1: Cross-process lifecycle state and strict persistence

**Files:**
- Create: `src/lifecycle/state-lock.ts`
- Modify: `src/lifecycle/state-store.ts`
- Modify: `src/lifecycle/types.ts`
- Test: `tests/lifecycle/state-store.test.ts`
- Create: `tests/fixtures/state-store-worker.mjs`

**Interfaces:**
- `HudSettings` gains required non-negative integer `generation` in memory; legacy files may omit it and normalize to `0`.
- `setDesiredState(state)` atomically increments generation and returns the committed settings.
- `setStartWithWindows(enabled)` persists the preference under the same lock.
- `writeRuntime(identity, generation)` returns `true` only if the same generation is still desired on.
- `runIfGeneration(generation, desiredState, operation)` holds the lifecycle lock across validation and the supplied side effect.

- [x] Add table-driven schema tests for extra keys, invalid PID/protocol/timestamp/nonces/versions, and invalid install paths; run the focused test and record the expected failures.
- [x] Add a real child-process stress test that overlaps settings reads/writes and runtime write/clear, asserting no `EPERM`, valid final JSON, and no `.tmp`/lock residue; run it RED.
- [x] Implement a bounded owner-identified cross-process lock, Windows sharing retries, identity-aware unlink, and exact-temp cleanup.
- [x] Make every read/write/delete use the shared lock and add generation-aware state operations.
- [x] Run `vitest --run tests/lifecycle/state-store.test.ts` GREEN and typecheck.

### Task 2: Deadline-bounded HTTP and exact identity classification

**Files:**
- Modify: `src/mcp/report-client.ts`
- Test: `tests/mcp/report-client.test.ts`
- Test: `tests/lifecycle/companion-manager.test.ts`

**Interfaces:**
- Each client method accepts an optional request budget carrying remaining milliseconds and optional generation.
- Responses are read through one bounded JSON reader; no raw response content enters errors.
- Identity classifies any completed non-exact HTTP response as `PORT_CONFLICT`, exact service with incompatible protocol as `VERSION_MISMATCH`, and only transport/abort failure as `OFFLINE`.

- [x] Add 404/500/HTML/empty/malformed/incompatible identity tables plus hanging and oversized listener tests; verify RED.
- [x] Add manager wall-clock startup/close tests against hanging requests; verify RED.
- [x] Implement AbortController deadlines and bounded streaming JSON reads.
- [x] Pass operation remaining budgets from manager probes/controls and cap sleeps to operation deadlines.
- [x] Run report-client and manager focused tests GREEN.

### Task 3: Authoritative generation and close/write ordering

**Files:**
- Modify: `src/lifecycle/companion-manager.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/report-client.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/desktop/lifecycle.ts`
- Test: `tests/lifecycle/companion-manager.test.ts`
- Test: `tests/mcp/tools.test.ts`
- Test: `tests/server/http-server.test.ts`
- Test: `tests/integration/companion-lifecycle.test.ts`

**Interfaces:**
- Ready ensure results carry the accepted generation.
- Manager exposes one coordinated write execution seam so local close can cancel/wait for in-flight startup/write work without allowing stale submit/retry.
- Mutating requests send `x-codex-progress-hud-generation`; server runs show/hide/events for current-on and shutdown for current-off under `runIfGeneration`.
- Server enters a local shutdown state before acknowledging shutdown and rejects later writes.

- [x] Add deterministic RED tests for deferred-spawn close, ensure/submit close, retry close, initial close probe classification, server shutdown rejection, and two independent manager/MCP-equivalent races.
- [x] Implement generation capture/revalidation before runtime publication, show, submit, and retry; terminate only a confirmed locally spawned stale child.
- [x] Implement server generation/shutdown guards and map generation rejection without response-body disclosure.
- [x] Make close return success only for observed `OFFLINE`; preserve desired off and categorized errors otherwise.
- [x] Run manager/tools/server/integration focused tests GREEN.

### Task 4: Desktop launch intent and navigation boundary

**Files:**
- Modify: `src/main.ts`
- Modify: `src/desktop/main.ts`
- Modify: `src/desktop/lifecycle.ts`
- Modify: `src/desktop/window-controller.ts`
- Modify: `src/lifecycle/process-launcher.ts`
- Test: `tests/desktop/entry-mode.test.ts`
- Test: `tests/desktop/lifecycle.test.ts`
- Test: `tests/desktop/window-controller.test.ts`

**Interfaces:**
- `selectEntryIntent(argv)` distinguishes `mcp-stdio`, explicit HUD, and `automatic-login`.
- `runDesktop(dependencies?, launchReason)` defaults to explicit activation.
- Login items use `args: ["--automatic-login"]`; the manager launcher remains plain `--hud`.
- Window creation accepts only an exact loopback HTTP origin, denies every unexpected navigation, and denies all new windows.

- [x] Add RED tests for automatic off/on, explicit off reopen, second-instance explicit activation, exact login args, exact loopback load, external navigation, popups, and complete `WINDOW_OPTIONS`.
- [x] Implement intent plumbing and pre-publication automatic-off exit without enabling login startup by default.
- [x] Implement exact-origin navigation and popup guards with cleanup-safe registration.
- [x] Run desktop focused tests GREEN.

### Task 5: Remaining minor coverage and public stdio seam

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/mcp/tools.test.ts`
- Test: `tests/server/http-server.test.ts`
- Test: `tests/mcp/stdio-server.test.ts`
- Test: `tests/desktop/tray-controller.test.ts`

**Interfaces:**
- `trackingStatus` is receiver independent.
- The stdio test captures a spawned child's public stdout and performs JSON-RPC over stdin without SDK-private fields.

- [x] Add RED receiver-detachment, malformed empty-control payload, and all-tray-action failure tables.
- [x] Replace `_readBuffer` capture with public child process stdin/stdout JSON-RPC and verify clean protocol-only lines.
- [x] Implement the receiver-independent shared status function.
- [x] Run all five focused suites GREEN.

### Task 6: Verification, report, and commits

**Files:**
- Create: `.superpowers/sdd/2026-09-01-companion-lifecycle/final-fix-report.md`

- [x] Run all focused suites and the fresh-process Windows stress test.
- [x] Run the complete suite at least three consecutive times.
- [x] Run the seven-command gate: test, typecheck, build, smoke, MCP diagnose, plugin validation, and `git diff --check`.
- [x] Review the full diff for scope, privacy, stdout, timing, and all 12 findings.
- [x] Write the final report with each RED/GREEN, command/output, files, risks, and self-review.
- [ ] Commit in a small number of logical groups and report only status, commit range, gates, and unresolved items.
