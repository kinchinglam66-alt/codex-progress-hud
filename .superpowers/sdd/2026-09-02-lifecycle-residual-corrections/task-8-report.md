# Task 8 Report — Shared tracking operation deadlines

Date: 2026-09-02

Baseline: `98a697e297406e81a1256050329fb9c0e7c38cbb`

## Outcome

The final round-3 Important finding is addressed in the Task 8 candidate. All status-then-submit tracking controls share one absolute write deadline. Each HTTP request receives a freshly computed remaining budget, and the manager bounds the complete callback even when it never settles. Deadline and close cancellation retain distinct first-cause classifications: deadline returns `START_TIMEOUT`; close remains successful `MANUALLY_DISABLED` suppression.

This report records implementation, the independent review finding, and review-fix-round-1 self-verification. A fresh independent re-review remains required before any packaging decision.

## Root cause

`executeWrite()` created the correct absolute deadline but passed its callback one numeric `timeoutMs`. `tracking_start`, pause, resume, and stop reused that value for status and submit. Because `CompanionHttpClient` creates a fresh request timer on every call, status could consume nearly the complete budget and submit could start a second full timer. The manager awaited the callback directly and therefore had no fallback for a callback that ignored cancellation or never settled.

## RED

Production mutations caught by the new tests:

- Replacing `makeRequestOptions()` with one captured options object gives status and submit the same timeout.
- Removing the manager callback race lets a hanging submit exceed 300 ms.
- Mapping all manager aborts to manual-off turns deadline expiry into `MANUALLY_DISABLED`.

Commands and results:

1. `npm test -- --run tests/mcp/tools.test.ts -t "shares one 90ms deadline"`
   - Exit 1; 4/4 selected tests failed by receiving the 300 ms watchdog; 24 tests skipped; Vitest duration 2.40 s.
2. `npm test -- --run tests/lifecycle/companion-manager.test.ts -t "non-cooperative write callback"`
   - Exit 1; the selected test failed by receiving the 300 ms watchdog; 53 tests skipped; Vitest duration 878 ms.

## GREEN

`CompanionManager.executeWrite()` now passes a single function to its callback:

`makeRequestOptions(): HudRequestOptions & { generation: number; signal: AbortSignal }`

The function preserves the write generation and shared signal while recomputing `timeoutMs` from the same absolute deadline. The tool layer calls it immediately before each request, including separately before status and submit.

The manager records one immutable abort cause. The deadline scheduler uses the injected `now()` source both to calculate and to verify expiry; close invokes the competing close cause only after committing off and reading its target runtime. Callback attempts race against that cause, so a never-settling callback returns on time and late rejection is still observed. A completion observed at or after the absolute deadline is not accepted as successful.

Classification and recovery remain narrow:

- deadline or request timeout → `START_TIMEOUT`;
- close-owned cancellation → `MANUALLY_DISABLED`;
- generation rejection → existing stale generation classifier;
- first-attempt `OFFLINE` → existing one-shot same-generation recovery;
- retry `OFFLINE` or any other unclassified error → no additional recovery.

The four tracking tests delay status for 75 ms under a 90 ms manager budget, then enter a submit that settles only when aborted. They assert complete return in `<300 ms`, `START_TIMEOUT`, two request options with a strictly smaller submit timeout, and no acceptance after a further 160 ms observation window. The manager test independently proves a callback that never observes the signal still returns `START_TIMEOUT` within the same tolerance. The existing close-owned cancellation test remains the manual-off control.

## Verification

| Command | Result |
|---|---|
| Focused tools/manager/client | Exit 0; 3/3 files, 100/100 tests; final Vitest duration 7.53 s. |
| `npm test -- --run` | Exit 0; 18/18 files, 326/326 tests; final Vitest duration 10.29 s. |
| `npm run typecheck` | Exit 0. |
| `npm run build` | Exit 0. |
| `npm run smoke` | Exit 0; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test; exact 13-tool catalog and protocol-only child stdout verified. |
| `npm run validate:plugin` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

## Scope

