# Automatic Estimator Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the fixed two-call ceiling and automatically recover abandoned estimates without a repair click or fabricated usage.

**Architecture:** Conversation-owned lazy workers share one serialized accounting owner. Durable per-invocation lifecycle evidence and idempotent local reconciliation replace globally blocking orphan records. Provider/account failures retain their proper scope.

**Tech Stack:** TypeScript, Electron, Node SQLite, Vitest, Windows process metadata.

**Spec:** `docs/superpowers/specs/2026-09-11-automatic-estimator-recovery-design.md` (approved 2026-09-11).

## Global Constraints

- No plugin-imposed total concurrent estimation-call ceiling by default.
- One active estimation request per conversation; coalesce additional triggers.
- Legacy calls without verifiable process identity may be abandoned after a conservative timeout, accepting possible remote overlap and additional usage.
- Preserve missing usage as unknown, never zero. No ledger deletion/reset.
- Ordinary recovery must not require a repair button, another login, or reboot.
- Legacy grace: five minutes; reconciliation check interval at most 30 seconds while unresolved records remain.
- Per-conversation repeated failure backoff: 1, 2, 5, 10, then 30 minutes; cap at 30 minutes.
- No production ledger mutation, real inference, installation, merge or push during implementation.
- User review policy: one implementation pass, one Sol-medium whole-change review, at most one scoped fix review. Luna-high implementation, no nested agents.

## Execution structure

One coupled implementation task with sequential red/green milestones: the ledger
schema, worker ownership and scheduler must agree before their behavior can ship.
Do not create separate review seats for interim milestones. Controller independently
checks acceptance coverage and executes final regression after the implementation.

### Task 1: Automatic recovery and conversation-owned execution

**Files:**
- Modify: `src/estimation/release-accounting.ts`, `subscription-accounting.ts`, `subscription-session.ts`, `owned-process.ts`, `observer-worker.ts`, `observer-scheduler.ts`, `long-task-policy.ts`.
- Modify: `src/estimation/accounting-worker-owner.ts`, `accounting-worker-entry.ts`, `accounting-worker-protocol.ts`, `observer-api-provider.ts`.
- Modify: `src/desktop/observer-runtime.ts`, `observer-recovery.ts`; relevant `src/core/observer-diagnostics.ts`, `src/ui/view-model.ts`, `settings-renderer.ts` consumers only where their recovery claims become obsolete.
- Create focused lifecycle/accounting helper modules under `src/estimation/` when needed to avoid extending the large ledger owner with unrelated responsibilities.
- Test: existing matching `tests/estimation/*.test.ts`, `tests/desktop/observer-runtime.test.ts`, `tests/desktop/observer-recovery.test.ts`, `tests/ui/settings-renderer.test.ts`.
- Create: `tests/estimation/automatic-recovery.test.ts` and `tests/estimation/conversation-worker-pool.test.ts` for integrated acceptance behaviors.

**Interfaces:**
- Keep `ObserverWorker.observe(input, signal, conversationKey)` and the external HUD protocol compatible.
- Introduce a lazy worker source: `acquire(conversationKey: string): ObserverWorker`, `release(conversationKey: string): Promise<void>`, `all(): readonly ObserverWorker[]`. Production allocation has no fixed size; tests can use an injected source. Scheduler must support lifecycle shutdown and recovery over dynamically created workers.
- Add `reconcileAutomatic(): Promise<{released: number; nextCheckAt: number | null}>` to the accounting-owner RPC boundary. Writer time comes from injected trusted clocks, never from renderer-supplied proof. First pass runs on acquisition; subsequent passes run while enabled.
- Add a typed invocation record bound to reservation: admission id, conversation/turn generation, owner UUID, provider kind, phase, deadline, optional PID plus creation identity, cleanup outcome. Validate at both RPC ends. Missing spawn identity is an unconfirmed dispatch window, not proof of no dispatch.
- Add `abandoned_unconfirmed` to settlement classification with an explicit unknown-use invariant. Existing migration must preserve all starts, known tokens and unknown history. Never silently grant a new trial by reopening a DB.
- Per-conversation retry state belongs to the durable ledger, not a volatile scheduler entry. An atomic admission transaction enforces one active claim and retry eligibility.

- [ ] **Step 1: Baseline and ledger regression RED.** Reuse temporary-ledger fixtures from `release-accounting-recovery.test.ts`; write tests for three simultaneous distinct-conversation reservations, same-conversation rejection, old pending reopening, grace threshold and repeated restart.

