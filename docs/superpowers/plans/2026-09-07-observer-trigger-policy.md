# Observer Trigger Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute the checkboxes with TDD.

**Goal:** Make quiet running work and exhausted estimates eligible for bounded checks without changing spend authorization.

**Architecture:** A pure decision function selects a static reason and earliest eligible instant. The scheduler reserves work, owns identity/active clocks and keeps round-robin fairness. The journal explicitly projects only bounded static/numeric diagnostics.

**Tech Stack:** TypeScript, Vitest synthetic virtual clocks, existing PassiveGoals/ObserverScheduler.

**Spec:** docs/superpowers/specs/2026-09-07-observer-trigger-policy-design.md

## Global Constraints

- Initial 15 seconds; event coalescing 10 seconds; cooldown 60 wall seconds.
- Ordinary intervals 300/600/900/1800 active seconds at <=1800/7200/28800/>28800 remaining seconds.
- No-estimate/repeated-expired timer answers back off 300/600/1800 active seconds.
- Overdue grace 15 active seconds; one reservation per accepted non-null prediction.
- Rolling-hour 12 starts per conversation, at most two global workers, one request per goal.
- No live inference, installation, push, auth/accounting policy changes.
- Preserve stage-one dirty files. Work directly on main under the prior user instruction.

## Task 1: Coupled decision and scheduler implementation

Files: src/estimation/long-task-policy.ts, observer-scheduler.ts,
src/server/passive-goals.ts; tests/estimation/long-task-policy.test.ts,
observer-scheduler.test.ts, and focused new trigger integration tests if useful.

Interfaces: export TriggerReason union 'initial'|'important_event'|'status_evidence'|
'overdue'|'periodic'|'pre_dispatch_retry'. Decision returns reason or blockReason plus
earliest eligible wall/active anchor when computable; no false wall deadline for
unknown capacity availability. Keep requestBlockReason/canRequest wrappers compatible.
ObserverObservation adds optional triggerReason, lastRequestActiveSeconds and
eligibleActiveSeconds numeric fields (not task text). Goal scheduling may expose
opaque local goal/prediction identity; never add it to model inputs or journal.

- [x] Add virtual-clock worker-invocation tests: first call at 15s; accepted 600s
  forecast then no new prose; next ordinary call after 300 active seconds, not
  299. Pausing for one hour must not advance that active interval.
- [x] Add overdue-with-null-action-ID: central ETA expires, grace/cooldown honored,
  no second overdue reservation for unchanged prediction. If a new returned estimate
  is already expired, repeated timer-only calls must back off.
- [x] Add burst coalescing anchored at first event, pending events arriving in flight,
  goal/source replacement and stale reply, hourly cap and multi-conversation fairness.
- [x] Run focused tests and observe expected failures before implementation.
- [x] Implement active-clock policy and explicit reasons. Example boundary:
  `activeSeconds - lastRequestActiveSeconds >= 300` for a short periodic check;
  wall-time difference still must meet cooldown. New text is not mandatory, observed
  active progress and ready/running state are mandatory for timer-only checks.
- [x] Introduce opaque goal-lifetime and accepted-prediction tokens inside PassiveGoals
  if needed; do not identify predictions by ETA number or current action. Rejection
  of stale tickets must also fence scheduler anchor/retry updates.
- [x] Preserve ready gate, event batching, hard limits and worker safety branches.
  Keep latest-amendment event evidence pending across an in-flight result. Use
  deterministic reason priority within a conversation and fair cross-conversation
  rotation rather than unbounded priority starvation.
- [x] Update old tests that explicitly assert superseded timing/no-text behavior;
  do not weaken accounting, cancellation or isolation tests.
- [x] Run focused tests and typecheck; report changed paths and test evidence.

## Task 2: Metadata journal integration and final verification

Files: src/evaluation/pilot-journal.ts; tests/evaluation/pilot-journal.test.ts;
this plan and associated spec status. Main agent owns this disjoint write scope.

- [x] Add synthetic journal test supplying allowed triggerReason and finite anchors,
  plus unexpected private fields; assert allowed fields persisted and private fields
  absent. Unknown reason strings and nonfinite numeric anchors must not be persisted.
- [x] Run to observe failure, then extend explicit projection with an allowlist of
  the six TriggerReason codes and finite nonnegative numeric anchors.
- [x] Run journal tests independently while Task 1 progresses.
- [x] Integrate and run typecheck/build and focused scheduling/journal tests.
- [x] Run one full regression after implementation stabilizes. Request one Sol
  medium review, at most one scoped fix review under user routing policy.
- [x] Record actual results and source-only limitations; no ETA accuracy claim.

## Execution rulings

- One implementation worker (Luna high for concurrency/state coupling), one main
  journal integration pass, one Sol medium review; no duplicate per-task/final seats.
  This follows the user's more specific subagent-cost policy.
- First-stage uncommitted changes are a prerequisite and remain untouched by Task 1.
- Trigger selection does not invent machine-readable failure fields: inspect the
  existing event path and promote only signals backed by structured host data.

## Review checkpoint

Initial integrated typecheck/build and 124 files / 1,481 tests passed. Independent
review nevertheless identified missing production structured-failure routing and
six clock/identity/queue boundary issues. One combined fix wave and the sole scoped
fix review have finished; the feature is not accepted or installed. Extra write scope was limited
to authenticated Hook metadata/HTTP scheduling integration and its covering tests.
No generic text classification or authorization change is permitted.

## Previous fix-review outcome: acceptance deferred (subsequently resolved below)

Five original findings were addressed: accepted-goal anchor rebasing, ordinary
checks after overdue reservation, stale-reply identity fencing, cross-conversation
rotation, and same-millisecond event sequencing. Remaining work:

- [x] P1: Remove the unconditional unknown-answer/no-new-text gate. Add timer-only
  tests proving successive 300/600/1800 active-second retry opportunities with
  unchanged ready input. Superseded no-retry tests were corrected.
- [x] P1: Exclude source-unavailable duration from the scheduler's effective ETA
  clock, not just the ordinary polling anchor. Preserve the overdue reservation
  across recovery. Test a forecast spanning an outage and recovery after a prior
  overdue reservation; neither outage-induced expiry nor duplicate reservation
  is acceptable. Do not change the HUD work clock as a side effect.
- [x] P2: Accept bounded safe integer negative exit codes as well as positive
  nonzero codes in structured Hook normalization and HTTP event routing. Add
  ingress/schema tests; do not infer failures from prose.

Typecheck/build passed after the fix wave. Worker reported 131 focused tests and
23 adjacent tests passed. Main final full suite passed: 124 files / 1,489 tests,
303.16 seconds, exit code 0. `git diff --check` also passed. Passing
tests do not override the three confirmed specification gaps above. No live
inference, accuracy evaluation, installation, commit, or push was performed.

## Authorized follow-up repair

All three deferred findings are resolved in the local working tree. Seven
expected test failures reproduced the defects before production changes; after
repair, 135 focused tests and typecheck/build passed. The same Sol/medium reviewer
approved the targeted follow-up with no P1/P2 residuals. Final full regression
passed: **124 files / 1,493 tests**, 295.83 seconds, exit code 0. Typecheck,
build and `git diff --check` passed. Local source acceptance is complete.

Source outages are sampled conservatively: an active-time interval with either
endpoint unavailable is excluded by shifting scheduler anchors and prediction
age. In-flight estimates inherit exclusions accumulated after dispatch; existing
overdue reservations survive recovery. Goal lifetime resets prevent cross-goal
clock state leakage. HUD work time and model input active time remain unchanged.

No installation, commit, push, real observer inference or accuracy evaluation.
