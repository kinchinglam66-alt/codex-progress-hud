# Same-turn Restart Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox syntax. User execution policy limits this work to one implementation pass, one consolidated review and at most one fix review.

**Goal:** Preserve confirmed same-turn ETA state across companion recreation without inventing time or usage.

**Architecture:** A bounded value-only checkpoint repository is composed into the server. PassiveGoals restores only after fresh native turn evidence, with fresh process-local identities. Startup reconciliation preserves accounting guards; lifecycle diagnostics distinguish producer roles and available exit evidence.

**Tech Stack:** TypeScript, Node >=22.13.0, Vitest, existing Zod and safe filesystem helpers; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-same-turn-restart-recovery-design.md`

**Review refinement:** Startup caller waits stay bounded, but expiry alone cannot release a potentially live launcher/child. A dispatched claim persists until confirmed exit or later verified absence. Shutdown completion requires an owned child exit event, not merely acceptance of a termination request. See the final implementation report for the non-atomic OS-spawn/PID-binding and conservative PID-reuse limitations.

## Global Constraints

- Restore only the same native conversation and native turn.
- Exclude unverifiable downtime from confirmed active time.
- Do not persist conversation text, model summaries, tool output, credentials, account identifiers or raw source paths in the recovery checkpoint.
- Keep the ledger, authorization, proxy and account configuration unchanged.
- At most 256 records and 1 MiB; seven-day cache retention; one-second change coalescing and five-second active checkpoint interval.
- No new benchmark, inference, install, push or production runtime manipulation.
- Unknown usage remains unknown. OS reboot proof is not proof of an ordinary companion restart.

## Task 1: Bounded checkpoint repository

**Files:** Create `src/server/goal-checkpoint.ts`, `tests/server/goal-checkpoint.test.ts`.

**Interfaces:** Export `GoalCheckpointRecord` and `GoalCheckpointRepository`. Record fields: sessionKey, turnKey, generation, estimateRevision, savedAtMs, activeSeconds, runtime, status, prediction (CountdownPrediction|null), progressFloor (number), timingUncertain (boolean). Export `createGoalCheckpointRepository({directory:string, sourceIdentity:string, isOwner:()=>Promise<boolean>, now?:()=>number})` returning `{load():Promise<GoalCheckpointRecord[]>, save(records:readonly GoalCheckpointRecord[]):Promise<void>}`. Source identity is an opaque hash; persistence wraps records with version 1 and this identity. No raw path is serialized.

- [x] Write red tests using a temporary directory: save/load roundtrip, source mismatch returns no records, invalid numeric/unknown fields rejected, expired records filtered, future timestamp rejected, oversized file rejected, newest 256 retained, linked target refused, ownership loss refuses save. Use real filesystem operations.

```ts
expect(await otherSource.load()).toEqual([]);
await expect(repo.save([{...record, activeSeconds: NaN}])).rejects.toThrow();
expect((await repo.load())[0]?.prediction?.errorPercent).toBe(30);
```

- [x] Run `npm test -- --run tests/server/goal-checkpoint.test.ts --maxWorkers=1` and record expected failures before source implementation.
- [x] Implement strict validation and repository. Serialize writes; verify owner immediately before mutation, verify regular files and trusted directory, write/flush unique sibling temp, atomic replacement. Preserve previous checkpoint on failure. Reject stale save ordering using serialized request order; clean only owned temporary files. Enforce byte cap before parsing or writing, not after unbounded read. Validate prediction anchor <= activeSeconds and progressFloor between 0 and 99.
- [x] Run focused tests and typecheck; self-review storage race behavior. Commit only task files and report red/green commands/results.

## Task 2: Native-turn recovery and server composition

**Files:** Modify `src/server/passive-goals.ts`, `src/server/http-server.ts`, `src/observer/conversation-source.ts` if stronger identity evidence is needed; update `src/server/conversation-projection.ts` / `src/ui/view-model.ts` only if required for progress-floor propagation. Create `tests/server/passive-goals-recovery.test.ts` and `tests/server/http-server-recovery.test.ts`.

**Interfaces:** Consume Task 1 repository. Add `PassiveGoals.checkpoint(nowMs:number, wallNowMs:number):GoalCheckpointRecord[]` and `restoreCheckpoint(records:readonly GoalCheckpointRecord[]):void`. Records remain pending until authenticated observation plus native execution evidence confirms the stored turn. Export no summaries/tickets/object identities. Add `ProgressServerOptions.goalCheckpointRepository?:GoalCheckpointRepository` for injected tests; compose default repository only for selected native source, using token-directory and hashed source-root identity.

- [x] Red tests: create eight goals, settle numeric predictions, checkpoint at 1200 active seconds, instantiate a new PassiveGoals with a different monotonic origin, restore records, attach same native turns, and assert 1200 seconds before the new clock advances. Assert no request while source is unconfirmed.

```ts
expect(after.view(key, 50)?.activeSeconds).toBe(1200);
expect(after.view(key, 1050)?.activeSeconds).toBe(1201);
expect(after.view(key, 1050)?.timingUncertain).toBe(true);
expect(JSON.stringify(records)).not.toContain('PRIVATE');
```

- [x] Cover pause/wait, new turn resets, terminal removes, stale response cannot settle, persisted revision/prediction error unchanged, source unavailable, clock rollback, repeated rediscovery and repeated restart. Server test recreates actual server with temporary repository and synthetic native-source files; assert persistence wiring, not merely repository mocks.
- [x] Implement recovery using pending value records and fresh goal/measurement identities. Reconcile fresh source before counting from new monotonic origin. Do not reuse process-local source epoch; do not discard restored estimate on ordinary summary bootstrap. Preserve progress high-water mark through presentation. Native terminal evidence remains authoritative even for a restored pause.
- [x] Compose load before accepted tracking begins, coalesced writes after meaningful mutations and five-second active ticks; orderly close flushes before clearing goals. Degraded persistence catches errors and surfaces local diagnostics without failing main task. Owner callback fences stale generations. Stop timers on shutdown. Pending recoveries cannot trigger inference until resolved.
- [x] Run focused recovery/passive-goals/conversation-source/countdown tests, then typecheck; commit task files with red/green report.

## Task 3: Startup and orphan-call evidence

**Files:** `src/desktop/observer-runtime.ts`, `tests/desktop/observer-runtime.test.ts`; `src/diagnostics/logger.ts`, `src/lifecycle/process-launcher.ts`, `src/lifecycle/companion-manager.ts`, `src/desktop/lifecycle.ts` and corresponding existing tests. If a failing cross-manager reproduction confirms a missing startup gate, add `src/lifecycle/startup-claim.ts` and `tests/lifecycle/startup-claim.test.ts` with manager integration tests.

**Interfaces:** Preserve public settings/auth APIs. Reuse existing accounting `recoveryStatus()` / `reconcileRecoveredPending(proof)`. Lifecycle log fields are bounded optional metadata, never child output or environment values.

- [x] Red test startup with recovered pending accounting and trusted pre-admission OS boot proof; assert ordinary startup attempts reconciliation without a settings click. Invalid/unavailable proof preserves pending status and leaves unrelated authorized operation available.

```ts
await runtime.start(new AbortController().signal);
expect(reconciledProofs).toEqual([trustedBootProof]);
expect(runtime.status().ready).toBe(true);
```

- [x] Factor a narrow helper to run only before delegates can become active, verify account binding/abort after awaited checks, and preserve original recovery semantics. Do not call the settings trial or create inference.
- [x] Reproduce two independent manager starts with shared on-disk state and delayed readiness. Only if both launch, introduce a separate bounded startup claim across observe/spawn/readiness; never hold the settings file lock while awaiting HTTP readiness. Validate stale owner/deadline and re-probe before takeover. Losing managers attach to authenticated readiness and respect disable/generation cancellation. Do not treat duplicate logger producers as duplicate processes.
- [x] Add bounded role/attempt/process/generation correlation and available child-exit/clean-shutdown evidence. Keep unknown exit reason explicit. Red/green logger and manager tests verify correlation and cancellation rather than literal source strings.
- [x] Run focused runtime/ledger recovery/lifecycle tests and typecheck; commit task files, record remaining unproven root cause.

## Task 4: Consolidated verification and report

**Files:** Update this plan checkboxes; create `docs/superpowers/reports/2026-09-12-same-turn-restart-recovery.md`.

- [x] Run `npm test -- --run --maxWorkers=1 --no-file-parallelism`, `npm run typecheck`, `npm run build`, `git diff --check` and record actual results.
- [x] One Sol/medium review covers spec compliance, storage/ownership, ledger and authorization boundaries across all implementation commits. Resolve findings with at most one fix review, per user policy. Main agent reviews task outputs as they arrive; do not dispatch repetitive review agents.
- [x] Report separately: state recovery verified, orphan reconciliation verified, startup race reproduced/fixed or unproven, original exit cause known/unknown. Preserve private benchmark artifacts. Do not merge/push/install without delivery authorization.
