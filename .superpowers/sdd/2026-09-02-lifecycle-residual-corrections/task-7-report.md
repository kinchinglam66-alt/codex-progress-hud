# Task 7 Report — Generation-aware hide and successor-safe runtime cleanup

Date: 2026-09-02

Baseline: `de22fb38ce72c3fcdf8298943f0703e0f344a9e4`

## Outcome

The two Important findings from final re-review round 2 are addressed in the Task 7 candidate. Production hide requests carry a currently validated on generation and stale rejection converges to current lifecycle truth. Manager close cleanup is generation-scoped and target-identity-scoped in one store lock, so an older close cannot clear an explicitly reopened successor even when PID and nonce are identical.

This report records implementation and self-verification. Independent whole-correction re-review remains required before any packaging decision.

## Root causes

- `hide()` observed a live HUD but discarded the associated lifecycle generation and called the guarded HTTP mutation without `x-codex-progress-hud-generation`. The production server therefore returned 409, and the error escaped instead of converging through lifecycle state.
- Every successful manager close path called `clearRuntime(undefined)` after observing offline or terminating an owned process. The clear acquired a separate lock and did not validate the close's off generation or target runtime, allowing G+1 publication to be unlinked.
- The source-mode delegated client dropped all request options, and the stdio fixture had no current on setting or generation validation, so existing integration coverage could not detect the production hide failure.

## RED

Command:

`npm test -- --run tests/lifecycle/companion-manager.test.ts -t "sends the current on generation|returns current lifecycle truth|older close clear"`

Result:

- Exit 1; 3 failed and 48 skipped.
- Real headerless hide received `GENERATION_REJECTED`, and manager hide received the same rejection.
- Raced hide rejected instead of returning the successor snapshot.
- The old close returned off/stopped and deleted the G+1 same-PID/same-nonce runtime.

## GREEN

### Hide

`hide()` uses the original startup deadline to observe the HUD, read current settings, require `desiredState: "on"`, and send the exact generation to `CompanionHttpClient.hide()`. A server-side generation rejection triggers a fresh observation. The real guarded server/store test first proves a headerless request is rejected, then proves manager hide invokes the callback once. The race test commits off and a successor on generation before request submission; the stale hide remains rejected, the callback is not invoked, and the returned snapshot is the visible running successor.

### Runtime cleanup

`LifecycleStateStore.clearRuntimeIfGeneration()` acquires the normal lifecycle lock and, without releasing it, verifies:

1. settings are still the exact close generation;
2. desired state is still off;
3. the persisted runtime is the full expected identity.

Only then does it call the existing `clearUnlocked()` path, preserving deadline abort checks, mutation-entry timing, and final dev/inode identity protection. A missing runtime is accepted as already clear only while the close generation remains current/off.

Manager close captures its target runtime immediately after committing off and supplies it to the atomic operation in initial-offline, graceful-offline, and owned forced-termination paths. Rejection returns a current observation and never records `shutdown_complete`. Existing timeout behavior remains intentionally non-clearing and retains runtime evidence.

Deterministic tests cover initial offline, graceful shutdown, forced termination, exact-identity mismatch, stale generation, and timeout retention. The successor races reuse the same PID and nonce, so identity-only protection cannot satisfy them.

## Verification

| Command | Result |
|---|---|
| Focused manager/state/server/desktop | Exit 0; 4/4 files, 156/156 tests; Vitest duration 13.19 s. |
| Source-mode integration | Exit 0; 1/1 file, 3/3 tests; Vitest duration 4.47 s. |
| `npm test -- --run` | Exit 0; 18/18 files, 321/321 tests; final Vitest duration 10.50 s. |
| `npm run typecheck` | Exit 0. |
| `npm run build` | Exit 0. |
| `npm run smoke` | Exit 0; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test; exact tool catalog and protocol-only child stdout verified. |
| `npm run validate:plugin` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

## Scope

- No package, install, merge, push, or release action was performed.
- No MCP tool registration or public payload schema changed.
- No response-size, privacy, executable-containment, or PID/nonce termination-ownership rule changed.
- Independent final whole-correction re-review remains open.
