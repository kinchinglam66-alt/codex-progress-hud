# Lifecycle Residual Corrections — Corrective Acceptance Report

Date: 2026-09-02

Task 3 baseline: `095a6cfda4906c1e68e0a6fee82d91017446ce57`

Task 4 baseline: `e631c46a857752d2c9f1b7a801550d007fb3028d`

Task 6 baseline: `7f3f0facb5e36f35028c43ebf03f2aa32af30bbf`

Task 7 baseline: `de22fb38ce72c3fcdf8298943f0703e0f344a9e4`

Worktree: `.worktrees/release-lifecycle` on `feat/release-lifecycle`

## Outcome

Tasks 1–3 targeted C1, I1, I3, and M2. The final whole-correction re-review later reopened C1 and I1 because readiness publication followed the last desktop generation guard, and state-lock setup/read/release could outlive the advertised caller boundary. I3 and M2 remained closed. M2 requires an exact canonical timestamp round-trip after the fixed-millisecond UTC shape check: `2026-02-31T01:02:03.000Z` is rejected, while `2028-02-29T01:02:03.000Z` is accepted unchanged.

Task 4 closes the diagnostics logger lock-disappearance race exposed by Task 3. A deterministic filesystem seam removes a valid lock after `readLockRecord()` opens and reads it but before the second path identity `lstat`; the observation now retries instead of leaking `ENOENT`. The focused logger suite passed in 10 fresh processes, three fresh complete suites passed, and every required non-packaging gate passed. Independent Task 4 and whole-correction reviews remain required, so this report does not authorize Windows packaging.

Task 5 closes the three Important gaps from the first whole-correction review. Second-instance activation is now explicit-intent-only; retry-submit generation rejection and manager-owned cancellation converge through the same stale/manual-off classifier used by the first submit; and authenticated token reads, executable existence checks, and stale-spawn termination share their enclosing absolute deadline. Deterministic 90ms / `<300ms` tests cover all newly bounded paths and assert no late runtime/state/window publication. A fresh whole-correction re-review remains required, so this report still does not authorize Windows packaging.

Task 6 closes the final re-review's publication, complete state-operation boundary, and stale-classification gaps. Desktop readiness now runs inside the existing on-generation state guard after runtime publication. Deterministic tests prove both lock orderings: off-first publishes no server/window/tray/startup-ready/runtime, while guard-first blocks close's off commit until close can observe the complete instance. The state-store deadline is established before lock setup; non-cooperative setup and reads are caller-hard-bounded, cooperative product mutations remain awaited once entered, and delayed release is limited to identity-safe lock cleanup that cannot delete a successor or mutate settings/runtime. First- and second-submit generation rejection or manager-owned cancellation now settle as stable `START_TIMEOUT` or `MANUALLY_DISABLED`, never `INTERNAL_ERROR`, retry, reopen, extra spawn, or show. An independent final whole-correction re-review remains required, so this report does not authorize Windows packaging.

Task 7 closes the two Important findings from final re-review round 2. `hud_hide` now reads a current `desiredState: "on"` generation and sends it through the real authenticated HTTP client; a generation race returns the successor's current lifecycle snapshot and never invokes the stale hide callback. Close captures its target runtime after committing off and every manager cleanup point uses one state-store lock to validate the exact off generation, desired state, and full expected runtime identity before the existing inode-safe unlink. Deterministic initial-offline, graceful, and forced-termination races preserve a G+1 same-PID/same-nonce successor; timeout continues to retain runtime evidence and cannot record completion. The complete non-packaging gate passed. Independent re-review remains required, so this report does not authorize Windows packaging.

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

## Task 4 TDD and verification evidence

Production mutation caught by the new test: allowing the second lock-path `lstat` in `readLockRecord()` to propagate `ENOENT` makes a legitimate concurrent release reject the logger write instead of retrying the observation.

1. RED — `npm test -- --run tests/diagnostics/logger.test.ts -t "retries when an observed lock disappears before its second path identity check"`
   - Exit 1; 1 file failed.
   - 1 failed and 14 skipped out of 15 tests; Vitest duration 258 ms.
   - Expected failure: the write rejected with `ENOENT` from the second lock-path `lstat` at `src/diagnostics/logger.ts:242`.
2. GREEN — the same deterministic focused command after the minimal production change.
   - Exit 0; 1 file passed.
   - 1 passed and 14 skipped out of 15 tests; Vitest duration 276 ms.
3. Logger-file regression — `npm test -- --run tests/diagnostics/logger.test.ts`.
   - Exit 0; 1 file and 15/15 tests passed; Vitest duration 683 ms.
