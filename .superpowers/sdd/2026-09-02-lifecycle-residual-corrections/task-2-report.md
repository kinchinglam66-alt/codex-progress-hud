# Task 2 Report — End-to-end deadlines and truthful request timeout

## Outcome

Closed residual findings I1 and I3 on baseline `f143498`: lifecycle manager operations now use one absolute deadline across process-local queueing, cross-process lock acquisition, state-store access, and HTTP requests. A client-owned request deadline is `REQUEST_TIMEOUT`, while a connection failure remains `OFFLINE`. Close no longer treats a live non-responsive listener as stopped or records shutdown completion for it.

## Root cause

1. `state-lock.ts` owned a fixed five-second acquisition timeout, and `LifecycleStateStore` exposed no operation budget. Manager deadlines therefore began before state access but could not constrain local queue or lock waits.
2. `CompanionHttpClient` mapped every fetch/read abort to `OFFLINE`. `close()` interpreted that code as positive evidence of stopped state, cleared runtime, logged `shutdown_complete`, and returned a code-free stopped snapshot.
3. The first timeout implementation exposed a narrow cancellation race: the caller's local deadline promise could settle before the underlying acquire loop observed expiry, allowing a late lock acquisition and mutation after the timeout result.

## RED evidence

The Task 2 focused command was run after behavior tests were added and before production changes:

```text
npm test -- --run tests/lifecycle/state-store.test.ts tests/lifecycle/companion-manager.test.ts tests/mcp/report-client.test.ts
```

Result: exit 1; 5 failed and 72 passed. The production failures were:

- real-lock `open()` and close-time runtime clear rejected only after about 5.3 seconds with `lifecycle state lock timed out`, instead of resolving inside the 90ms operation budget;
- the real hanging listener returned a code-free stopped close snapshot rather than `SHUTDOWN_TIMEOUT`;
- the HTTP client returned `OFFLINE` instead of `REQUEST_TIMEOUT` for its own timer;
- after correcting one test-fixture cleanup typo, the isolated real-lock store RED took `5013ms`, failing the required `<300ms` assertion.

The stronger successor mutation test later caught the cancellation race: after the caller timed out, the stale write acquired the released lock and changed the child-written successor settings from `off/generation 2` to `on/generation 3`. The acquire path was then made abort-aware before and immediately after lock publication.

## GREEN implementation

- Added optional `StateOperationOptions { timeoutMs?: number }` to every lock-taking state-store operation.
- The store establishes its deadline at method entry, bounds process-local queue waiting, passes the remaining budget to the cross-process lock, and aborts the underlying queued acquire when the caller settles on timeout.
- Lock acquisition uses the lower of 5 seconds and the caller budget. Zero/expired/aborted acquisition fails before the protected operation; an abort racing with hard-link publication removes only the same owned inode.
- Manager deadlines are created before the first store access and every manager store/HTTP call receives `Math.max(0, deadline - now())`.
- Startup readiness treats `REQUEST_TIMEOUT` as retryable only while its absolute budget remains and ends as `START_TIMEOUT`.
- Close maps request timeout and state deadline expiry to `SHUTDOWN_TIMEOUT`, keeps desired state off when that transition was committed, retains runtime without an offline observation, and emits `shutdown_timeout` rather than `shutdown_complete`.
- Owned-process forced shutdown reserves remaining budget for its final identity-safe runtime clear.

## Elapsed assertions

- Store real-lock budget: injected `90ms`; caller must reject in `<300ms`; after the child writes successor settings and releases the lock, a `150ms` observation window proves no delayed mutation.
- Complete manager open: injected `90ms`; must resolve `START_TIMEOUT` in `<300ms`; child writes successor off-generation settings and runtime before unlock, followed by a `150ms` no-late-publication check.
- Complete manager close runtime clear: injected `90ms`; must resolve `SHUTDOWN_TIMEOUT` in `<300ms`; child writes successor runtime before unlock, followed by a `150ms` no-late-delete check.
- Real hanging HTTP listener: close uses `90ms`, settles in `<300ms`, retains runtime, and does not log `shutdown_complete`.

## Verification

- Focused Task 2: exit 0; 3 files passed; 77/77 tests passed.
- `npm run typecheck`: exit 0; no TypeScript errors.
- `git diff --check`: exit 0; no whitespace errors.
- Full regression: exit 0; 18 files passed; 284/284 tests passed.

The full suite includes the public stdio catalog check for all 13 tools. Existing 64 KiB response bounding, sanitized client errors, generation guards, atomic cleanup ownership, and runtime PID/nonce identity tests remained green.

## Files changed

