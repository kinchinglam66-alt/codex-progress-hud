# Observer Pace, Calibration and Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute the checkboxes with TDD.

**Goal:** Add shadow pace correction, offline interval calibration and bounded ETA display transitions without increasing inference frequency or changing live ETA selection.

**Architecture:** Immutable versioned forecast records feed separate pure pace and calibration modules. The renderer alone owns temporary interpolation; accepted raw predictions remain authoritative for scheduling and monotonic progress.

**Tech Stack:** Existing TypeScript, Zod, Vitest and Electron renderer; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-07-observer-pace-calibration-display-design.md` (user approved).

## Global constraints

- Preserve local stage-one/stage-three changes on main; base document commit is 1890fca. No blanket staging, reset, installation, push or live experiments.
- No extra model call, main-agent reporting, changed provider, authentication flow, authorization, start budget, trigger frequency, completion gate or progress formula.
- Preserve the current 16,384-byte input ceiling. Bound added output fields; update only changed observer asset pins, not runtime trust pins.
- Pace and calibration remain shadow/offline. Never silently promote a candidate to the HUD or scheduler.
- Require at least three non-overlapping compatible pace intervals; use at most the latest five. Reject unknown work time and ambiguous parallel work.
- Calibration target is exploratory 80% coverage, with at least 30 distinct calibration tasks per predicted-horizon bucket. This is not a coverage guarantee.
- Display threshold is max(5 seconds, 5% of the aged prior value), with at most two seconds of active transition time.
- No product acceptance-evidence field. Existing local research recording consent remains the only persistence gate; no real task data in Git.
- One implementation pass, one Sol/medium integration review, at most one fix review. Routine delegated work uses Luna/medium; clock/identity work Luna/high. No repeated review seats per task. Main can implement inline; do not delegate its blocking work merely to wait.
- Focused RED/GREEN per task, one full suite after integration. Implementation commits are deferred to user request so prerequisite dirty work is not bundled accidentally.

## Task 1: Versioned accepted-forecast records

**Create:** `src/estimation/forecast-record.ts`, `tests/estimation/forecast-record.test.ts`.
**Modify:** `src/estimation/observer-scheduler.ts`, `src/evaluation/pilot-journal.ts`, `src/evaluation/pilot-score.ts`.
**Tests:** `tests/estimation/observer-scheduler.test.ts`, `tests/evaluation/pilot-journal.test.ts`, `tests/evaluation/pilot-score.test.ts`.

Define and export these bounded types from forecast-record.ts:

```ts
export type PaceReason = 'eligible'|'missing_measurements'|'insufficient_intervals'
  |'incompatible_units'|'unknown_clock'|'parallel_work'|'invalid_composition';
export interface ForecastRecord {
  schemaVersion: 1;
  predictionId: number; // local request id, never a host identifier
  generation: number;
  snapshotActiveSeconds: number;
  acceptedAt: number;
  rawSeconds: number|null;
  shadowSeconds: number|null;
  paceReason: PaceReason;
  calibration: 'uncalibrated'; // online records in this slice
  versions: {input: string; prompt: string; model: string; algorithm: string};
}
export function makeForecastRecord(value: ForecastRecord): Readonly<ForecastRecord>;
```

- [x] Write schema/immutability tests: finite seconds in [0,31536000], safe nonnegative IDs, version strings restricted to 1–128 safe identifier characters, strict extra-field rejection. Deep-clone/freeze the result, including versions.

```ts
const value = {schemaVersion:1 as const,predictionId:1,generation:1,
  snapshotActiveSeconds:60,acceptedAt:90000,rawSeconds:600,shadowSeconds:null,
  paceReason:'missing_measurements' as const,calibration:'uncalibrated' as const,
  versions:{input:'facts-v1',prompt:'sha256-test',model:'test-model',algorithm:'pace-v1'}};