4. Ten fresh focused logger processes — the complete logger file passed 15/15 tests in every run.
   - Vitest durations: 658, 624, 644, 654, 683, 615, 674, 633, 652, and 677 ms.
5. Three fresh complete-suite processes — `npm test -- --run`.
   - All three exited 0 with 18/18 files and 293/293 tests; Vitest durations were 8.51 s, 11.66 s, and 7.30 s.
6. Required non-packaging gates.
   - `npm run typecheck`: exit 0; `tsc --noEmit` reported no errors.
   - `npm run build`: exit 0; TypeScript build and asset copy completed.
   - `npm run smoke`: exit 0; build completed; protocol health, authenticated event flow, and shutdown callback verified.
   - `npm run diagnose:mcp`: exit 0; 1/1 file and 1/1 test passed.
   - `npm run validate:plugin`: exit 0; plugin manifest and MCP launch configuration valid.
   - `git diff --check`: exit 0; no output.

Implementation: only the second path identity lookup handles `ENOENT` as a missing observation. Initial regular-file and symlink checks, opened-handle dev/inode verification, current-path dev/inode verification, owner/token validation, identity-checked unlink, bounded acquisition, stale-owner recovery, rotation serialization, and category-only privacy behavior remain unchanged and covered by the focused and complete suites.

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

## Logger race diagnosis and closure

The failed additional suite was:

`tests/diagnostics/logger.test.ts > operational logger > serializes rotation across two logger instances sharing one directory`

Observed exception: `ENOENT` from `lstat` of `.companion.log.lock`, originating at `readLockRecord` in `src/diagnostics/logger.ts:242` during concurrent logger writes.

Three fresh focused diagnostic processes were then run during Task 3 with:

`npm test -- --run tests/diagnostics/logger.test.ts -t "serializes rotation across two logger instances sharing one directory"`

All three exited 0 with 1/1 selected test passed and 13 skipped; Vitest durations were 448 ms, 401 ms, and 438 ms. That result confirmed timing sensitivity but did not close the race.

Root-cause diagnosis: `readLockRecord()` catches `ENOENT` for its initial path `lstat`, then opens and reads the lock through a handle, and finally performs a second path `lstat`. During legitimate concurrent release, the owner can unlink the lock path after the competing reader opens the handle but before that second `lstat`. The second `lstat` did not handle `ENOENT`, so normal lock disappearance escaped as a test failure.

Task 4 deterministically reproduces that exact boundary and closes it by treating only the second lookup's `ENOENT` as a missing observation. The reader returns no stale record, so it cannot reclaim by stale owner metadata or delete a successor; acquisition proceeds through its existing bounded retry loop. The 10 fresh focused passes and three fresh complete-suite passes above close this Important logger blocker. Independent review remains required before packaging.

## Residual finding closure evidence

### C1 — closed

- Commits: `a18fee0` (`fix: keep manual off authoritative`) and `f143498` (`fix: close task one review gaps`).
- Direct tests cover generation-bearing manager launch arguments, rejection of malformed/conflicting manager intent, manager desktop refusal after off or generation supersession, same-generation publication, one-shot write lease behavior, and stale `tracking_start` suppression.
- The fresh real two-MCP test above passed and directly covers the originally missing cross-process stale retry path.
- The final re-review reopened C1 at the post-runtime publication boundary. Task 6 adds the final on-generation guard around server listen, token read, window/tray creation, and `startup_ready`. Its two-store tests prove off-first cleanup and guard-first complete publication before close observes the instance.

### I1 — closed

- Commits: `cb57360` (`fix: enforce lifecycle operation deadlines`), `1c04631` (`fix: close task two review gaps`), and `095a6cf` (`fix: complete task two cancellation handling`).
- Full-suite behavior tests cover process-local queue waits, real cross-process lock waits, complete manager open, close-time runtime clear, and owned-process termination under one absolute deadline.
- Elapsed assertions remain strict and were not relaxed: injected 90 ms store/open/close/hanging-listener budgets must settle in `<300 ms`; successor mutation checks wait 150 ms after lock release to prove no late publication/deletion; external cancellation and matching-owned-HUD termination also settle in `<300 ms`.
- The final re-review reopened I1 for pre-lock setup, non-cooperative reads, and release. Task 6 injects the existing filesystem primitives and deterministically stalls lock-directory creation, owner write, owner identity `lstat`, lock metadata read, product-state read, and release. All caller-visible operations retain the 90 ms / `<300 ms` contract. After release, settings/runtime remain unchanged by timed-out work, and detached identity-safe release does not delete a successor lock or its successor state.