- `src/lifecycle/state-lock.ts`
- `src/lifecycle/state-store.ts`
- `src/lifecycle/types.ts`
- `src/lifecycle/companion-manager.ts`
- `src/mcp/report-client.ts`
- `tests/helpers/lifecycle-lock-holder.ts`
- `tests/lifecycle/state-store.test.ts`
- `tests/lifecycle/companion-manager.test.ts`
- `tests/mcp/report-client.test.ts`
- `.superpowers/sdd/2026-09-02-lifecycle-residual-corrections/task-2-report.md`

## Self-review

- Every `dependencies.store` call in the manager was enumerated and carries the relevant absolute deadline; status, hide, diagnose, open, write recovery, stale-spawn cleanup, and close do not silently reintroduce unbounded store waits.
- The real child-process lock fixture implements the production lock record/hard-link shape and writes successor files while still owning the lock, so the tests fail if caller timeout is ignored or stale work continues after timeout.
- `REQUEST_TIMEOUT` remains an internal client category and is never exposed as a public lifecycle error. `OFFLINE` retains its original connection-failure meaning and remains the only initial-close condition that can support code-free stopped completion.
- Manager diff churn was reduced by extracting shared runtime-clear deadline handling and shutdown-timeout reporting; remaining repeated options are explicit boundary propagation rather than duplicated policy.
- No tool registration, task payload, response-body logging, token handling, canonical timestamp behavior, packaging, installation, merge, push, or release code was changed.

## Concerns

One first full-suite run had the pre-existing 500ms pending-logger timing test finish at 534ms under parallel load; its focused run and the next fresh full suite passed. No product assertion failed on the successful full run. This is recorded as test timing sensitivity, not an open Task 2 correctness blocker.

---

## Review fix round 1

### Findings addressed

1. A matching owned HUD whose `terminate()` promise never settles is now raced against the same absolute shutdown deadline. Timeout returns `SHUTDOWN_TIMEOUT`; runtime is retained and `shutdown_complete` is not recorded.
2. State-operation timeout now has a provable post-acquisition commit boundary. An entered operation receives abort and must settle before the caller receives timeout; built-in rename/unlink paths check cancellation immediately before every irreversible attempt. A queued operation that has not entered may still return promptly because its aborted continuation cannot acquire or mutate.
3. External request cancellation is `REQUEST_CANCELLED`, distinct from both the client's own `REQUEST_TIMEOUT` and a real connection-failure `OFFLINE`. First abort cause wins, and manager mapping cannot route cancellation through the code-free stopped path.
4. A timeout from the final `show()` request is converted to a public `START_TIMEOUT` snapshot with the persisted desired state, rather than rejecting with an internal client code.

### RED evidence

All four review tests were added before production changes and run together:

```text
npm test -- --run tests/lifecycle/state-store.test.ts tests/lifecycle/companion-manager.test.ts tests/mcp/report-client.test.ts -t "post-acquisition|external cancellation|final show request timeout|matching owned HUD terminate"
```

Result: exit 1; 4 failed and 77 skipped.

- I1: the 300ms watchdog won because `close()` remained blocked in the never-settling `terminate()` promise.
- I2: the guarded callback set `committed` to true after the timeout result and later gate release.
- I3: the real hanging listener's external abort returned `OFFLINE` instead of `REQUEST_CANCELLED`.
- I4: `open()` rejected with internal `HudClientError { code: "REQUEST_TIMEOUT" }` instead of resolving a `START_TIMEOUT` snapshot.

An additional process-local queue RED returned `{ kind: "watchdog" }` after 300ms instead of the expected 40ms timeout while queued behind an entered guarded callback. This established the safe distinction between pre-entry timeout and post-entry cancellation.

### Cancellation and commit contract

`StateMutationOperation<T>` now requires an `AbortSignal`. Its public contract requires the callback to stop before starting irreversible side effects after abort and to settle promptly. Once the protected operation has entered, the store does not independently race a timeout response ahead of that operation; it aborts, waits for the callback/filesystem operation to terminate, performs the final lock-level abort check, and only then returns `LifecycleStateTimeoutError`.

For built-in persistence, cancellation is checked before temporary-file creation, before every atomic rename attempt, before target identity deletion, and before every identity-aware unlink attempt. A filesystem call already started before expiry is awaited; no later rename/unlink can begin after expiry, and no operation remains capable of committing after the timeout result is returned. Lock cleanup keeps its existing inode/token ownership checks.

If an operation is still queued and has not entered, the timeout may return immediately: its queued continuation sees the aborted signal before acquisition and cannot mutate. The original separate-process held-lock and successor tests remain in place and green.

### GREEN evidence

- Review-focused Task 2: exit 0; 3 files passed; 82/82 tests passed.
- Server/desktop/integration contract boundary: exit 0; 3 files passed; 64/64 tests passed.
- Full regression: exit 0; 18 files passed; 289/289 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0.

