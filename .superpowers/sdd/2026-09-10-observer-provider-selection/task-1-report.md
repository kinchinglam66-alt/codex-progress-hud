# Task 1 report: provider-neutral observation contract

Status: DONE_WITH_CONCERNS

## Implementation

- Added `src/estimation/observer-provider.ts` with `ProviderBinding`, `ObserverUsage`, generalized `ObserverResult`, and shared outcomes/timings/status types.
- Kept `ObserverSubscriptionResult` as `Omit<ObserverResult, 'usage'>` with the existing `SubscriptionUsage` member, so API usage cannot enter the subscription ledger through the scheduler contract.
- Updated scheduler/worker neutral contracts and dependent recovery/HTTP test consumers.
- Kept subscription parsing and settlement narrow; the worker adapts a subscription result only at the neutral boundary. Outer missing usage remains `null`; legacy nullable cached-token detail is represented as neutral `0` because `ObserverUsage.cachedInputTokens` is numeric.
- Added real scheduler consumer coverage for unchanged `api-tokens`, preserved `null` usage, and unknown-refresh estimate retention; added journal coverage for unchanged API usage kind.

## RED evidence

Command:

```text
npm run typecheck
```

Before implementation it failed with the expected missing-contract/type-boundary errors: `TS2307` for `observer-provider.js`, missing `ObserverSubscriptionResult` in the migrated scheduler test, and `TS2322` rejecting `api-tokens` at the subscription-only journal boundary.

## GREEN evidence

- `npm run typecheck` — exit 0.
- `npm test -- --run tests/estimation/observer-scheduler.test.ts tests/estimation/subscription-session.test.ts tests/evaluation/pilot-journal.test.ts` — 3 files passed, 108 tests passed.
- `npm test -- --run tests/estimation/observer-worker.test.ts` — 1 file passed, 9 tests passed. Node emitted only the existing SQLite experimental warning.
- `git diff --check` — clean.

The full suite and the ongoing baseline controller-run were not rerun.

## Explicit task files

`src/estimation/observer-provider.ts`, `src/estimation/subscription-session.ts`, `src/estimation/observer-scheduler.ts`, `src/estimation/observer-worker.ts`, `src/desktop/observer-runtime.ts`, `tests/estimation/observer-scheduler.test.ts`, `tests/estimation/observer-scheduler-recovery.test.ts`, `tests/desktop/observer-recovery.test.ts`, `tests/server/turn-http.test.ts`, and `tests/evaluation/pilot-journal.test.ts`.

Commit: da6abb8