### I3 — closed

- The same Task 2 commits distinguish client-owned deadline expiry as `REQUEST_TIMEOUT`, external cancellation as `REQUEST_CANCELLED`, and connection refusal as `OFFLINE`.
- The real hanging-listener close test requires `SHUTDOWN_TIMEOUT`, desired state off, retained runtime, `<300 ms` completion under a 90 ms budget, and no `shutdown_complete` record. A live non-responsive listener is no longer reported as observed stopped.

### M2 — closed

- Task 3 tests directly reject `2026-02-31T01:02:03.000Z` and accept `2028-02-29T01:02:03.000Z` unchanged.
- The exact `toISOString()` equality makes normalized calendar dates fail while retaining the existing fixed-millisecond UTC shape and strict schema.

### Diagnostics logger lock disappearance — closed

- Task 4's deterministic seam unlinks a valid live-owner lock only after the reader has opened and read the handle and immediately before the second path identity lookup. Reintroducing the old behavior produces the recorded RED `ENOENT` failure.
- The second lookup now maps only `ENOENT` to a missing observation. All non-`ENOENT` failures still propagate, and no stale handle metadata is returned after disappearance.
- Ten fresh complete logger-file runs and three fresh complete-suite runs passed. Existing tests for symlink/regular-file rejection, bigint dev/inode identity, successor ownership, stale-owner recovery, rotation serialization, bounded acquisition, and category-only privacy also passed in those runs.

## Task 5 final-review gap closure

### RED evidence

1. Automatic-login second instance:
   - Command: `npm test -- --run tests/desktop/lifecycle.test.ts -t "second instance"`.
   - Exit 1; 1 failed, 1 passed, 37 skipped.
   - Expected failure: `--automatic-login` called `setDesiredState("on")` once while the primary had been manually set off.
2. Retry-submit stale/cancel convergence:
   - Command: `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "suppresses second-submit"`.
   - Exit 1; 2 failed, 40 skipped.
   - Expected failures: retry `GENERATION_REJECTED` and manager-owned retry `REQUEST_CANCELLED` both escaped from `executeWrite()` at the second `operation()` call.
3. Authenticated token read boundary:
   - Command: `npm test -- --run tests/mcp/report-client.test.ts -t "token"`.
   - Exit 1; 3 failed, 2 passed, 13 skipped.
   - Expected failures: the injected token reader was ignored, so a never-settling read and both late-failure cases incorrectly reached successful authenticated health responses.
4. Executable check and stale-spawn retirement boundaries:
   - Command: `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "existence check|stale-spawn termination"`.
   - Exit 1; both selected tests failed by their 300ms watchdogs after reaching the intended never-settling seams.

### GREEN implementation and focused evidence

- `runDesktop()` now activates a primary instance only when the second command line parses as HUD mode with explicit launch reason. Manager, automatic-login, malformed, absent, and non-HUD intents cannot set on or show.
- `executeWrite()` classifies both submits with the same stale-attempt helper. Either-attempt `GENERATION_REJECTED` and manager-owned `REQUEST_CANCELLED` call `staleWriteResult`; only first-attempt `OFFLINE` enters same-generation recovery.
- `CompanionHttpClient` passes the request controller signal to token loading and races token settlement against that signal. The already-claimed abort cause is evaluated before token/auth errors, so deadline-first remains `REQUEST_TIMEOUT` and external-first remains `REQUEST_CANCELLED` even if token loading rejects later.
- The manager's generic remaining-deadline race now bounds `pathExists` and matching-PID stale `terminate()`. Timeout becomes `START_TIMEOUT`; late promises cannot publish runtime, mutate desired state, show a window, or create another process.
- Desktop second-instance target: exit 0; 2/2 selected tests passed, then the complete desktop file passed 39/39.
- Retry-submit target: exit 0; 2/2 selected tests passed, then the complete manager file passed 42/42 at that stage.
- Token target: exit 0; 5/5 selected tests passed; the never-settling and first-cause cases retain 90ms / `<300ms` assertions.
- Manager deadline target: exit 0; 2/2 selected tests passed; both use a 90ms startup budget and `<300ms` watchdog, and stale retirement waits another 150ms before asserting no late runtime/state/window publication.
- Combined focused gate: `npm test -- --run tests/desktop/lifecycle.test.ts tests/lifecycle/companion-manager.test.ts tests/mcp/report-client.test.ts` — exit 0; 3/3 files and 101/101 tests passed; Vitest duration 5.56s.