Elapsed assertions remain strict: owned terminate, post-acquisition cancellation, process-local queue timeout, external request cancellation, and all existing 90ms lock/open/close cases must settle in less than 300ms. No threshold was relaxed.

### Files changed in review fix round 1

- `src/lifecycle/companion-manager.ts`
- `src/lifecycle/state-lock.ts`
- `src/lifecycle/state-store.ts`
- `src/lifecycle/types.ts`
- `src/mcp/report-client.ts`
- `src/server/http-server.ts`
- `tests/desktop/lifecycle.test.ts`
- `tests/lifecycle/companion-manager.test.ts`
- `tests/lifecycle/state-store.test.ts`
- `tests/mcp/report-client.test.ts`
- `tests/server/http-server.test.ts`
- `.superpowers/sdd/2026-09-02-lifecycle-residual-corrections/task-2-report.md`

### Self-review and concerns

- Mutation checks fail if terminate is awaited directly, post-acquisition timeout returns before callback termination, a queued aborted operation later mutates, external cancellation maps to `OFFLINE`, or final show timeout escapes.
- The real listener and real separate-process lock tests are retained. The public 13-tool catalog, 64 KiB response limit, privacy-safe errors/logs, generation guards, and PID/nonce ownership behavior remain covered by the full suite.
- Arbitrary `runIfGeneration` callbacks must cooperate with their required `AbortSignal`; this is an explicit API contract rather than an assumption that arbitrary work is cancellable. All first-party guarded callbacks check the signal before mutation.
- No open Critical, Important, or Minor concern was found in the review-fix diff.

---

## Review fix round 2

### Findings addressed

1. `executeWrite` now consumes `REQUEST_CANCELLED` only when the manager-owned write controller was aborted. It returns the existing stale result, which becomes `MANUALLY_DISABLED` after close commits desired state off. It does not retry, spawn, show, or reactivate the HUD. A cancellation not caused by that controller is still rethrown rather than being mistaken for an offline recovery signal.
2. `CompanionHttpClient` now records abort cause through one first-writer-wins function. An already-aborted external signal is claimed before the local deadline is armed, including when `timeoutMs` is zero. Later external aborts or deadline callbacks cannot overwrite the established cause.

The resulting precedence is deterministic: pre-aborted external and external-first are `REQUEST_CANCELLED`; own-timer-first is `REQUEST_TIMEOUT`; connection refusal without abort remains `OFFLINE`.

### RED evidence

The manager cancellation and abort-precedence tests were changed before production code and run with:

```text
npm test -- --run tests/lifecycle/companion-manager.test.ts tests/mcp/report-client.test.ts -t "request-cancelled|pre-aborted|own deadline|external cancellation|network refusal"
```

Result: exit 1; 2 failed, 4 passed, and 49 skipped.

- The in-flight write rejected with `HudClientError { code: "REQUEST_CANCELLED" }` instead of resolving `{ kind: "suppressed", code: "MANUALLY_DISABLED" }`.
- A pre-aborted signal with `timeoutMs: 0` produced `REQUEST_TIMEOUT` instead of `REQUEST_CANCELLED`.

### GREEN evidence

- Cancellation/precedence target: exit 0; 2 files passed; 6/6 selected tests passed.
- Focused Task 2: exit 0; 3 files passed; 83/83 tests passed.
- Server/desktop/integration boundary: exit 0; 3 files passed; 64/64 tests passed.
- Full regression: exit 0; 18 files passed; 290/290 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0.

The own-timer test arms an external cancellation substantially later than the 75ms client deadline and still requires `REQUEST_TIMEOUT`. The external-first real hanging-listener test retains its `<300ms` assertion. The refusal case has no abort source and remains `OFFLINE`.

### Files changed in review fix round 2

- `src/lifecycle/companion-manager.ts`
- `src/mcp/report-client.ts`
- `tests/lifecycle/companion-manager.test.ts`
- `tests/mcp/report-client.test.ts`
- `.superpowers/sdd/2026-09-02-lifecycle-residual-corrections/task-2-report.md`

### Self-review and concerns

- The manager cancellation branch is gated by its own controller's aborted state, so unrelated client cancellation cannot be swallowed or trigger recovery.
- `errorCode`/`lifecycleCode` continue to classify `REQUEST_CANCELLED` as `INTERNAL_ERROR`; cancellation is not treated as `OFFLINE` and cannot become a code-free stopped result.
- The in-flight close test verifies desired state remains off at generation 2, no submit occurs, and no spawn/show recovery follows cancellation.
- The full run did not reproduce the independent re-review's diagnostics lock race. No open Task 2 concern remains in this fix-round diff.