- No package, install, merge, push, or release action was performed.
- No MCP tool registration or public payload schema changed; all 13 tools remain present.
- No OFFLINE recovery path was added or widened.
- No deadline cancellation is classified as close cancellation, and the close-owned cancellation control remains `MANUALLY_DISABLED`.
- No response-size, privacy, generation authority, executable-containment, or PID/nonce termination-ownership rule changed.
- Independent final whole-correction re-review remains open.

## Review fix round 1 — disconnected server mutations

### Review finding

The independent Task 8 review demonstrated that client cancellation ended only the MCP-side fetch. After the server parsed a complete request body, it passed no request lifetime signal to `runMutation()` or `runIfGeneration()`. A request queued behind the lifecycle lock could therefore enter the current generation and apply an event or control side effect after the client had returned `REQUEST_TIMEOUT`.

The same review observed an `ENOTEMPTY` cleanup failure in the manager close/write test. `executeWrite()` correctly returned as soon as close won the abort race, but the test did not own or await the callback that was still completing its nested `close()` and file-backed work.

### Deterministic RED

1. Real event path:
   - Command: `npm test -- --run tests/integration/companion-lifecycle.test.ts -t "real client disconnects behind the generation lock"`.
   - Exit 1; the real client returned `REQUEST_TIMEOUT`, the held cross-process lifecycle lock was released, the server guard settled, and the subsequent real snapshot incorrectly contained `late-task`.
2. Real control paths:
   - Command: `npm test -- --run tests/integration/companion-lifecycle.test.ts -t "disconnected .* control behind"`.
   - Exit 1; hide and shutdown each timed out at the client, then each callback ran once after lock release.

The tests use a 20 ms client request deadline and a 90 ms watchdog. They wait until the real server has entered its generation guard before evaluating timeout, then explicitly release the lock and await complete guard settlement before asserting persistent state and side effects.

### GREEN

- The server creates a per-request cancellation controller and observes `request.aborted`, `response.close`, and the captured socket's `close`. This covers complete-body requests whose later client abort does not emit `request.aborted`.
- Listener removal always targets the same captured socket and occurs on accepted/rejected mutation completion or handler exit. `writeJson()` ignores a destroyed or already-ended response.
- `runMutation()` passes the connection signal to the generation guard. Desktop wiring supplies it to `LifecycleStateStore.runIfGeneration()` as `StateOperationOptions.signal`.
- `locallyOrdered()` merges the external signal into its existing timeout controller. Lock acquisition, generation validation, mutation entry, operation execution, and post-operation validation therefore share one abort state.
- The event apply callback checks immediately before `TaskStore.apply`. Control handling checks before `shuttingDown`, again before invoking the control callback, and the state guard checks before operation entry.
- Mutation completion removes disconnect listeners before sending the response. A normal successful response close cannot cancel an already completed event/control operation.
- A canceled shutdown leaves `shuttingDown` false: after moving the state store to a new on generation, a subsequent real event is accepted.
- The manager cleanup test uses an explicit callback-settlement promise and awaits it before cleanup. No sleep or timeout was lengthened.

### Verification

| Command | Result |
|---|---|
| Real disconnected event/control GREEN | Exit 0; 1/1 file, 3/3 selected tests. |
| Combined server/integration/tools/manager/state | Exit 0; 5/5 files, 150/150 tests; Vitest duration 9.72 s. |
| Final server/integration/tools/manager | Exit 0; 4/4 files, 111/111 tests; Vitest duration 7.40 s. |
| Three fresh manager-file runs | Exit 0 each; 54/54 tests each; no cleanup failure. |
| `npm test -- --run` | Two submission reruns exited 0; 18/18 files, 329/329 tests; Vitest durations 10.36 s and 10.04 s. |
| `npm run typecheck` | Exit 0. |
| `npm run build` | Exit 0. |
| `npm run smoke` | Exit 0; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test; exact 13-tool catalog and protocol-only child stdout verified; Vitest duration 452 ms. |
| `npm run validate:plugin` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

No package, install, merge, push, or release action was performed. Generation headers and 409 rejection, 64 KiB limits, sanitized errors, privacy behavior, all 13 tools, and the existing manager recovery/cancellation classifications remain unchanged. Fresh independent re-review is still required.
