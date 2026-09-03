# Task 3: Truthful task evidence and ETA uncertainty

## Status

Implemented and self-reviewed in the Task 3 worktree. Earlier protocol work through `80959d9` was not changed.

## TDD evidence

### RED

Command:

```text
npx vitest run tests/core/reducer.test.ts tests/core/eta.test.ts --reporter=verbose
```

Observed result before production changes:

```text
Test Files  2 failed (2)
Tests  16 failed | 20 passed (36)
```

The failures were the new runtime transitions, ETA confidence/signals and uncertainty cases, and idempotent timing expectations that the pre-Task-3 implementation did not provide.

### GREEN

Focused core command:

```text
npx vitest run tests/core/reducer.test.ts tests/core/eta.test.ts tests/core/calibration.test.ts --reporter=verbose
```

Observed result:

```text
Test Files  3 passed (3)
Tests  39 passed (39)
```

Typecheck command:

```text
npm run typecheck
```

Observed result: exit code `0`.

The required one-time broad suite was run before this bookkeeping-only resume:

```text
npm test -- --run
```

Observed result:

```text
Test Files  20 passed (20)
Tests  378 passed (378)
```

Formatting check:

```text
git diff --check
```

Observed result: exit code `0`.

## Implemented behavior

- Added runtime evidence and statuses for quiescence, session end, disconnect suspicion, late attachment, reconnect recovery, runtime timestamps, volatility, and validation evidence.
- Kept legacy progress event variants parseable while adding the runtime evidence variants.
- Kept completion/interruption precedence in the single pure `reduceTask` reducer. Runtime failure/interruption remains authoritative; only verified completion records validation evidence; stop is quiescent, not completion.
- Added active-work-only ETA intervals with confidence classes/signals, late-attachment widening, volatility widening, and optional deterministic calibration blending.
- Added strict, content-free calibration aggregation and minimum-sample lookup using only anonymous phase class, duration, estimate error, and outcome category.

## Files

Modified:

- `src/core/types.ts`
- `src/core/schema.ts`
- `src/core/reducer.ts`
- `src/core/eta.ts`
- `src/ui/view-model.ts`
- `tests/core/reducer.test.ts`
- `tests/core/eta.test.ts`

Created:

- `src/core/calibration.ts`
- `tests/core/calibration.test.ts`

## Self-review and scope note

`src/ui/view-model.ts` required a minimal compatibility update because its existing `statusPresentation` is an exhaustive `Record<TaskStatus, ...>`. Adding `quiescent`, `disconnected_suspected`, and `ended_unknown` made typecheck fail until all three statuses had presentations. Their ETA labels were added alongside the entries so the new states do not fall through to a misleading generic estimation message. No Hooks, lease, store, settings, cache, install, publish, merge, or unrelated refactor was added.

## Concerns

None known after focused tests, typecheck, full suite, and diff-check verification. Calibration persistence and later task/store wiring remain intentionally out of scope for Task 3.