const row = makeForecastRecord(value);
value.versions.model='changed';
expect(row.versions.model).toBe('test-model');
expect(Object.isFrozen(row.versions)).toBe(true);
```

- [x] Run `npm test -- --run tests/estimation/forecast-record.test.ts`; observe failure before adding the module.
- [x] Implement strict parsing and immutable projection. Extend ObserverObservation with optional forecast metadata, emitted only after accepted settlement. Capture version provenance from actual worker configuration/assets; never guess a missing model version. If unavailable, omit the versioned research record and record a bounded diagnostic.
- [x] Journal projection must hash the existing conversation key as before, preserve the current 8 KiB record/10 MiB file/128 pending bounds, and never spread arbitrary objects. Preserve legacy journal readability in pilot-score. Raw snapshot fields are not rewritten by shadow results.
- [x] Add accepted/stale/replacement tests: stale tickets emit no new forecast record; accepted records use the accepted goal generation; journal strings exclude titles, context, local paths and provider configuration. Research I/O failure cannot prevent an estimate.
- [x] Run the four affected test files and `npm run typecheck`; record RED/GREEN results. Do not persist renderer ticks as predictions.

## Task 2: Bounded work description and shadow pace engine

**Create:** `src/estimation/pace-correction.ts`, `tests/estimation/pace-correction.test.ts`.
**Modify:** `src/estimation/observer-contract.ts`, `src/estimation/assets/observer.schema.json`, `src/estimation/assets/observer-instructions.md`, `src/estimation/asset-pins.ts`, `src/estimation/observer-scheduler.ts`.
**Tests:** `tests/estimation/observer-output.test.ts`, `tests/estimation/observer-input.test.ts`, `tests/estimation/observer-scheduler.test.ts`, `tests/packaging/observer-home-assets.test.ts`.

Export shared WorkPart and PaceInterval types from pace-correction.ts:

```ts
export interface WorkPart {
  workClass:'file_processing'|'batch_processing'|'other';
  unit:'file'|'batch'|'unknown';
  remainingUnits:number|null;
  priorSeconds:number;
}
export interface WorkBreakdown {
  composition:'serial'|'unknown';
  changeReason:'routine'|'scope_change'|'failure'|'unknown';
  parts:readonly WorkPart[];
}
export interface PaceInterval {
  workClass:WorkPart['workClass']; unit:WorkPart['unit'];
  startActiveSeconds:number; endActiveSeconds:number; completedUnits:number;
  complete:boolean; serial:boolean;
}
export function correctPace(rawSeconds:number,work:WorkBreakdown|null,
  intervals:readonly PaceInterval[]):{seconds:number|null;reason:PaceReason};
