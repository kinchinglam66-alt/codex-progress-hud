# Offline ETA evaluation (Plan A, first implementation slice)

This is an evaluation foundation, not a new online estimator or evidence of improved real-world accuracy. The installed plugin, main-model reporting, calibration store, HUD display and lifecycle are unchanged. There are no network calls, credentials, transcript readers or automatic data collection.

## Interface

`src/evaluation/replay.ts` exports:

- `evaluateTraces(traces, predictorFactory)`: replay normalized observations through a fresh predictor per task; return every attempted prediction and aggregate metrics.
- `baselinePredictor`: adapter to the existing `estimateRemaining` algorithm, using active time and the optional progress/model signals in each point.
- `comparePredictors(traces, factories)`: run at least two predictors on the same observations; provide both each predictor's full results and scores restricted to their common answered prefixes.
- `assertDisjointTasks(training, heldOut)`: reject duplicate keys or overlap before fitting/evaluating. Dataset producers must preserve one stable anonymous key per task across splits; renaming the same task evades any key-based check.

Example for a local TypeScript caller:

```typescript
import { assertDisjointTasks, baselinePredictor, comparePredictors } from "../src/evaluation/replay.js";

assertDisjointTasks(trainingTraces, heldOutTraces);
// Fit only on trainingTraces. Do not capture heldOutTraces or their labels in candidateFactory.
const report = comparePredictors(heldOutTraces, [baselinePredictor, candidateFactory]);
```

The factories and dataset variables in this example are supplied by the caller; this is not a ready-made cloud provider. Predictors are trusted local synchronous functions, not sandboxed agents. An infinite loop cannot be canceled by this harness. Per-task factory initialization errors abort the run; per-prediction exceptions or malformed intervals count as invalid attempts.

## Trace contract

A trace has `sampleKey`, `observations`, and `end`. Keys must match `sample_` plus 1–64 letters, digits, underscores or hyphens. Use synthetic/anonymized keys, never host IDs. A syntactically valid key is not proof of anonymization; trace authors are responsible for that mapping.

Each observation is a full snapshot with:

- `atSeconds`: relative time, finite, nonnegative, at most one year. The first point is at zero; later times strictly increase. Coalesce events sharing a timestamp before importing.
- `state`: `running`, `waiting` or `paused`. State changes take effect at the observation timestamp. Every timing transition must be represented; missing transitions invalidate the meaning of the measured active time.
- Optional `progress` in [0, 1], `modelEstimateSeconds`, and `modelConfidence` in [0, 1]. Omission means unavailable at that point, not “reuse the previous report.”

No titles, free-form phases, prompts, tool output or extra fields are accepted. Predictors receive frozen prefix arrays of frozen points, augmented with accrued `activeSeconds`. They do not receive sample keys, future observations or the `end` label through this interface. Factory closures can still leak labels if callers misuse them; this API is not an information-security sandbox.

`end` contains a relative timestamp at or after the final observation and an outcome: `succeeded_verified`, `completed_unverified`, `failed`, `interrupted` or `unfinished`. Only verified completion supplies a successful-duration target. The other outcomes are marked unscored/censored in this first slice; they are not fitted as completed-task durations. “Censored” here is a reporting bucket, not a fitted survival/competing-risk model.

For an interrupted or unfinished task, `end.atSeconds` is the observation cutoff, not an estimate of when the work would have completed. Ground truth must be independently validated by the dataset producer. Declaring an outcome in synthetic JSON is not proof of a real deliverable's completion.

## Metrics and denominators

Only running observations are prediction attempts. Active remaining time is total observed running time minus running time accrued at that prefix; waits and pauses are excluded. This measures remaining tracked active work, not calendar completion time or unobserved work before installation.

Errors use the midpoint of each returned interval. MAE, nearest-rank p50/p90 absolute error, empirical coverage, mean interval width and relative error are computed only for valid predictions with verified completion labels. Relative error divides by `max(actualSeconds, 1)` to avoid division by zero. Empty metrics are `null`, not zero. Coverage is a measured inclusion fraction, not model confidence or a guarantee.

Always show `attempts`, `scored`, `censored`, `unavailable` and `invalid` alongside errors. Censored counts and predictor-status counts overlap: a censored attempt may also be unavailable. A predictor that abstains more cannot be declared better merely because its own scored MAE is lower. Use common-prefix metrics plus availability counts, and inspect which horizons were omitted.

Aggregates are prediction-weighted: long/densely sampled tasks contribute more points. Choose a fixed observation schedule for experiments and report per-task/horizon results before any adoption decision. This slice does not implement task-macro weighting, confidence intervals for metrics, survival estimation, provider budgets, learned calibration or live overhead measurement.

## Reproduce and next steps

After normal dependency installation, run:

```text
npm test -- --run tests/evaluation/replay.test.ts tests/core/eta.test.ts tests/core/calibration.test.ts
npm run typecheck
```

The synthetic tests cover active/wait/pause timing, prefix isolation, malformed inputs/outputs, duplicate/split guards, unscored outcomes, exceptions, the existing estimator adapter and paired comparison. Their hand-calculated numbers are correctness fixtures, not benchmark claims.

Next: add a consented, task-disjoint evaluation dataset and fit candidates only on training data. One existing runtime concern is that `aggregateCalibration` currently pools all accepted outcome categories; this module deliberately does not change that behavior. A future calibration change must keep failure/interruption observations separate, evaluate matched held-out prefixes and assess compatibility before replacing online behavior. Independent model integration remains gated by the [observation feasibility report](superpowers/reports/2026-09-05-independent-observation-feasibility.md).

## Development verification, 2026-09-05

Baseline ETA/calibration tests: 27 passed. New replay tests: 24 passed after test-first failing assertions. Complete isolated-worktree suite: 647 tests in 41 files passed, with no skips. TypeScript type checking and build compilation passed. One independent read-only review found no blocking issues; its two suggested assertion improvements were added and the focused suite rerun.

The first full-suite attempt lacked the worktree-local TypeScript path required by an existing integration fixture (633 passed, 14 skipped, one failed suite). A local ignored TypeScript dependency junction to the existing dependency installation fixed the test environment; the complete rerun above is the acceptance result. No tracked dependency changes were required. No installed-plugin or live-provider acceptance is claimed by these results.
