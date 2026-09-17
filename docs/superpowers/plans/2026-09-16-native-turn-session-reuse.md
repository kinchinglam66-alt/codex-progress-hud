# Native Turn Session Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute inline as previously requested by the user.

**Goal:** Reuse a native-seeded observer within one source turn without losing source-prefix integrity or request authority boundaries.

**Architecture:** Immutable completed-turn base, one independently owned estimation child per source turn, canonical source-prefix verification and append-only deltas. Candidate is internal and default off; the fresh-child control remains unchanged.

**Tech Stack:** TypeScript, Vitest, pinned Codex app-server, existing Windows custody and accounting adapters.

**Spec:** `docs/superpowers/specs/2026-09-16-native-turn-session-reuse-design.md`

## Global constraints

- `gpt-5.6-luna / medium / standard`; synthetic-only validation.
- No installed-default changes, authority/TTL relaxation, deprecated rollback or fabricated cache parameters.
- Existing linked worktree only; preserve unrelated dirty changes. Do not stage all files or commit this mixed milestone automatically.
- One implementation pass, one bounded architectural/accounting review, at most one fix review.

### Task 1: Complete-prefix validation

Files: `src/estimation/observer-persistent-session.ts`, `tests/estimation/observer-persistent-session.test.ts`.

- [ ] Add tests around acknowledged non-inline source: exact replay succeeds, append grows ordinal, rewritten prefix fails, shortened snapshot fails, changed image fails. Include previously compacted history and cancellation after injection acknowledgement.
- [ ] Introduce a session operation accepting the complete canonical record snapshot (same `PersistentSourceRecord` type), validating prefix hashes and contiguous ordinals before allowing append/dispatch. Store only bounded existing source metadata; do not retain another unbounded raw history copy.
- [ ] Keep the inline one-shot rejection intact. Verify candidate records cannot silently fall back into `stageSupplement`.
- [ ] Run focused session tests, demonstrate red/green for shortened-prefix detection, record output.

### Task 2: Worker reuse lifecycle

Files: `src/estimation/observer-persistent-worker.ts`; test additions beside existing native worker/turn tests.

- [ ] Add default-false `reuseNativeTurnSession?: boolean`. Reject incompatible candidate options at construction:

```ts
if (options.reuseNativeTurnSession &&
    (!options.completedTurnContext || !options.nativeContext || options.inlineCurrentTurnSupplement)) {
  throw Error('NATIVE_TURN_REUSE_OPTIONS_INVALID');
}
```

- [ ] In `ensure`, compute reuse eligibility only after fresh preparation and binding checks. Revalidate `nativeBase.acquire` against the same immutable boundary and source. Return existing healthy session only for that same turn; otherwise preserve original new-child path.
- [ ] In current-turn preparation, canonicalize and validate the complete supplement before appending new records. Preserve aliases on same-turn reuse; reject shorter/changed prefixes and stale revisions. On failure use existing reset path, not automatic model retry.
- [ ] Add worker integration tests asserting the same child ID for two candidate estimates, distinct child for new turn, fresh request proofs/accounting IDs, unchanged default behavior, and cleanup on cancelled/ambiguous requests or account changes.
- [ ] Run focused worker/session tests plus typecheck; fix only regressions in this scope.

### Task 3: Diagnostic and evidence

Files: `src/evaluation/native-comparison-options.ts`, `src/evaluation/native-comparison-input.ts`, `scripts/diagnostics/native-context-compare.mjs`, corresponding evaluation tests.

- [ ] Add explicit candidate diagnostic selection; do not overload existing fresh-fork assertions. Record child creation/reuse and source binding per request. Reject cross-turn reuse and concurrent conflicting requests in tests.
- [ ] Add an answer-free source-correction fixture: new user/tool evidence supersedes an earlier contradictory observer prediction. Verify latest source facts, no inherited prediction promoted to source progress, preserved oldest history and images.
- [ ] Run focused evaluation tests, full regression/typecheck/build at milestone, then one Sol medium bounded architectural/accounting review under the user's agent routing policy if available.
- [ ] Register a separate bounded synthetic experiment before inference. Compare candidate/control at ordinary cadence; record all token fields and preparation/inference/delivery/cleanup. No real-history transfer or installation. Stop on actual call failure; unknown usage remains separately recorded.
- [ ] Save result and remaining risks; only later consider enabling/installing after evidence. A zero-cache result is not justification for automatically repeating the batch.
