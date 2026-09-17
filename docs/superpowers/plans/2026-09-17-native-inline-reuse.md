# Native Inline Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user chose implementation in the current task; do not create another user-owned task.

**Goal:** Remove the initial supplement injection round trip without losing same-turn source-prefix validation and retained-child reuse.

**Architecture:** An opt-in session tracks source acceptance independently of injection/submission counters. Initial eligible source text travels in turn/start; only confirmed successful completion makes it reusable. Later source deltas use existing injection.

**Tech Stack:** TypeScript, Vitest, existing Codex0.153.4 pinned runtime and Windows custody helpers.

**Spec:** `docs/superpowers/specs/2026-09-17-native-inline-reuse-design.md`.

## Global Constraints

- Default off; no merge, push or installation in this milestone.
- No real history; preserve split-v2 timing, source, accounting and cleanup gates.
- Preserve unrelated dirty work. No automatic commits of mixed existing changes.
- Keep injection cursor/counts separate from acceptedThroughOrdinal; unknown usage is never zero.
- No failed-call retries in synthetic experiments; preregister each bounded experiment.

## Task1: Session transport-aware acceptance

Files: `src/estimation/observer-persistent-session.ts`, `tests/estimation/observer-persistent-session.test.ts`.
Interface: optional session option `retainSubmittedSupplement?:boolean`; status gains `acceptedThroughOrdinal:number|null`. Existing appendSnapshot signature remains unchanged.

- [ ] Add a real-session test using existing RPC fixture: stage records0–1, complete valid estimate, replay snapshot0–1, append snapshot0–2. Assert the captured turn/start contains exactly records0–1, replay makes no inject_items call, delta injection contains only record2, acceptedThroughOrdinal is2, importedRecords is1, submittedRecords is2. Before implementation it must fail at opt-in successful replay, not fixture setup.
- [ ] Add rejection cases: mutated record0, shorter snapshot, skipped ordinal, abort during first estimate, invalid JSON interpretation and usage-evidence write failure. Assert no subsequent injection/start and session unavailable after failure. Keep existing legacy one-shot test unchanged.
- [ ] Add `acceptedCursor=-1` independent of injected cursor. Injection success updates both accepted digest/cursor and transport counters; prefix validation/contiguity uses accepted cursor. For legacy sessions accepted cursor follows existing injection state.
- [ ] Copy staged records before turn/start. Keep their ownership until terminal resolution. Only after `await Promise.all(writeTasks)` and valid completed noncancelled interpretation commit their digests, accepted cursor and resident encoded bytes when capability enabled. On any unsuccessful inline result keep session uncertain; submitted counters remain truthful.
- [ ] Gate existing one-shot checks only for the explicitly eligible retained-submission capability, never globally. Update compaction-covered source ordinal to canonical accepted cursor. Exercise complete fallback before submission and exact-once capacity charging.
- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/observer-persistent-session.test.ts` and `D:/node.exe node_modules/typescript/bin/tsc --noEmit`; retain red/green evidence.

## Task2: Worker complete-snapshot integration

Files: `src/estimation/observer-persistent-worker.ts`, `tests/estimation/observer-persistent-worker.test.ts`.
Consumes Task1's option/status; preserves existing request proof, release permit and native source lifecycle interfaces.

- [ ] Add worker test for initial inline estimate and retained same-turn append: one base/two total forks, no initial supplement injection, exactly one later suffix injection. Add new-turn case requiring a fresh child, account-change and cancellation cases requiring reset.
- [ ] Pass retainSubmittedSupplement only when all three internal modes are enabled. Preserve rejection of reuse without completed-turn/native resources; remove only the tested inline incompatibility.
- [ ] After complete source coverage and image checks, attempt existing stageSupplement on a fresh complete snapshot. If ineligible, use appendSnapshot in full. Subsequent snapshots cannot restage an accepted prefix; appendSnapshot validates it first.
- [ ] Surface acceptedThroughOrdinal separately from injected representation fields. Confirm resource byte totals include staged/accepted inline bytes exactly once and no private content enters diagnostics.
- [ ] Run session/worker/native timing tests and typecheck. Real Windows custody cases may need the existing escalated test invocation; never relax custody checks.

## Task3: Diagnostic selection, review and qualification

Files: `src/evaluation/native-comparison-options.ts`, its tests, `scripts/diagnostics/native-context-compare.mjs`, registration/report under existing experiment directory.

- [ ] Add option-validation tests allowing inline+reuse only for the registered completed-turn candidate; preserve illegal-mode failures and default-off behavior. Ensure readback uses submitted source on initial inline and injected source on later deltas, not stale first-request counters.
- [ ] Test request framing/source digests and build the candidate. Inspect diagnostics for leakage and nested timing interpretation.
- [ ] One Sol/medium final review of source acceptance, authorization, ledger and evaluation validity, with explicit routing; at most one fix review. Do not claim release readiness from unit tests.
- [ ] Register and execute one synthetic compatibility sequence (three ETA: initial, same-turn append, new source turn; zero intended compression, fixed fixture within capacity). Stop on failure and retain records. Check first-source/image/current-goal markers and cleanup.
- [ ] Only after compatibility passes, run the unchanged split-v2 qualification protocol. If any gate fails, stop expansion and diagnose. If all stages pass, perform the spec's fresh-nonce/reversed-order confirmations before recommending promotion.

## Self-review

Session task covers source state, transport counters, cancellation, ownership and fallback. Worker task covers source coverage, new-turn isolation and resource accounting. Diagnostic task covers framing, model evidence and unchanged acceptance criteria. This plan does not promise improvements to the separate full-context token-volume problem; that remains an explicit qualification gate, not waived debt.