### Task 5 complete gate

| Command | Exact result |
|---|---|
| `npm test -- --run` | Exit 0; 18/18 files; 301/301 tests; Vitest duration 7.59s. |
| `npm run typecheck` | Exit 0; `tsc --noEmit` reported no errors. |
| `npm run build` | Exit 0; TypeScript build and asset copy completed. |
| `npm run smoke` | Exit 0; build completed; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 file and 1/1 test passed; protocol-only stdout and the complete tool catalog remained valid; Vitest duration 468ms. |
| `npm run validate:plugin` | Exit 0; plugin manifest and MCP launch configuration valid. |
| `git diff --check` | Exit 0; no output. |

Task 5 changed no tool registration, public payload, response-size, privacy, PID/nonce ownership, canonical timestamp, packaging, installation, merge, push, or release behavior.

### Task 5 independent-verification correction

An independent focused run after `cb00734` passed 100 tests and failed only the stale-spawn deadline test because `terminate()` was called zero times. Local reproduction in a fresh selected-test process produced the same failure in 119ms.

The test fixture's real file-backed preconditions could exhaust the 90ms budget before the intended stale matching-PID retirement branch. Replacing those preconditions with immediate deterministic store/path seams then exposed the product-level issue: stale retirement bounded `terminate()` but ignored whether that deadline race timed out, making the final error depend on whether a subsequent state read honored the already-expired deadline.

The corrected fixture now proves branch entry by asserting the rejected `writeRuntime` call with the expected health and generation before checking `terminate()` exactly once. After the 150ms observation window it also requires one initial on transition, one spawn, and no show. The manager propagates stale-retirement completion and directly returns `START_TIMEOUT` when matching-PID termination exceeds the original startup deadline. The 90ms budget, `<300ms` watchdog, terminate assertion, and no-late-publication checks are unchanged.

Fresh correction evidence:

- Selected stale-spawn test: 15/15 independent Vitest processes passed.
- Final combined desktop/manager/client focused command: 5/5 consecutive processes passed 3/3 files and 101/101 tests. Durations were 5.65s, 6.98s, 7.22s, 7.40s, and 5.69s.
- Final full suite: exit 0; 18/18 files and 301/301 tests passed; Vitest duration 11.10s.
- Typecheck: exit 0.
- No package, install, merge, push, or release action was performed.

## Task 6 final re-review gap closure

### RED evidence

1. Desktop publication order:
   - Command: `npm test -- --run tests/desktop/lifecycle.test.ts -t "readiness guard"`.
   - Exit 1; 2 selected tests failed and 39 were skipped.
   - Expected failures: off committed after runtime but `createProgressServer` still ran; the opposite-order test timed out because no readiness guard was entered.
2. Complete state-operation boundary:
   - Command: `npm test -- --run tests/lifecycle/state-store.test.ts -t "hard-bounds stalled|stalled lock metadata|stalled product-state|identity-safe release"`.
   - Exit 1; 6 selected tests failed and 30 were skipped.
   - Expected failures: the optional filesystem seam did not yet exist, so mkdir, owner write, owner `lstat`, lock/state read, and release stalls could not be injected or bounded.
3. Deadline-safe stale classification:
   - Command: `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "classifies .*submit"`.
   - Exit 1; 4 selected tests failed and 44 were skipped.
   - Expected failures: first/second generation rejection with an expired deadline and first/second manager-owned cancellation behind a held lock all rejected instead of returning stable non-internal results; second cancellation reached the 300 ms watchdog.

### GREEN implementation and focused evidence

- Desktop readiness publication is the callback of `runIfGeneration(generation, "on", ...)`. A rejected guard enters identity-safe startup cleanup; a winning guard keeps off behind the same state lock until all readiness surfaces and the category-only `startup_ready` record exist.
- `createLifecycleStateStore(paths, { fileSystem })` is an optional dependency seam over the same Node fs primitives used in production. The caller deadline is created before lock `mkdir`. The local queue distinguishes pre-mutation setup/read work from an entered product mutation. A timed-out caller can leave only abort-checked setup/read work and identity-safe owner/temp cleanup in the background. Release may detach at the caller boundary because it reads and unlinks only matching lock/owner identities.
- Manager-owned abort is direct evidence that close won and returns `MANUALLY_DISABLED` without reacquiring state. A generation-rejection classifier that cannot read settings before the original deadline returns `START_TIMEOUT`; neither path enters OFFLINE recovery.
- Desktop publication GREEN: 2/2 selected tests passed; Vitest duration 831 ms.
- State deadline GREEN: 6/6 selected tests passed; Vitest duration 2.13 s.
- Stale classifier GREEN: 4/4 selected tests passed; Vitest duration 997 ms.
- Combined focused gate: 3/3 files and 125/125 tests passed; final Vitest duration 8.24 s.