```

Intervals are supplied by a trusted local adapter already scoped to the same goal
and model version. They are NOT taken from model-returned counts. Current
ConversationRecord has no structured completed-unit field: production initially
supplies an empty interval list and reports missing_measurements. Do not invent
a parser for arbitrary tool output. Supporting an actual structured producer is
a separately bounded follow-up; the pure engine is exercised with synthetic data.

- [x] Write literal tests for three compatible intervals [10,12,100] seconds/unit, four remaining units and an unrelated 20-second portion: corrected total must be 68 seconds. Two intervals abstain. Overlap, duplicate intervals, incomplete history, zero units, incompatible classes and unknown composition abstain.

```ts
expect(correctPace(100,{composition:'serial',changeReason:'routine',parts:[
  {workClass:'file_processing',unit:'file',remainingUnits:4,priorSeconds:80},
  {workClass:'other',unit:'unknown',remainingUnits:null,priorSeconds:20}
]},[
  {workClass:'file_processing',unit:'file',startActiveSeconds:0,endActiveSeconds:10,completedUnits:1,complete:true,serial:true},
  {workClass:'file_processing',unit:'file',startActiveSeconds:10,endActiveSeconds:22,completedUnits:1,complete:true,serial:true},
  {workClass:'file_processing',unit:'file',startActiveSeconds:22,endActiveSeconds:122,completedUnits:1,complete:true,serial:true}
])).toEqual({seconds:68,reason:'eligible'});
```

- [x] Run the new test and observe RED. Implement median of the latest five compatible intervals; require three. Prior portion totals must match rawSeconds within max(1 second, 1%); otherwise invalid_composition. Limit parts to eight, units to 1e6, seconds to one year; reject nonfinite values and totals above the bound. No parallel sum or cross-class transfer.
- [x] Add optional nullable `work` to the local response parser. Generated-provider JSON schema may require the key with null allowed; old local responses omitting it remain accepted. Unknown/completed responses cannot supply actionable work. Test semantic refinements in both paths.
- [x] Update instructions to request only bounded work fields in the same call, not reasoning or completed-unit evidence. Regenerate hashes for the two changed observer assets only and run asset tests. Confirm input budget unchanged.
- [x] On accepted result, run correction locally and add shadow result to Task 1 record. Empty production measurements must not suppress the raw estimate. Keep measurements scoped to goal/model and never hydrate unfinished state from research records.
- [x] Run pace, output, input, scheduler and asset tests plus typecheck. Verify same worker-call count and identical raw HUD prediction with and without work metadata.

## Task 3: Offline task-balanced calibration and scoring

**Create:** `src/evaluation/interval-calibration.ts`, `tests/evaluation/interval-calibration.test.ts`.
**Modify:** `docs/ETA-EVALUATION.md` (new candidate section, preserve historical results).
**Reuse without changing legacy behavior:** `src/evaluation/replay.ts`, `src/core/calibration.ts`.

```ts
export interface CalibrationPoint {
  taskKey:string; predictor:'raw'|'pace'; version:string;
  snapshotIndex:number; predictedSeconds:number; actualSeconds:number;
  verified:boolean;
}
export interface IntervalCandidate {
  bucket:0|1|2|3; predictor:'raw'|'pace'; version:string;
  halfWidthSeconds:number; taskCount:number;
}
export function fitIntervals(points:readonly CalibrationPoint[]):IntervalCandidate[];
export function applyInterval(center:number,candidate:IntervalCandidate):{low:number;high:number};
```

- [x] Write RED tests: 29 distinct tasks yield no candidate; 30 tasks each with absolute residual 10 yield halfWidthSeconds=10. Thirty snapshots of one task are still one task. Applying that candidate to center 3 yields [0,13], not a huge percentage.

```ts
const points=Array.from({length:30},(_,i)=>({taskKey:`sample_${i}`,
  predictor:'raw' as const,version:'v1',snapshotIndex:0,
  predictedSeconds:100,actualSeconds:110,verified:true}));
expect(fitIntervals(points).map(x=>x.halfWidthSeconds)).toEqual([10]);
expect(fitIntervals(points.slice(0,29))).toEqual([]);
```

- [x] Implement strict point validation: safe anonymous task key, nonnegative finite seconds <=31536000, nonnegative integer snapshotIndex, safe bounded version. Reject duplicate task/predictor/version/snapshot identities. Exclude unverified labels and report counts in evaluation, never relabel them as success.
- [x] Partition by predictor/version/predicted horizon (1800/7200/28800 boundaries). Within each bucket each task contributes total weight 1: each of its n snapshots has weight 1/n. Sort absolute residuals and choose the smallest reaching 80% of total weight. Do not pool raw and pace variants or versions.
- [x] Add an offline comparison wrapper that requires disjoint task keys and a fixed snapshot-index manifest before fitting. Use only matched answered prefixes for paired error comparisons; separately report all attempts/abstentions. Do not pass held-out labels to fitIntervals.
- [x] Report task-macro mean absolute error, p50/p90 absolute error, empirical coverage, interval width and availability by horizon. Normalize snapshot weights within each task before aggregation. Empty values are null, not zero.
- [x] For >=30 held-out tasks, add seeded task-level bootstrap (1000 resamples) for 95% empirical metric bands, preserving each selected task's snapshots together. For fewer tasks report bands unavailable. These are exploratory uncertainty bands, not a guarantee of predictive coverage.
- [x] Run `npm test -- --run tests/evaluation/interval-calibration.test.ts tests/evaluation/replay.test.ts tests/evaluation/pilot-score.test.ts` and typecheck. Update documentation with exact weighting, exclusions and no live integration.

## Task 4: Display-only two-second transition

**Create:** `src/ui/eta-transition.ts`, `tests/ui/eta-transition.test.ts`.
**Modify:** `src/ui/display-clock.ts`, `src/ui/view-model.ts`, `src/ui/renderer.ts`, `src/server/passive-goals.ts` (bounded optional changeReason only).
**Tests:** `tests/ui/display-clock.test.ts`, `tests/ui/passive-view.test.ts`, `tests/ui/multi-row.test.ts`, `tests/server/passive-goals.test.ts`.

```ts
export interface Transition {
  startedActiveSeconds:number; offsetSeconds:number;
}
export function transitionValue(targetSeconds:number,activeSeconds:number,
  transition:Transition|null):number;
