# Lifecycle Residual Corrections — Corrective Acceptance Report

Date: 2026-09-02

Task 3 baseline: `095a6cfda4906c1e68e0a6fee82d91017446ce57`

Worktree: `.worktrees/release-lifecycle` on `feat/release-lifecycle`

## Outcome

The targeted C1, I1, I3, and M2 lifecycle findings are closed by direct behavior tests and the Task 1–3 commits listed below. M2 now requires an exact canonical timestamp round-trip after the fixed-millisecond UTC shape check. `2026-02-31T01:02:03.000Z` is rejected, while `2028-02-29T01:02:03.000Z` is accepted unchanged.

The seven-command corrective gate passed. One of the three additionally required fresh full-suite runs exposed an intermittent diagnostics logger lock race; the failure and diagnosis are recorded below and are not normalized away. Because that independent concern remains unfixed and an independent whole-correction review is still required, this report does not authorize Windows packaging.

## Task 3 TDD evidence

Production mutation caught by the new test: replacing exact calendar round-trip validation with shape plus finite `Date.parse` allows JavaScript date normalization to accept an impossible calendar date.

1. RED — `npm test -- --run tests/lifecycle/state-store.test.ts -t "canonical timestamp"`
   - Exit 1; 1 file failed.
   - 1 failed, 1 passed, 28 skipped out of 30 tests.
   - Expected failure: the impossible date promise resolved with the persisted runtime instead of rejecting.
   - The valid leap-date case passed unchanged during the same run.
2. GREEN — the same focused command after the minimal schema change.
   - Exit 0; 1 file passed.
   - 2 passed, 28 skipped out of 30 tests; Vitest duration 575 ms.
3. State-store regression — `npm test -- --run tests/lifecycle/state-store.test.ts`
   - Exit 0; 1 file and 30/30 tests passed; Vitest duration 6.86 s.

Implementation: the existing exact `YYYY-MM-DDTHH:mm:ss.sssZ` regex remains, parsing must be finite, and `new Date(value).toISOString()` must equal the original value exactly. Offsets, missing milliseconds, malformed strings, normalized impossible dates, and strict-object extra fields remain rejected.

## Seven-command corrective gate

| # | Command | Exact result |
|---|---|---|
| 1 | `npm test -- --run` | Exit 0; 18/18 files; 292/292 tests; Vitest duration 7.95 s. |
| 2 | `npm run typecheck` | Exit 0; `tsc --noEmit` reported no errors. |
| 3 | `npm run build` | Exit 0; TypeScript build and asset copy completed. |
| 4 | `npm run smoke` | Exit 0; build completed; protocol health, authenticated event flow, and shutdown callback verified. |
| 5 | `npm run diagnose:mcp` | Exit 0; 1/1 file and 1/1 test passed; all tools exposed with protocol-only child stdout; Vitest duration 758 ms. |
| 6 | `npm run validate:plugin` | Exit 0; plugin manifest and MCP launch configuration valid. |
| 7 | `git diff --check` | Exit 0; no output. |

## Required fresh process runs

Each command below started a separate npm/Node/Vitest process.

| Run | Command | Exact result |
|---|---|---|
| Additional full suite 1/3 | `npm test -- --run` | **Exit 1**; 17 passed / 1 failed files; 291 passed / 1 failed tests; Vitest duration 11.65 s. |
| Additional full suite 2/3 | `npm test -- --run` | Exit 0; 18/18 files; 292/292 tests; Vitest duration 7.39 s. |
| Additional full suite 3/3 | `npm test -- --run` | Exit 0; 18/18 files; 292/292 tests; Vitest duration 11.76 s. |
| Pre-commit full suite | `npm test -- --run` | Exit 0; 18/18 files; 292/292 tests; Vitest duration 7.44 s. |
| Two-MCP stale tracking acceptance | `npm test -- --run tests/integration/companion-lifecycle.test.ts -t "keeps close authoritative across two real MCP processes after tracking_start leases but before submit"` | Exit 0; 1/1 selected test passed, 2 skipped; Vitest duration 1.59 s. |

