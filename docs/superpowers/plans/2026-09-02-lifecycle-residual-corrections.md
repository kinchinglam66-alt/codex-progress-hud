# Lifecycle Residual Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three release-blocking lifecycle findings and the remaining canonical-timestamp validation gap before Windows packaging begins.

**Architecture:** A manager-launched HUD receives a generation-bound, non-explicit activation lease, while a user-issued tracking start may reopen only on its first acquisition and never after a stale retry. One operation budget is created before lifecycle state access and is threaded through cross-process lock acquisition and HTTP calls; request deadline expiry has a distinct internal error from observed offline. Persisted timestamps are accepted only when parsing round-trips to the exact canonical ISO string.

**Tech Stack:** TypeScript 7, Node.js 24, Electron 44, Vitest 4, MCP SDK 1.30, Zod 4.

**Spec:** `docs/superpowers/specs/2026-09-01-companion-lifecycle-release-design.md`

## Global Constraints

- A committed `desiredState: "off"` is authoritative over every startup or write that began under an older generation.
- Plain `--hud` and second-instance activation are explicit user activation; a manager launch and automatic login are not.
- A first, newly issued `tracking_start` may reopen an explicitly closed HUD, but retrying a pre-close `tracking_start` may not.
- The complete startup operation remains bounded by 8 seconds and the complete close operation remains bounded by 5 seconds, including state-lock waits.
- A request deadline is not evidence that the companion is offline; close must never report stopped solely because a live listener failed to respond.
- HTTP responses remain bounded to 64 KiB and no response body, task payload, token, prompt, path, command output, or environment value enters errors, logs, or diagnostics.
- Preserve all 13 MCP tools, authenticated generation guards, protocol-only stdout, PID/nonce forced-termination ownership, and the existing logging/report privacy contract.
- Do not begin Windows packaging, installation, merge, push, or release work in this plan.

---

### Task 1: Generation-bound manager launch and one-shot tracking activation

**Files:**
- Modify: `src/lifecycle/process-launcher.ts`
- Modify: `src/main.ts`
- Modify: `src/desktop/lifecycle.ts`
- Modify: `src/lifecycle/companion-manager.ts`
- Modify: `src/lifecycle/types.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `tests/desktop/entry-mode.test.ts`
- Modify: `tests/desktop/lifecycle.test.ts`
- Modify: `tests/lifecycle/companion-manager.test.ts`
- Modify: `tests/integration/companion-lifecycle.test.ts`

**Interfaces:**
- Produces: `ProcessLauncher.spawnHud(executablePath, { generation })` and an entry intent `{ mode: "hud", launchReason: "manager", generation }` for `--hud --manager-generation=<safe integer>`.
- Produces: a write lease acquired once per tool invocation; retry recovery may restart only the same generation and cannot call the explicit-reopen transition again.
- Consumes: `HudSettings.generation`, `LifecycleStateStore.writeRuntime(identity, generation)`, and server-side `runIfGeneration` from the existing branch.

- [ ] **Step 1: Write failing manager/desktop process tests**

Add behavior tests proving a real launcher passes a manager generation, a manager-intent desktop launch refuses `off` or a different generation without calling `setDesiredState("on")`, and a matching on-generation launch may publish runtime.

```ts
expect(spawn).toHaveBeenCalledWith(executable, ["--hud", "--manager-generation=7"], expect.anything());
await runDesktop(harness.dependencies, { kind: "manager", generation: 7 });
expect(harness.dependencies.createProgressServer).not.toHaveBeenCalled();
expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
```

- [ ] **Step 2: Write the failing stale `tracking_start` test**

Use two real managers/stores or the existing two-MCP fixture. Freeze a `tracking_start` after its first lease is acquired, commit close from the second process, release the stale submit so it receives `GENERATION_REJECTED`, and assert desired state remains off, no second on-generation is committed, and no tracking event is accepted.

```ts
expect((await store.readSettings()).desiredState).toBe("off");
expect(events).not.toContainEqual(expect.objectContaining({ type: "tracking_started" }));
```

- [ ] **Step 3: Run Task 1 RED tests**

Run: `npm test -- --run tests/desktop/entry-mode.test.ts tests/desktop/lifecycle.test.ts tests/lifecycle/companion-manager.test.ts tests/integration/companion-lifecycle.test.ts`

Expected: FAIL because manager launch is still plain explicit `--hud` and retry reacquires an activation-capable `tracking_start` lease.

- [ ] **Step 4: Implement the manager-generation launch intent**

Parse exactly one safe non-negative integer from `--manager-generation=<n>`. Reject malformed or duplicate manager-generation arguments. Explicit `--hud` remains explicit; `--automatic-login` remains automatic. Manager launch reads settings and proceeds only when `desiredState === "on" && generation === leaseGeneration`; it never calls `setDesiredState("on")`.

```ts
type DesktopLaunchReason =
  | { kind: "explicit" }
  | { kind: "automatic-login" }
  | { kind: "manager"; generation: number };
