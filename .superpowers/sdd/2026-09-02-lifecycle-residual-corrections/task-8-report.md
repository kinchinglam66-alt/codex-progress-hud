# Task 8 Report — Shared tracking operation deadlines

Date: 2026-09-02

Baseline: `98a697e297406e81a1256050329fb9c0e7c38cbb`

## Outcome

The final round-4 Important finding is addressed in the Task 8 candidate. All status-then-submit tracking controls share one absolute write deadline. Each HTTP request receives a freshly computed remaining budget, the official authenticated request transmits its absolute deadline to the server, and the manager bounds the complete callback even when it never settles. Deadline and close cancellation retain distinct first-cause classifications: deadline returns `START_TIMEOUT`; close remains successful `MANUALLY_DISABLED` suppression.

This report records implementation, all three independent review findings, and review-fix-round-3 self-verification. A fresh independent re-review remains required before any packaging decision.

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

## Review fix round 2 — canceled local queue entries

### Re-review finding and deterministic RED

The round-1 request signal reached `locallyOrdered()` but could not promptly release a caller queued behind an already entered same-process mutation when no `timeoutMs` was supplied. The external abort only canceled the controller; the no-deadline branch awaited the queued `current` promise directly, so the caller remained retained until its predecessor settled.

A real-store regression starts one `runIfGeneration()` callback and holds it on a gate. It queues a second same-generation `runIfGeneration()` with only an external signal, aborts that signal, and races settlement against a 300 ms watchdog. Before the production change, the focused state test exited 1: the watchdog won at 300 ms instead of receiving `LifecycleStateTimeoutError`. The test then released the first callback and verified the second callback never entered.

### GREEN

`locallyOrdered()` now always races `current` against one pre-entry cancellation promise. Both the optional absolute deadline and the external signal reject that promise only while `operationEntered` is false. Once mutation entry is recorded, abort still reaches the shared controller but caller settlement continues to await the cooperative `current` promise. The external listener and optional timer are removed on caller settlement; the internal `current` remains the local queue tail, observes the already-aborted controller after its predecessor releases, and invokes the existing identity-checked map cleanup.

The regression passed in 30 ms with the `<100 ms` caller bound. A later same-store read completed after the first operation was released, proving the canceled queue entry drained without executing its callback and did not strand the queue.

### Verification

| Command | Result |
|---|---|
| Focused state store | Exit 0; 1/1 file, 40/40 tests; new regression completed in 30 ms. |
| Focused state/integration/server/tools/manager | Exit 0; 5/5 files, 151/151 tests; Vitest duration 9.48 s. |
| `npm test -- --run` | Exit 0; 18/18 files, 330/330 tests; Vitest duration 10.03 s. |
| `npm run typecheck` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

No package, install, merge, push, or release action was performed. This fix changes only cancellation while waiting to enter the process-local state queue. It does not change entered-mutation settlement, cross-process lock recovery, generation/409 behavior, 64 KiB limits, privacy, OFFLINE recovery, deadline-versus-close classification, tool registration, or public payloads.

## Review fix round 3 — server-authoritative request deadlines

### Final re-review finding and deterministic RED

Final whole-correction re-review round 4 identified an ordering that socket cancellation cannot close: the client deadline can expire before the server event loop observes the socket close. A same-generation mutation already queued behind the lifecycle lock could therefore enter after the MCP caller received `START_TIMEOUT`.

The new real-boundary regression uses the production `CompanionHttpClient`, `createProgressServer`, and `LifecycleStateStore`. Its transport deliberately rejects the client fetch on abort without closing the underlying HTTP connection, so the server cannot receive a disconnect signal. Event, hide, and shutdown requests enter the generation guard under an 80 ms deadline, the client returns `REQUEST_TIMEOUT`, and only then is the same-generation cross-process lock released.

Command: `npm test -- --run tests/integration/companion-lifecycle.test.ts -t "enforces the server deadline"`

- RED exit 1: 3/3 selected cases failed. The event became `late-deadline-task`; hide and shutdown callbacks each ran once after lock release. Vitest duration 1.69 s.
- The test would fail if the server-side deadline timer were removed because the transport intentionally keeps the socket open through mutation settlement.

### GREEN

- Every official authenticated client request sends `x-codex-progress-hud-deadline-ms` as a canonical decimal safe integer computed once from `Date.now() + bounded timeoutMs`. Token loading and the HTTP request remain inside that same client budget. The unauthenticated identity probe sends neither bearer token nor deadline.
- The server strictly accepts only canonical non-negative safe-integer deadline headers. Missing headers and malformed, non-canonical, or unsafe values are treated as absent for compatibility with older/manual clients. Current official-client requests always carry the header.
- One server cancellation controller records only the first cause among the absolute deadline, `request.aborted`, response close, and captured socket close. Its signal is passed into `runIfGeneration`, where the state store merges it with local queue, cross-process lock, and operation cancellation.
- Event apply, show/hide/shutdown callbacks, and the `shuttingDown` write retain immediate signal checks before side effects. Deadline timers and all connection listeners are removed on accepted/rejected completion or handler exit.
- A server deadline that wins the same-timestamp race returns a bounded generic HTTP 408. `CompanionHttpClient` maps it to `REQUEST_TIMEOUT`, preserving manager-level `START_TIMEOUT` truth instead of misclassifying it as `VERSION_MISMATCH`.
- The 64 KiB bounds, bearer authentication, generation guard, sanitized errors, privacy contract, 13-tool catalog, and shutdown first-cause behavior are unchanged.

### Verification

| Command | Result |
|---|---|
| Server-authoritative deadline regression | Exit 0; 1/1 file, 3/3 selected tests; Vitest duration 1.60 s. |
| Focused integration/server/client/tools/manager | Exit 0; 5/5 files, 136/136 tests; final Vitest duration 8.43 s. |
| `npm test -- --run` | Exit 0; 18/18 files, 337/337 tests; final Vitest duration 13.31 s. |
| `npm run typecheck` | Exit 0. |
| `npm run build` | Exit 0. |
| `npm run smoke` | Exit 0; protocol health, authenticated event flow, and shutdown callback verified. |
| `npm run diagnose:mcp` | Exit 0; 1/1 test; exact 13-tool catalog and protocol-only stdout verified; Vitest duration 747 ms. |
| `npm run validate:plugin` | Exit 0. |
| `git diff --check` | Exit 0; no output. |

No package, install, merge, push, or release action was performed. Fresh independent re-review remains required before any Windows packaging decision.