### Task 6 complete gate

| Command | Exact result |
|---|---|
| `npm test -- --run` | Exit 0; 18/18 files and 313/313 tests passed; final Vitest duration 8.80 s. |
| `npm run typecheck` | Exit 0; `tsc --noEmit` reported no errors. |
| `npm run build` | Exit 0; TypeScript build and asset copy completed. |
| `npm run smoke` | Exit 0; build completed; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test passed; exact tool catalog and protocol-only child stdout remained valid; final Vitest duration 420 ms. |
| `npm run validate:plugin` | Exit 0; plugin manifest and MCP launch configuration valid. |
| `git diff --check` | Exit 0; no output. |

Task 6 changes no tool registration, public payload schema, response-size limit, privacy behavior, PID/nonce ownership rule, packaging, installation, merge, push, or release behavior.

## Task 7 generation-aware hide and successor-safe close

### RED evidence

Command: `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "sends the current on generation|returns current lifecycle truth|older close clear"`

- Exit 1; 3 selected tests failed and 48 were skipped.
- The real `CompanionHttpClient` request without generation received `GENERATION_REJECTED` from the production generation-guarded server, and `manager.hide()` failed the same way because it omitted the header.
- A hide raced by a lifecycle generation change rejected instead of returning current truth.
- An older close returned off/stopped after a G+1 explicit on/runtime publication and deleted the successor runtime even though the successor reused the exact PID and nonce.

### GREEN implementation and focused evidence

- `hide()` observes a running/hidden HUD, reads and validates the current on generation under the original deadline, sends that generation, and converts a raced 409 into a fresh lifecycle observation. The real server/store tests prove headerless hide is rejected, matching hide runs once, and stale hide cannot affect a visible G+2 successor.
- `clearRuntimeIfGeneration(generation, expected)` performs settings validation, full runtime identity validation, and unlink under one lifecycle lock. It reaches the existing final inode identity check and mutation-entry callback only after all product-state checks pass.
- `close()` captures the expected runtime after committing its off generation. Initial offline, post-shutdown offline, and owned forced-termination cleanup all call the atomic store operation. A stale/mismatched close observes current lifecycle truth and does not record shutdown completion. Timeout paths retain runtime evidence and do not clear.
- Focused manager/state/server/desktop gate: 4/4 files and 156/156 tests passed; Vitest duration 13.19 s.
- Source-mode integration gate: 1/1 file and 3/3 tests passed; Vitest duration 4.47 s. Its delegated client now forwards request options, and the test-owned server rejects hide without the expected generation.

### Complete Task 7 gate

| Command | Exact result |
|---|---|
| `npm test -- --run` | Exit 0; 18/18 files and 321/321 tests passed; final Vitest duration 10.50 s. |
| `npm run typecheck` | Exit 0; `tsc --noEmit` reported no errors. |
| `npm run build` | Exit 0; TypeScript build and asset copy completed. |
| `npm run smoke` | Exit 0; build completed; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test passed; exact tool catalog and protocol-only child stdout remained valid; final Vitest duration 424 ms. |
| `npm run validate:plugin` | Exit 0; plugin manifest and MCP launch configuration valid. |
| `git diff --check` | Exit 0; no output. |

Task 7 changes no tool registration, public MCP payload schema, response-size limit, privacy behavior, PID/nonce termination ownership, packaging, installation, merge, push, or release behavior.

## Review, limitations, and prohibited actions

- Task 3 self-review found no scope expansion in the timestamp implementation or tests. Task 4 closes the diagnostics flaky concern with the deterministic evidence above.
- The first staged `git diff --cached --check` failed on two Markdown hard-break trailing spaces in this report. The cause was report formatting; both spaces were removed before commit and the cached check was rerun. No production or test file was implicated.
- Independent task review and whole-correction review remain required before any packaging decision.
- Task 6 implementation and self-verification are recorded above. A fresh independent whole-correction re-review has not yet occurred.
- **No packaged Electron validation has occurred in this plan.**
- **No packaged Windows validation has occurred in this plan.**
- No package, install, merge, push, or release action was performed.
- This report is an acceptance boundary record, not authorization to begin Windows packaging.