```

- [ ] **Step 5: Implement one-shot write lease recovery**

Acquire the explicit tracking-start transition at most once. On `OFFLINE`, recovery may restart the same generation. On `GENERATION_REJECTED` or a changed persisted generation, return a suppressed/stale result and never call `setDesiredState("on")` again for that invocation.

- [ ] **Step 6: Verify Task 1 GREEN and commit**

Run the Task 1 test command, then `npm run typecheck` and `git diff --check`.

Commit: `fix: keep manual off authoritative`

---

### Task 2: One end-to-end operation budget and truthful request timeout

**Files:**
- Modify: `src/lifecycle/state-lock.ts`
- Modify: `src/lifecycle/state-store.ts`
- Modify: `src/lifecycle/types.ts`
- Modify: `src/lifecycle/companion-manager.ts`
- Modify: `src/mcp/report-client.ts`
- Modify: `tests/lifecycle/state-store.test.ts`
- Modify: `tests/lifecycle/companion-manager.test.ts`
- Modify: `tests/mcp/report-client.test.ts`

**Interfaces:**
- Produces: optional `StateOperationOptions { timeoutMs?: number }` accepted by lifecycle store reads/writes/deletes and applied to cross-process lock acquisition.
- Produces: internal `HudClientErrorCode` value `REQUEST_TIMEOUT`, distinct from `OFFLINE`.
- Consumes: the manager's absolute startup/close deadline and converts it to `Math.max(0, deadline - now())` before every state or HTTP operation.

- [ ] **Step 1: Write failing complete-budget tests**

Hold the lifecycle lock from a separate process, call manager open/close with 90 ms injected budgets, and assert each settles before 300 ms without later publishing runtime or clearing a successor runtime.

```ts
const started = performance.now();
await expect(manager.close()).resolves.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
expect(performance.now() - started).toBeLessThan(300);
```

- [ ] **Step 2: Write the failing timeout-truthfulness test**

Run a real loopback listener that accepts the health request and never responds. Assert the client returns `REQUEST_TIMEOUT`, and `close()` returns a categorized `SHUTDOWN_TIMEOUT`/degraded result while desired state remains off; it must not return a code-free stopped snapshot or record `shutdown_complete`.

- [ ] **Step 3: Run Task 2 RED tests**

Run: `npm test -- --run tests/lifecycle/state-store.test.ts tests/lifecycle/companion-manager.test.ts tests/mcp/report-client.test.ts`

Expected: FAIL because lock waits use their own five-second timeout and fetch abort currently becomes `OFFLINE`.

- [ ] **Step 4: Bound state-lock acquisition with the caller's remaining budget**

Use the lower of the default lock timeout and caller `timeoutMs`. A zero/expired budget fails before lock acquisition or mutation. Keep cleanup ownership checks and stale-lock recovery unchanged. Thread remaining budgets through every manager store call, including the initial settings transition/read and runtime clear.

- [ ] **Step 5: Distinguish request timeout from offline**

Track whether the client's own deadline controller caused abort. Map that case to `REQUEST_TIMEOUT`; retain `OFFLINE` only for connection failure. Manager startup may retry request timeouts only while budget remains and ultimately returns `START_TIMEOUT`. Manager close maps initial or shutdown request timeout to `SHUTDOWN_TIMEOUT` and never claims observed stopped without an offline observation.

- [ ] **Step 6: Verify Task 2 GREEN and commit**

Run the Task 2 test command, `npm run typecheck`, and `git diff --check`.

Commit: `fix: enforce lifecycle operation deadlines`

---

### Task 3: Exact canonical timestamp validation and corrective acceptance gate

**Files:**
- Modify: `src/lifecycle/state-store.ts`
- Modify: `tests/lifecycle/state-store.test.ts`
- Modify: `tests/integration/companion-lifecycle.test.ts` only if the final real-process acceptance needs an assertion added
- Create: `docs/superpowers/reports/2026-09-02-lifecycle-residual-corrections.md`

**Interfaces:**
- Produces: canonical persisted timestamp validation where `new Date(value).toISOString() === value` after the existing exact-shape check.
- Provides: the acceptance boundary required before the Windows packaging plan.

- [ ] **Step 1: Write the failing impossible-date table case**

Add at least `2026-02-31T01:02:03.000Z` and a canonical valid leap date. The impossible date must fail schema parsing; the valid leap date must round-trip.

```ts
expect(() => runtimeSchema.parse({ ...runtime, startedAt: "2026-02-31T01:02:03.000Z" })).toThrow();
expect(parsed.startedAt).toBe("2028-02-29T01:02:03.000Z");
```

- [ ] **Step 2: Run the timestamp RED test**

Run: `npm test -- --run tests/lifecycle/state-store.test.ts -t "canonical timestamp"`

Expected: FAIL because `Date.parse` normalizes the impossible date.

- [ ] **Step 3: Implement exact round-trip validation**

Retain the fixed millisecond ISO shape and require parsing plus exact `toISOString()` equality. Do not accept timezone offsets, omitted milliseconds, or normalized impossible dates.

- [ ] **Step 4: Run the complete corrective gate**

Run:

```powershell
npm test -- --run
npm run typecheck
npm run build
npm run smoke
npm run diagnose:mcp
npm run validate:plugin
git diff --check
```

Then run the complete suite three additional fresh times and the two-MCP stale-tracking test once in a fresh Node process.

- [ ] **Step 5: Write the acceptance report and commit**

Record every command, test count, elapsed budget assertion, remaining limitation, and whether all four residual findings are closed. Do not claim packaged Electron validation.

Commit: `test: close lifecycle release blockers`

- [ ] **Step 6: Stop before Windows packaging**

Perform a task review and whole-correction review. Windows packaging begins only after both reviews report zero open Critical/Important findings.

---

### Task 4: Close the diagnostics logger lock-disappearance race

**Reason for amendment:** Task 3's required repeated full-suite gate exposed a real concurrent-release race in diagnostics logger lock inspection. Independent Task 3 review classified it as an Important whole-plan/release blocker.

**Files:**
- Modify: `src/diagnostics/logger.ts`
- Modify: `tests/diagnostics/logger.test.ts`
- Modify: `docs/superpowers/reports/2026-09-02-lifecycle-residual-corrections.md`

- [ ] **Step 1: Write a deterministic failing race test**

Exercise lock disappearance after the reader opens the lock file but before its second path identity check. Normal `ENOENT` must be treated as a retryable/disappeared lock observation, not an operational logger failure.

- [ ] **Step 2: Implement identity-safe disappearance handling**

Return a non-owned/missing observation when the second path `lstat` sees `ENOENT`. Preserve regular-file/no-symlink checks, handle identity validation, stale-owner cleanup, bounded retries, privacy, and cross-process serialization.

- [ ] **Step 3: Verify and update acceptance evidence**

Run the focused logger suite repeatedly, the complete suite at least three fresh times, typecheck, build, smoke, diagnose:mcp, validate:plugin, and `git diff --check`. Update the acceptance report with the fix and replace the open logger concern with verification evidence.

- [ ] **Step 4: Review and stop before packaging**

Perform an independent Task 4 review and then a whole-correction review. Do not package, install, merge, push, or release until both report zero open Critical/Important findings.

---

### Task 5: Close whole-correction review gaps

**Reason for amendment:** The first whole-correction review found three Important integration paths not covered by the task-level reviews.

**Files:**
- Modify: `src/desktop/lifecycle.ts`
- Modify: `src/lifecycle/companion-manager.ts`
- Modify: `src/mcp/report-client.ts`
- Modify: `tests/desktop/lifecycle.test.ts`
- Modify: `tests/lifecycle/companion-manager.test.ts`
- Modify: `tests/mcp/report-client.test.ts`
- Modify: `docs/superpowers/reports/2026-09-02-lifecycle-residual-corrections.md`

- [ ] **Step 1: Preserve manual off for automatic-login second instances**

Activate an existing primary instance only for parsed explicit launch intent. Ignore manager and automatic-login second-instance command lines.

- [ ] **Step 2: Converge retry-submit rejection and cancellation**

After the one allowed same-generation OFFLINE recovery, route retry `GENERATION_REJECTED` and manager-owned `REQUEST_CANCELLED` through stale/manual-off suppression. Never recover, spawn, show, or reactivate again.

- [ ] **Step 3: Include token read, executable check, and stale-spawn termination in the absolute deadline**

Make authenticated token loading abort/deadline aware with first-cause classification. Bound executable existence checks and stale-spawn termination with the existing absolute startup deadline; prevent late runtime/state publication.

- [ ] **Step 4: Verify, report, and review**

Add deterministic behavior tests with the existing 90 ms / `<300 ms` contract, run the focused and full release gates, update the acceptance report, and commit `fix: close final lifecycle review gaps`. Perform a fresh whole-correction re-review. Do not package/install/merge/push/release.
