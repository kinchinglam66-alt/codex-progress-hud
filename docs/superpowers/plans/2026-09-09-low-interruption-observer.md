# Low-interruption observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember scoped user consent, recover safely from ordinary failures, and stop falsely showing idle conversations as executing.

**Architecture:** Keep consent separate from short-lived identity attestations. Persist recovery circuit/admission policy in the accounting owner; the scheduler consumes it and cannot override it. Local authenticated turn evidence owns runtime status independently of model goal classification.

**Tech Stack:** TypeScript, Electron, Node SQLite, Vitest, Windows private storage.

**Spec:** ../specs/2026-09-09-low-interruption-observer-design.md (written spec approved by user).

## Global Constraints

- Existing model remains gpt-5.6-luna with medium reasoning.
- No real inference, production mutation, install, main edits, Git merge/push, or login changes during this implementation.
- No default estimation-frequency increase or paid API fallback.
- Transient pre-dispatch retry delays:10s,30s; the third consecutive failure opens the5-minute circuit (preempts the originally listed120s third retry). Circuit threshold is not relaxed.
- Circuit opens at three consecutive recoverable failures or three unknown-usage events in a rolling 60-minute global window; cooldown5min, then15min, then60min on half-open failure.
- Durable limits survive restart and conversation switching; half-open permits only one eligible-task attempt, never idle probing.
- Unknown use stays unknown. Do not fabricate known usage or user-confirmed recovery coverage.
- Corrupt accounting, uncertain process closure, unverified identity, and invalid runtime remain dispatch blockers.
- Existing isolated snapshot is not Git; preserve baseline privately rather than initializing a new repository.

## Task 1: Truthful runtime state (controller-local)

**Files:** Modify src/server/passive-goals.ts, src/server/turn-router.ts or existing source/projection consumers only when reproductions identify necessity. Test tests/server/passive-goals.test.ts, tests/server/goal-projection.test.ts, tests/server/turn-router.test.ts and existing context-source tests.

**Interfaces:** Keep PassiveGoalView.runtime authoritative for execution; status remains goal classification. PassiveGoals.observe consumes only authenticated accepted HookEnvelope. Explicit runtime(...,'running',...) is a verified-host resume boundary, not a model callback.

- [x] Add and run this behavioral regression using the existing fixture:

```ts
const f = fixture(); const key = f.hook('UserPromptSubmit', 0);
f.hook('Stop', 1000); f.hook('PostToolUse', 2000);
expect(f.goals.view(key, 5000)?.runtime).toBe('waiting');
expect(f.goals.view(key, 5000)?.activeSeconds).toBe(1);
```

- [x] Add stale model reply, genuinely new turn, same-turn duplicate prompt, verified resume and other-conversation cases before changing their behavior.
- [x] Implement per-turn stop barriers. Inspect finalAvailable/source ordering before adding missing-Stop reconciliation; no timeout-only completed/idle inference.
- [x] Ensure display uses runtime rather than model-running status and excludes inactive rows according to spec. Missing liveness becomes status-unknown with uncertain timing, not fabricated completion.
- [x] Run `npx vitest run tests/server/passive-goals.test.ts tests/server/goal-projection.test.ts --maxWorkers=1 --no-file-parallelism` and affected router/source/UI tests. Record RED/GREEN and exact changed files in private report.

## Task 2: Persisted consent and bounded recovery (one Luna high implementer)

**Files:** Create dedicated consent store and retry policy modules as needed; modify src/estimation/observer-consent.ts, src/desktop/observer-consent-dialog.ts, observer-runtime.ts, observer-pilot.ts, observer-settings.ts, src/ui/settings-renderer.ts/settings-preload.cjs/settings.html, src/estimation/observer-scheduler.ts, release-accounting.ts and accounting-worker protocol/entry/owner. Tests remain under tests/desktop and tests/estimation. Controller owns Task1 server/main HUD renderer files; coordinate shared lifecycle/diagnostics types rather than overwriting.

**Interfaces:** Runtime restores only scoped fresh verified consent. Settings offers revocation, never an untrusted grant endpoint. Accounting worker is sole owner of durable automatic recovery policy; reserve/settle/cancel remain serialized. Scheduler accesses a typed status/admission decision and never directly edits SQLite or resets counters. Existing manual recovery remains usable for hard stops; it cannot erase historical policy counters.

- [x] Add behavior tests for restarting a consent gate with a valid stored grant, scope/account change rejection, revocation, and temporary attestation expiry suspension/revalidation. Use fake encryption only at the platform boundary; test storage validation and actual runtime behavior.
- [x] Implement protected versioned scoped storage, persistent-grant restoration after identity checks, one updated native disclosure, and settings revocation. Separate stable scope from ephemeral proxy/assets fingerprints without skipping independent runtime validation.
- [x] Add a pure policy reducer with literal fixed-clock tests:

```ts
// Expected timings are spec literals, not computed from implementation constants.
// Failure1 -> retry eligible at +10_000; failure2 -> +30_000.
// Failure3 -> cooldown at least +300_000; cooldown expiration grants
// only one half-open attempt if a task is eligible, never concurrent slots.
// A later half-open failure -> +900_000 then +3_600_000.
```

- [x] Persist policy events/counters atomically with admission outcomes. Include restart tests at each reservation/settlement boundary and malformed/forged-record rejection. Preserve earlier v2/v3/v4 migration, coverage, ordinal provenance, and pruning tests.
- [x] Wire scheduler/runtime: retry only proven eligible recoverable outcomes; valid unknown usage warns without global permanent disable within allowance; fatal/uncertain closure still stops. Identity revalidation is cancellable and not an inference request.
- [x] Add integration tests across worker protocol, runtime, scheduler, settings showing durable cooldown, half-open exclusivity, cancel/disable, and no idle model calls. Publish diagnostic cooldown/next-eligible state without changing ETA frequency.
- [x] Run focused tests for modified files, typecheck, and build. Report exact RED/GREEN, interfaces and residual concerns. Do not run full suite concurrently with controller's final gate.

## Task 3: Combined verification and review

- [x] Compare final src/tests to private baseline; verify no production/main/installation files changed.
- [x] One Sol medium review covers both spec compliance and security/accounting/concurrency quality, using bounded diff files and reports. At most one repair+scoped re-review, per AGENTS.md (overrides per-task multi-review skill loops). The final remaining review finding was repaired in the frozen source and independently exercised by the main focused/full gates; a second independent reviewer pass was unavailable after the review agent closed on quota.
- [x] Run final `npx vitest run --maxWorkers=1 --no-file-parallelism`, `npm run typecheck`, `npm run build` after source freeze.
- [x] Run isolated packaged lifecycle/settings bridge checks if packaging is prepared. Do not run real inference or modify installed program; report installation as separate follow-up.
- [x] Preserve baseline/reports and update progress ledger. No automatic cleanup of nongit source/evidence.