The two-MCP test uses two real MCP stdio child processes, a real state store, HTTP client/server boundaries, and the server-side generation guard. It proves the stale pre-close `tracking_start` reaches the old generation guard once, is suppressed after close commits off, does not reacquire activation, does not submit a tracking event, and leaves desired state off at the closed generation.

## Flaky failure diagnosis

The failed additional suite was:

`tests/diagnostics/logger.test.ts > operational logger > serializes rotation across two logger instances sharing one directory`

Observed exception: `ENOENT` from `lstat` of `.companion.log.lock`, originating at `readLockRecord` in `src/diagnostics/logger.ts:242` during concurrent logger writes.

Three fresh focused diagnostic processes were then run with:

`npm test -- --run tests/diagnostics/logger.test.ts -t "serializes rotation across two logger instances sharing one directory"`

All three exited 0 with 1/1 selected test passed and 13 skipped; Vitest durations were 448 ms, 401 ms, and 438 ms. This confirms timing sensitivity rather than a deterministic failure.

Root-cause diagnosis: `readLockRecord()` catches `ENOENT` for its initial path `lstat`, then opens and reads the lock through a handle, and finally performs a second path `lstat`. During legitimate concurrent release, the owner can unlink the lock path after the competing reader opens the handle but before that second `lstat`. The second `lstat` does not handle `ENOENT`, so normal lock disappearance escapes as a test failure. This pre-existing diagnostics code is outside Task 3's authorized files and was not changed. It remains an open release concern for the subsequent whole-correction review.

## Residual finding closure evidence

### C1 — closed

- Commits: `a18fee0` (`fix: keep manual off authoritative`) and `f143498` (`fix: close task one review gaps`).
- Direct tests cover generation-bearing manager launch arguments, rejection of malformed/conflicting manager intent, manager desktop refusal after off or generation supersession, same-generation publication, one-shot write lease behavior, and stale `tracking_start` suppression.
- The fresh real two-MCP test above passed and directly covers the originally missing cross-process stale retry path.

### I1 — closed

- Commits: `cb57360` (`fix: enforce lifecycle operation deadlines`), `1c04631` (`fix: close task two review gaps`), and `095a6cf` (`fix: complete task two cancellation handling`).
- Full-suite behavior tests cover process-local queue waits, real cross-process lock waits, complete manager open, close-time runtime clear, and owned-process termination under one absolute deadline.
- Elapsed assertions remain strict and were not relaxed: injected 90 ms store/open/close/hanging-listener budgets must settle in `<300 ms`; successor mutation checks wait 150 ms after lock release to prove no late publication/deletion; external cancellation and matching-owned-HUD termination also settle in `<300 ms`.

### I3 — closed

- The same Task 2 commits distinguish client-owned deadline expiry as `REQUEST_TIMEOUT`, external cancellation as `REQUEST_CANCELLED`, and connection refusal as `OFFLINE`.
- The real hanging-listener close test requires `SHUTDOWN_TIMEOUT`, desired state off, retained runtime, `<300 ms` completion under a 90 ms budget, and no `shutdown_complete` record. A live non-responsive listener is no longer reported as observed stopped.

### M2 — closed

- Task 3 tests directly reject `2026-02-31T01:02:03.000Z` and accept `2028-02-29T01:02:03.000Z` unchanged.
- The exact `toISOString()` equality makes normalized calendar dates fail while retaining the existing fixed-millisecond UTC shape and strict schema.

## Review, limitations, and prohibited actions

- Task 3 self-review found no scope expansion in the timestamp implementation or tests. The diagnostics flaky concern above remains open for whole-correction review.
- The first staged `git diff --cached --check` failed on two Markdown hard-break trailing spaces in this report. The cause was report formatting; both spaces were removed before commit and the cached check was rerun. No production or test file was implicated.
- Independent task review and whole-correction review remain required before any packaging decision.
- **No packaged Electron validation has occurred in this plan.**
- **No packaged Windows validation has occurred in this plan.**
- No package, install, merge, push, or release action was performed.
- This report is an acceptance boundary record, not authorization to begin Windows packaging.
