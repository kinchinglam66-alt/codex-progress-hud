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