```ts
const reservations = await Promise.all(['a', 'b', 'c'].map(key => owner.forConversation(key).reserve()));
expect(reservations.filter(Boolean)).toHaveLength(3);
expect(await owner.forConversation('a').reserve()).toBeNull();
// Separate fixture: create pending, close owner, reopen with injected time.
// At admittedAt + 299_999 occupancy is retained; at +300_000 it is released.
expect((await reopened.reconcileAutomatic()).released).toBe(1);
expect(reopened.snapshot()).toMatchObject({inFlight: 0, unknown: 1, starts: 1});
expect((await reopened.reconcileAutomatic()).released).toBe(0);
```

Run: `npm test -- --run tests/estimation/release-accounting-recovery.test.ts tests/estimation/automatic-recovery.test.ts --maxWorkers=1 --no-file-parallelism --testTimeout=15000`. Observe the expected assertions fail before changing production logic. Adapt fixture construction to the real existing API without weakening assertions.

- [ ] **Step 2: Implement durable accounting transitions.** Bump/migrate the SQLite schema transactionally; remove two-pending validation/admission guards while retaining numeric overflow and storage integrity checks. Quarantine unconfirmed invocations per conversation. Legacy expiry uses persisted age, with a monotonic five-minute fallback for clock rollback/future timestamps. Persist retry claims and failure streak atomically. Do not let `recovery_safety` resurrect global orphan blocking after migration.

```ts
const retryDelays = [60_000, 120_000, 300_000, 600_000, 1_800_000] as const;
function delayForFailure(streak: number): number {
  return retryDelays[Math.min(Math.max(streak - 1, 0), retryDelays.length - 1)]!;
}
// One writer transaction: classify + unknown accounting + release occupancy +
// claim eligibility. Never UPDATE pending to known or represent missing tokens as 0.
```

- [ ] **Step 3: Run ledger GREEN and migration coverage.** Verify pre-threshold retention, post-threshold release, idempotency, expired legacy state, unknown-state compatibility, retry backoff across turns/restarts, corrupt storage and exclusive-writer rejection. Exercise RPC validation and worker-owner restart with real temporary SQLite stores.

- [ ] **Step 4: Owned invocation RED then GREEN.** Extend controlled process tests to verify identity is persisted before inference input is sent, same-PID/different-creation never permits termination, and close/usage are independent. Persist phase/deadline for HTTP cancellation. Confirm no arbitrary process killing. Handle crash between spawn and durable binding as unconfirmed. A successful result from an old turn cannot update a newer turn or settle a newer admission. Reuse `recovery-boot-boundary.ts` as optional stronger evidence, not a mandatory user action.

- [ ] **Step 5: Lazy concurrency and isolation RED.** Start at least five eligible conversations using real scheduler logic and deferred runner responses; verify they are all in flight before any resolves. Trigger another event for one of them and verify no duplicate invocation. Fail/poison one owned worker and resolve others; assert healthy forecasts are delivered and the scheduler remains enabled.

```ts
expect(scheduler.stats().inFlight).toBe(5);
expect(scheduler.stats().disabled).toBe(false);
// After one runner's cleanup fails, four independent results must still deliver.
expect(deliveredConversationKeys.sort()).toEqual(['b', 'c', 'd', 'e']);
```

- [ ] **Step 6: Implement lazy pool and automatic reconciliation wiring.** Replace fixed `SLOT_COUNT`, scheduler worker-array ceiling, `globalInFlight >= 2`, and global poisoning from invocation-local failure. Preserve genuine account-wide auth/quota/store failures. Start a reconciliation pass on acquisition and unresolved events; schedule the next deadline with at most 30 seconds between checks. Cancel timers on disable and isolate account changes. Recovery makes the real eligible request directly, never an idle synthetic trial. Clean up idle workers without erasing durable retry state.

- [ ] **Step 7: Integration GREEN and diagnostic coverage.** Connect actual temporary ledger, runtime and scheduler; show legacy recovery without a UI action, multiple live conversations, subsequent estimates after failures and no resurrection after restart. Cover revoke/disable/account-switch during recovery and old responses after new turns. Adjust UI diagnostics to describe automatic recovery/history, not permanent manual repair. Run affected suites and typecheck/build, fixing only regressions caused by these changes.

- [ ] **Step 8: Self-review and delivery report.** Record exact RED and GREEN commands/results, changed paths, unresolved limitations and known warnings in the task report. Commit only code/tests/public technical docs; do not stage private evidence or unrelated files. Do not claim real installed recovery was tested.

### Final integration gate (controller)

- [ ] Compare implementation and spec line by line, including API/CLI providers, migration, grace clocks, retry durability, pool disposal and truthful unknown usage.
- [ ] Run `npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000`, `npm run typecheck`, `npm run build`, `npm run validate:plugin`, and `git diff --check` on the final branch.
- [ ] Obtain one Sol-medium accounting/security/spec review of the complete branch. Apply one consolidated fix pass and scoped fix review if necessary.
- [ ] Summarize verified results and remaining real-install validation. Merge/push/install only on user request; preserve this worktree and evidence until handoff.
