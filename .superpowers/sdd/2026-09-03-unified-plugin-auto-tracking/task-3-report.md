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

## Fix Round 1

### RED

Fresh regression command:

```text
npx vitest run tests/core/reducer.test.ts tests/core/eta.test.ts tests/core/calibration.test.ts --reporter=verbose
```

Observed before the fixes:

```text
Test Files  2 failed | 1 passed (3)
Tests  8 failed | 40 passed (48)
```

The failures reproduced legacy verified-only success, failed validation being treated as proof, paused/stopped suppression of SessionEnd and lease loss, missing validation-event parsing, and midpoint-only calibration blending.

### GREEN

Focused regression command:

```text
npx vitest run tests/core/reducer.test.ts tests/core/eta.test.ts tests/core/calibration.test.ts --reporter=verbose
```

Observed result after the fixes:

```text
Test Files  3 passed (3)
Tests  48 passed (48)
```

Typecheck command:

```text
npm run typecheck
```

The first post-fix typecheck identified the expected existing UI fixture gap for required ETA fields; after adding only those fields to `tests/ui/view-model.test.ts`, the final observed result was exit code `0`.

Because the core public type changed, the required full suite was run once:

```text
npm test -- --run
```

Observed result:

```text
Test Files  20 passed (20)
Tests  387 passed (387)
```

### Fixes and files

- `src/core/schema.ts` and `src/core/types.ts`: added bounded `validation_observed` with `result: "passed" | "failed"`; made ETA confidence class/signals required; retained legacy `verified` parsing.
- `src/core/reducer.ts`: requires prior observed passing validation plus `verified: true` for `succeeded_verified`; legacy verified-only and failed-validation completions are `completed_unverified` without fabricated pass evidence; SessionEnd and lease loss classify every nonterminal state, including paused/stopped.
- `src/core/eta.ts`: blends calibration lower and upper bounds using a deterministic confidence weight, clamps the resulting finite nonnegative interval, and retains required metadata.
- `src/ui/view-model.ts`: removed the three round-0 ETA label branches; only the exhaustive entries for the new `TaskStatus` values remain for later UI presentation work.
- `tests/core/reducer.test.ts`, `tests/core/eta.test.ts`: added regression coverage for proof gating, runtime precedence, asymmetric interval blending, and no-ETA statuses.
- `tests/ui/view-model.test.ts`: supplied the required ETA metadata in the existing compatibility fixture.

Final `git diff --check` was clean. No subagents, broad-scope refactor, settings/cache change, install, push, publish, merge, or unrelated behavior change was performed.

## Fix Round 2

### RED

Fresh focused UI command:

```text
npx vitest run tests/ui/view-model.test.ts --reporter=verbose
```

Observed before restoring the status-specific labels:

```text
Test Files  1 failed (1)
Tests  3 failed | 7 passed (10)
```

Each failure showed a new runtime status falling through to the generic `正在估算剩余时间` text.

### GREEN

Focused UI command:

```text
npx vitest run tests/ui/view-model.test.ts --reporter=verbose
```

Observed result:

```text
Test Files  1 passed (1)
Tests  10 passed (10)
```

Typecheck command:

```text
npm run typecheck
```

Observed result: exit code `0`.

### Fix and self-review

- `tests/ui/view-model.test.ts`: added behavior tests for truthful ETA labels for `quiescent`, `disconnected_suspected`, and `ended_unknown`.
- `src/ui/view-model.ts`: restored exactly three minimal `etaLabel` branches required for exhaustive-enum compatibility.
- No task switcher, banner, layout, confidence UI, or other Task 9 presentation behavior was added.
- No broad suite was rerun in this round, per scope; the Round 1 full-suite evidence remains `20` files and `387` tests passed.
- Final `git diff --check` was clean before commit.
