# Task 6 Report — Publication atomicity and complete deadline closure

Date: 2026-09-02

Baseline: `7f3f0facb5e36f35028c43ebf03f2aa32af30bbf`

## Outcome

The final re-review's C1, I1, and I2 gaps are addressed in the Task 6 candidate. Desktop readiness publication is generation-atomic, lifecycle state callers have a hard boundary around lock setup and non-cooperative reads, delayed lock release is identity-safe background cleanup only, and stale submit outcomes no longer degrade to `INTERNAL_ERROR` when the original classifier budget is exhausted or contended. Task 6 review round 1 found one remaining post-marker runtime identity read; the fix below moves mutation entry to the final identity-matched unlink attempt.

This report records implementation and self-verification. Independent verification of review-fix round 1 remains required before any packaging decision.

## Root causes

- C1: `runDesktop()` released the generation-bound runtime-write lock before creating the server, window, tray, and startup-ready record.
- I1: `locallyOrdered()` treated lock acquisition as an entered mutation, `acquire()` created its deadline after mkdir/owner setup, and release was awaited without the caller boundary.
- I2: every generation rejection and manager-owned cancellation called `staleWriteResult()`, whose fresh settings read could throw after the original deadline or behind the close winner's lock.

## RED

### A — desktop publication

Command: `npm test -- --run tests/desktop/lifecycle.test.ts -t "readiness guard"`

- Exit 1; 2 failed, 39 skipped.
- Off-first failure: `createProgressServer` was called after a second store committed off between successful runtime write and readiness.
- Guard-first failure: the 300 ms guard-entry watchdog fired because readiness had no final generation guard.

### B — complete state deadline

Command: `npm test -- --run tests/lifecycle/state-store.test.ts -t "hard-bounds stalled|stalled lock metadata|stalled product-state|identity-safe release"`

- Exit 1; 6 failed, 30 skipped.
- Deterministic mkdir, owner-write, owner-`lstat`, lock-read, state-read, and release seams were unavailable, demonstrating the missing boundary/injection surface.

### C — stale classification

Command: `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "classifies .*submit"`

- Exit 1; 4 failed, 44 skipped.
- First/second generation rejection with an expired deadline and first/second manager-owned cancellation behind a held lock all rejected instead of returning stable results. The second-cancel case reached the 300 ms watchdog.

## GREEN

### A — generation-atomic readiness

`runDesktop()` keeps `runIfGeneration(generation, "on", callback)` around server construction/listen, token loading, window creation, tray creation, and `startup_ready`. If off commits first, the callback is rejected and startup cleanup clears only the matching runtime. If the guard wins first, close's off transition waits and its first health observation sees the complete instance.

Focused result: 2/2 selected tests passed; Vitest duration 831 ms.

### B — hard caller boundary and safe background cleanup

The optional `fileSystem` dependency replaces only the same fs primitives production already uses. The acquisition deadline is established before mkdir. Local ordering marks a mutation entered only immediately before the irreversible product rename/unlink or external guarded callback. Therefore:

- stalled setup/read work returns `LifecycleStateTimeoutError` to the caller under the 90 ms / `<300 ms` contract;
- background continuation observes abort before any product mutation and may clean only identity-matched owner/temp artifacts;
- an entered cooperative mutation remains awaited until it stops;
- a release that exceeds the caller deadline detaches, but can only read/delete identity-matched lock artifacts and cannot delete a successor.

Focused result: 6/6 selected tests passed; Vitest duration 2.13 s. The tests release every stall, wait 150 ms, and verify no late settings/runtime mutation. The release test installs a successor lock and successor state, then proves both survive the old cleanup.

### C — stable stale outcomes

Manager-owned `REQUEST_CANCELLED` after close returns `MANUALLY_DISABLED` directly, without another state read. `GENERATION_REJECTED` still classifies persisted off when possible; if its original deadline is exhausted or the read times out, it returns `START_TIMEOUT`. First-submit outcomes never recover. Second-submit outcomes perform only the one already-authorized same-generation OFFLINE recovery and never retry again.

Focused result: 4/4 selected tests passed; Vitest duration 997 ms. Every case asserts `<300 ms`, non-`INTERNAL_ERROR`, exact attempt/spawn counts, and no reopen/show.

## Review fix round 1 — runtime clear final identity read

The independent Task 6 review found that `clearUnlocked()` marked a mutation entered before `unlinkIfIdentical()` performed its final runtime-path `lstat`. A stalled final identity read therefore suppressed the caller timeout even though no unlink had been attempted.

### RED

Command: `npm test -- --run tests/lifecycle/state-store.test.ts -t "hard-bounds clearRuntime"`

- Exit 1; 2 selected tests failed and 36 were skipped; Vitest duration 1.31 s.
- Both `clearRuntime()` paths—without expected identity and after completing the expected runtime read—reached the injected final runtime `lstat` and remained pending at the 300 ms watchdog.
- After each stall was released, the test installed a successor runtime and confirmed the existing identity comparison did not delete it.

### GREEN

`unlinkIfIdentical()` now accepts an optional pre-unlink callback. It invokes that callback only after the current path identity matches and the final abort check passes, synchronously before the actual unlink attempt. `clearRuntime()` supplies `enterMutation`; identity-safe lock/owner/temp cleanup does not. Retry attempts continue to re-read and compare identity before unlink, preserving successor protection.

- Focused RED target after the fix: 2/2 selected tests passed and 36 were skipped; test time 555 ms, Vitest duration 868 ms.
- Both paths retain the 90 ms / `<300 ms` caller contract and wait 150 ms after releasing the stall before asserting the successor runtime remains intact.

### Validation diagnosis and correction

The first complete-suite run passed 314/315 tests and failed the existing second-submit manager-cancellation watchdog under parallel load. Ten independent reproductions failed 1/10. The test included Windows lock-holder child-process startup inside its `<300 ms` measurement even though classification could not begin until that child reported ready. The synchronization was corrected without changing the threshold: the operation now pauses after close, the test establishes the held lock, and only then starts the watchdog and releases the rejection. Ten independent post-correction runs passed 10/10.

Review-fix verification:

| Command | Result |
|---|---|
| Targeted clear plus second-cancel | Exit 0; 2/2 files, 3/3 selected tests; Vitest duration 1.18 s. |
| Focused state/desktop/manager | Exit 0; 3/3 files, 127/127 tests; final Vitest duration 11.48 s. |
| `npm test -- --run` | Exit 0; 18/18 files, 315/315 tests; final Vitest duration 10.38 s. |
| `npm run typecheck` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

## Verification

| Command | Result |
|---|---|
| Combined focused desktop/state/manager | Exit 0; 3/3 files, 125/125 tests; final run 8.24 s. |
| `npm test -- --run` | Exit 0; 18/18 files, 313/313 tests; final run 8.80 s. |
| `npm run typecheck` | Exit 0. |
| `npm run build` | Exit 0. |
| `npm run smoke` | Exit 0; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test; exact tool catalog and protocol-only stdout verified. |
| `npm run validate:plugin` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

## Scope and concerns

- No package, install, merge, push, or release action was performed.
- Node fs promises are not absolutely cancellable. The hard guarantee is caller settlement before a product mutation is entered; after entry, cooperative mutation settlement is awaited. Only identity-safe lock/temp cleanup may continue in the background.
- Holding the generation lock through readiness intentionally serializes close against publication. The guard contains no nested lifecycle-store call; server request callbacks may queue behind it and proceed after readiness releases the lock.
- Independent re-review of Task 6 review-fix round 1 remains open.
