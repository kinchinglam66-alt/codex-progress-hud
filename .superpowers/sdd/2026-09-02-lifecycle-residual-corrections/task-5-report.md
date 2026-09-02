# Task 5 Report — Final lifecycle review gaps

## Outcome

Implemented Task 5 on baseline `9adb99721af54b107a810ec316c5df6467a1bbdb`. The automatic-login second-instance authority breach, second-submit stale/cancel escape, and three missing absolute-deadline boundaries are covered by deterministic behavior tests and closed in implementation. No package, install, merge, push, or release action was performed.

## Root causes verified

1. `runDesktop()` parsed second-instance intent but excluded only manager launches. Automatic login and absent command lines fell through to `setDesiredState("on")` and `show()`.
2. `executeWrite()` classified errors around only the first submit. The retry submit occurred inside that catch but outside any equivalent classifier, so retry generation rejection and cancellation escaped.
3. `CompanionHttpClient` armed its deadline before authentication but awaited an uncancellable token read while constructing headers. The catch rethrew `AUTH_ERROR` before consulting an abort cause that had already won.
4. Manager startup awaited `pathExists()` directly and stale retirement awaited matching-PID `terminate()` directly, despite having an absolute startup deadline.

## RED evidence

- Automatic-login target: exit 1; 1 failed, 1 passed, 37 skipped. The new off-state test observed one unexpected `setDesiredState("on")` call.
- Retry-submit target: exit 1; 2 failed, 40 skipped. Both errors escaped at the retry `operation()` call.
- Token target: exit 1; 3 failed, 2 passed, 13 skipped. Never-settling and late-failure readers were not used by production.
- `pathExists` target: its 300ms watchdog rejected because startup remained pending.
- Initial stale-termination fixture hit the existing state deadline before reliably reaching termination. Root-cause tracing showed real file-lock timing consumed the 90ms fixture budget. The test was corrected without production changes by making `writeRuntime()` return false, which deterministically reaches stale retirement with known matching health. The corrected RED hit its 300ms watchdog while blocked in `terminate()`.

## GREEN behavior

- Second-instance activation is a positive allow-list: parsed HUD + explicit launch reason only. Explicit `--hud` remains active; manager and automatic-login are ignored; malformed/conflicting intent remains caught and reported.
- Both write attempts use `classifyStaleAttempt()`. Generation rejection always converges through `staleWriteResult`; request cancellation does so only when the manager's own controller is aborted. Only the first OFFLINE submit may recover the captured generation.
- Token loading receives the same controller signal and is explicitly raced against abort. Request classification checks the claimed first cause before token/auth errors.
- `resultBeforeDeadline()` generalizes the existing termination race and now bounds executable existence checks. Stale matching-PID termination uses the same absolute startup deadline.

## Focused verification

- Desktop second-instance selected GREEN: 2/2 passed; complete desktop: 39/39 passed.
- Retry-submit selected GREEN: 2/2 passed; complete manager at that stage: 42/42 passed.
- Token selected GREEN: 5/5 passed.
- Manager deadline selected GREEN: 2/2 passed.
- Combined desktop/manager/client: 3/3 files, 101/101 tests, exit 0, Vitest duration 5.56s.
- The new deadline cases use 90ms operation budgets and require `<300ms`; the stale-spawn test additionally waits 150ms and confirms no runtime publication, desired-state mutation, window show, or extra spawn.

## Complete verification

- `npm test -- --run`: exit 0; 18/18 files; 301/301 tests; Vitest duration 7.59s.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `npm run smoke`: exit 0; protocol health, authenticated event flow, and shutdown callback verified.
- `npm run diagnose:mcp`: exit 0; 1/1 test passed; protocol-only stdout and complete tool catalog verified.
- `npm run validate:plugin`: exit 0.
- `git diff --check`: exit 0.

## Mutation and contract review

- Relaxing the second-instance allow-list to exclude only manager intent fails the automatic-login off-state test.
- Removing retry error classification fails both retry-submit table cases.
- Ignoring the injected token reader, failing to race abort, or checking `AUTH_ERROR` before the claimed abort cause fails the token deadline/first-cause cases.
- Directly awaiting `pathExists` or stale `terminate` fails the corresponding 300ms watchdog.
- Existing 13-tool, privacy, response-size, generation, PID/nonce, timestamp, and protocol-only stdout contracts remained green in the full and diagnostic suites.

## Concerns

- A fresh independent whole-correction re-review is still required before Windows packaging can be considered.
- The deadline tests intentionally use real timers on Windows. Their product budgets are 90ms and watchdogs are 300ms; no threshold was relaxed during this task.

---

## Independent verification fix

Independent verification after commit `cb00734` found one intermittent focused failure: the stale-spawn deadline test returned `START_TIMEOUT` in 119ms but had not called `terminate()`. The other 100 focused tests passed. A local repeated-process reproduction failed immediately with the same `terminate expected once but got 0` assertion.

### Corrected root cause

The original fixture still used the real file-backed state store and real executable access throughout the 90ms measured startup path. Under filesystem or lock delay, an earlier state operation could consume the budget before `writeRuntime(false)` reached stale retirement. The test therefore accepted a valid but irrelevant earlier `START_TIMEOUT` and only the terminate count exposed the missed branch.

After replacing all pre-retirement store and `pathExists` operations with immediate deterministic seams, the test reached matching-PID retirement consistently and exposed a product error: `retireStaleSpawn()` raced `terminate()` against the deadline but discarded the returned timeout boolean. It then called `staleStartupResult()`. A real expired store usually converted that later read to `START_TIMEOUT`, while the deterministic immediate store returned `INTERNAL_ERROR`. The product result therefore depended on a secondary store timing accident.

### Fix

- The fixture now makes settings, manifest, runtime, runtime rejection, and executable existence deterministic before the target seam.
- It asserts `writeRuntime(compatibleHealth, 1, ...)` exactly once before asserting matching-PID `terminate()` exactly once; after the 150ms observation window it also requires one initial on transition, one spawn, and no show.
- `retireStaleSpawn()` now reports whether matching-PID termination settled before the absolute startup deadline.
- Both synchronous stale-startup callers convert a false retirement result directly to `START_TIMEOUT`, without depending on a subsequent expired state read.
- The 90ms budget, `<300ms` result assertion, terminate assertion, and 150ms no-late-publication observation were retained unchanged.

### Verification

- Corrected RED before the product fix: exit 1; selected test returned `INTERNAL_ERROR` instead of `START_TIMEOUT` after deterministically reaching stale retirement.
- Isolated stale-spawn test: 15/15 fresh Vitest processes passed; every run passed 1 selected test with 43 skipped.
- Final combined focused command after the strengthened no-late assertions: 5/5 consecutive fresh processes passed; each passed 3/3 files and 101/101 tests. Vitest durations: 5.65s, 6.98s, 7.22s, 7.40s, and 5.69s.
- Final full suite: exit 0; 18/18 files and 301/301 tests passed; Vitest duration 11.10s.
- `npm run typecheck`: exit 0.

No budget or watchdog was relaxed, and no terminate or late-publication assertion was removed.