// targetSeconds is the new raw countdown already aged to render time.
```

- [x] Write RED test using an old aged value 100 and newly accepted target 104. At transition start display 100; one active second later target 103/display 101; at two seconds target 102/display 102. Literal expectations catch hidden countdown extensions.

```ts
const t={startedActiveSeconds:10,offsetSeconds:-4};
expect(transitionValue(104,10,t)).toBe(100);
expect(transitionValue(103,11,t)).toBe(101);
expect(transitionValue(102,12,t)).toBe(102);
```

- [x] Implement `max(0,targetSeconds + offsetSeconds * (1-clamp((activeSeconds-startedActiveSeconds)/2,0,1)))`; keep the helper pure and test finite inputs.
- [x] Extend createHudDisplayClock with per-row transition state keyed by conversation/task/generation and prediction revision. Same-revision frames never restart transitions. First/reconnect frames clear interpolation; removed rows clear state. Use the existing one-second ticker, no model or server calls.
- [x] Age old/new raw predictions to the same active snapshot before testing the threshold. For eligible small changes use current displayed minus new raw value as offset. Large changes, explicit scope_change/failure, completed/unknown and identity replacement bypass. Handle repeated updates without stacking transitions.
- [x] Advance the transition clock only while row runtime is running and the display connection is live. Pause/wait/disconnect freeze it. Runtime changes must not produce an artificial numeric revision.
- [x] Extend view projection with a separate optional displayed-countdown override used only for etaLabel. Do not mutate HudSnapshot or pass the override into progress calculation. Keep errorPercent and freshness based on the accepted raw prediction. Preserve conversation-renderer DOM identity and textContent rendering.
- [x] Carry optional accepted `work.changeReason` through PassiveGoalView only as its bounded enum; no work parts or measurement records on public snapshots. Clear it with prediction/goal replacement; stale responses cannot set it. Missing reason remains compatible.
- [x] Run new helper and all listed UI/goal tests. Run the existing renderer probe using its test harness to verify actual displayed labels, pause behavior and multiple independent rows. Do not install a package for this check.

## Task 5: Integrate, review and record evidence

- [x] Verify prerequisite dirty files remain intact with `git status --short` and targeted diff inspection. Confirm no unrelated staged changes or runtime pins modified.
- [x] Run `npm run typecheck`, `npm run build`, then `npm test -- --run --maxWorkers=1 --no-file-parallelism --reporter=dot`; record actual counts and exit codes.
- [x] Request one scoped Sol/medium review covering all four deliverables, particularly privacy projection, stale identities, shadow/live separation, task leakage and display clock boundaries. Fix confirmed issues with focused RED/GREEN tests; at most one scoped fix review.
- [x] Run `git diff --check`; update this plan and the spec with actual results and limitations. Do not describe synthetic calibration as improved real-world accuracy.
- [x] Hand off local source only. State explicitly that pace may abstain on current production records, calibration is offline, and installed HUD is unchanged. Installation and real experiments remain separate requests.

## Self-review / execution boundary

Tasks 1–2 cover immutable provenance, optional bounded output and shadow isolation;
Task 3 covers task-disjoint scoring and sample safeguards; Task 4 covers display
semantics without progress feedback; Task 5 covers integrated verification.
No implicit structured-measurement adapter or live calibration promotion is hidden
in the plan. Each task includes a deterministic test cycle.

## Execution result

Completed locally on main without committing, pushing, installing or making live
inference calls. Final typecheck/build passed; final full suite passed 1,541 tests
across 129 files (285.08 seconds). Hidden renderer DOM/countdown/transition checks
passed. One architecture review and one bounded fix review were used; their final
two residual findings were fixed with RED/GREEN tests by the main agent, without
another review round. See `../reports/2026-09-07-pace-calibration-display.md` for
the initial failure, corrections, evidence and remaining shadow/offline limits.
