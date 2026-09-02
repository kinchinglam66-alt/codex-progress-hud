# Task 1 Report — Generation-bound launch and one-shot tracking activation

## Outcome

Implemented the Task 1 correction on baseline `687342c`: manager launches now carry a generation-bound, non-explicit intent, and a write invocation can acquire an activation-capable lease only once. Manual off remains authoritative over stale manager startup and stale cross-process `tracking_start` retries.

## Root cause

Two paths reinterpreted old work as a new explicit activation:

1. `createProcessLauncher()` spawned the desktop with only `--hud`. The entry parser correctly treats plain `--hud` as explicit, so a manager child arriving after another process committed off called `setDesiredState("on")` and created a newer generation.
2. `CompanionManager.executeWrite()` handled both `OFFLINE` and `GENERATION_REJECTED` by calling `ensureForWrite(reason)` again. For `tracking_start`, that helper is intentionally activation-capable, so a stale pre-close write could observe off, create a second on generation, and retry its event.

The existing generation checks protected runtime publication and server mutations but could not protect persisted intent while these two callers were allowed to acquire a new generation.

## RED

Before production changes, added behavior tests naming the concrete breaks:

- a real process launcher omitted `--manager-generation=7`;
- entry parsing treated valid, malformed, and duplicate manager-generation inputs as explicit HUD launches;
- manager-intent desktop startup published after off or a generation mismatch;
- manager-launched second-instance activation was treated as explicit;
- a second real manager could close while `tracking_start` was in flight, after which the first manager reacquired activation;
- two real MCP stdio processes reproduced the stale `tracking_start` race through the real HTTP generation guard.

Command:

`npm test -- --run tests/desktop/entry-mode.test.ts tests/desktop/lifecycle.test.ts tests/lifecycle/companion-manager.test.ts tests/integration/companion-lifecycle.test.ts`

Observed RED: exit 1; 4 files failed; 12 failed and 74 passed. Failures showed explicit intent instead of manager intent, missing launcher generation argument, desktop publication under stale manager intent, an uncaught/retried generation rejection, and cross-process result/state no longer suppressed/off.

## GREEN implementation

- `ProcessLauncher.spawnHud(executablePath, { generation })` now launches with `--hud --manager-generation=<generation>`.
- `selectEntryIntent()` accepts exactly one decimal safe non-negative manager generation and rejects malformed or duplicate occurrences.
- `DesktopLaunchReason` is discriminated into explicit, automatic-login, and manager-generation cases.
- Manager desktop startup quits before runtime/server/window publication unless settings are exactly `on` at the leased generation; it never calls `setDesiredState("on")`.
- A manager-launched second Electron instance is not reinterpreted as explicit activation. Plain second-instance behavior remains explicit.
- `executeWrite()` captures `writeGeneration` once. `GENERATION_REJECTED` is never retried. `OFFLINE` may call `ensureRunningOnce(writeGeneration)` once, but only while that exact generation remains on. No recovery path calls activation-capable `ensureForWrite()` a second time.
- Added a real-manager characterization proving OFFLINE recovery retries once with the same generation.

## Verification

- Focused Task 1 GREEN: exit 0; 4 files passed; 89/89 tests passed.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0.
- Full regression `npm test -- --run`: exit 0; 18 files passed; 278/278 tests passed.

The full suite includes the public stdio tool-catalog test, preserving all 13 tools and JSON-RPC-only stdout. Existing server generation-guard, privacy, runtime PID/nonce, and automatic-login tests remained green.

## Files changed

- `src/lifecycle/process-launcher.ts`
- `src/main.ts`
- `src/desktop/lifecycle.ts`
- `src/lifecycle/companion-manager.ts`
- `src/lifecycle/types.ts`
- `src/mcp/tools.ts`
- `tests/desktop/entry-mode.test.ts`
- `tests/desktop/lifecycle.test.ts`
- `tests/lifecycle/companion-manager.test.ts`
- `tests/integration/companion-lifecycle.test.ts`
- `.superpowers/sdd/2026-09-02-lifecycle-residual-corrections/task-1-report.md`

## Self-review

- Mutation check: removing the manager CLI argument, accepting malformed/duplicate generations, changing either manager rejection branch to proceed, reacquiring `ensureForWrite()` during retry, changing the retry generation, or submitting a second event after 409 is covered by a focused behavior test.
- Real-boundary check: launcher argument construction uses the real launcher; desktop behavior runs the real lifecycle function; stale tracking uses two real MCP child processes, a real state store, real HTTP server/client, and the server-side generation guard.
- Scope check: automatic-login behavior, explicit plain `--hud`, plain second-instance activation, server mutation guards, tool registration/count, stdout, privacy, PID, and nonce semantics were not changed.

## Concerns

None for Task 1. The unrelated residual findings I1, I3, and M2 remain outside this task by design.

## Review fix round 1

### Findings addressed

1. Entry parsing now accepts manager generation only as the complete, non-conflicting `--hud --manager-generation=<safe integer>` form. A manager generation combined with `--mcp-stdio` or `--automatic-login`, or provided without `--hud`, throws `Invalid manager launch arguments`; manager intent can no longer override MCP mode.
2. The real two-MCP race now gates `/api/shutdown` at the proxy before it reaches the target. After observing persisted off, the test releases the stale event first, waits for its rejected tool result, and only then releases shutdown. A category-only guard-call record proves the stale on-generation request reached the real `LifecycleStateStore.runIfGeneration` while the target had not entered its shutdown mutation.

### Root causes

- `selectEntryIntent()` validated a manager-generation value and returned manager HUD intent before checking the surrounding mode/reason flags.
- The original race waited for the target shutdown callback before releasing the event. That callback runs only after the server sets `shuttingDown`, so the event was rejected by the shutdown latch before the state-store generation guard could run.

### RED / GREEN evidence

- Parser RED: `tests/desktop/entry-mode.test.ts` failed all 3 new conflict rows while the prior 12 tests passed. GREEN: 15/15 passed after adding the complete/non-conflicting combination check.
- Generation-guard mutation RED: with the target's `runIfGeneration` option removed, the stale event was accepted and the expected suppressed structured result was absent; integration result was 1 failed / 2 passed.
- Generation-guard GREEN: restoring the real guard through a recording wrapper produced 3/3 integration passes and recorded the stale `{ generation: on.generation, desiredState: "on" }` call.

### Verification

- Focused Task 1: 4 files, 92/92 passed, exit 0.
- Full suite: 18 files, 281/281 passed, exit 0.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0.

### Files changed in review fix round 1

- `src/main.ts`
- `tests/desktop/entry-mode.test.ts`
- `tests/integration/companion-lifecycle.test.ts`
- `.superpowers/sdd/2026-09-02-lifecycle-residual-corrections/task-1-report.md`

### Review-round self-check and concerns

- Removing the parser conflict gate fails all three new table rows.
- Removing or bypassing the server generation guard makes the cross-process stale event test fail through consumer-visible acceptance, not source inspection.
- Shutdown remains blocked outside the target until the stale tool result settles, so `shuttingDown` cannot mask the intended assertion window.
- No production behavior outside entry-intent validation changed in this round. No new privacy payloads are captured; guard evidence records only generation and desired state.
- Concerns: none.
