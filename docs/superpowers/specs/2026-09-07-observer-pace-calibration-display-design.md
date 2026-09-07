# Observer pace, calibration and display design

Status: implemented locally; typecheck/build and 1,541 tests across 129 files passed.
This document does not authorize installation or live experiments.

Implementation evidence: `../reports/2026-09-07-pace-calibration-display.md`.
Pace remains shadow-only and calibration offline. Installed HUD is unchanged.

## Scope and order

This implements the remaining roadmap items: (2) observed execution pace,
(4) empirical error ranges, and (5) small display transitions. Input-facts stage
one and trigger-policy stage three are local prerequisites; preserve their edits.

Delivery order: versioned forecast records, shadow pace correction, offline
calibration, then display transitions. Each is independently testable. Pace and
calibration must not replace the live numeric estimate in this slice. Display
transitions may operate on the accepted raw forecast, without changing its meaning.

No extra model call, main-agent reporting, changed provider, authentication flow,
authorization, start budget, trigger frequency, completion gate or progress formula.
Do not add a product acceptance-evidence field. No installation, push, automatic
dataset publication or real accuracy claims are part of this design.

## Existing integration points

- `src/estimation/observer-contract.ts` and observer instruction assets define
  the current bounded model input/output contract.
- `src/server/passive-goals.ts` owns accepted prediction identity and lifecycle;
  scheduler tickets already fence stale answers and conversation replacement.
- `src/evaluation/pilot-journal.ts`, `pilot-score.ts` and `replay.ts` provide
  bounded recording and offline scoring foundations.
- `src/core/calibration.ts` contains legacy phase-average heuristics, not a
  calibrated remaining-work prediction interval. Do not wire it into this path
  unchanged or treat its sample-count confidence as empirical coverage.
- Keep display transformation separate from goal state and scheduler admission.
  Resolve the actual renderer entry points when writing the implementation plan.

## Shared forecast record

Keep separate raw model, shadow-corrected and displayed estimates. A record links
to the accepted prediction and goal lifetime using local opaque identifiers,
never task titles or raw host identifiers in exported research metadata. Include
snapshot effective-work time, acceptance time, forecast version, input/prompt/model
versions, correction availability/reason and uncalibrated/calibrated provenance.

Raw records are immutable. Display-only updates must not become new predictions,
training examples, trigger events or inputs claiming newly observed work.
Rejected/stale answers cannot update any of these layers. Unknown is null, not zero.
Replacing a goal clears its live pace and transition state. Resumption after an
ended goal starts fresh; this does not resume a stored unfinished forecast.

Extend existing opt-in local research recording rather than introducing always-on
transcript storage. Persist only explicitly projected bounded numeric/static
fields. Research records are separate from live resume state. Existing recording
consent governs retention; no automatic export, upload or public Git tracking.

## Item 2: shadow pace correction

Separate remaining work from observed pace. The same observer call may return a
small optional structured work breakdown, with bounded categories, remaining
units, comparability and change reason. It must not return chain-of-thought.
Older responses without this optional data remain valid. Preserve the current
16,384-byte input ceiling and bound the additional output schema explicitly.

Model-inferred units and completed-work claims are hypotheses, not measured
throughput. Use a pace correction only when compatible, structured unit counts
and effective-work intervals are independently available in the observed data.
No generic keyword parser turns prose, command counts or test totals into completed
task units. Missing compatible observations means no correction, not fabricated data.

Initial conservative policy:

- Require at least three non-overlapping comparable intervals with positive
  completed units and known effective duration; use the median seconds per unit
  from at most the five latest intervals within this goal.
- Reject intervals spanning missing history, source outages, unknown active time,
  or ambiguous parallel execution. Exclude user waits and pauses.
- Compare only matching unit/work classes. Do not transfer file-processing speed
  to debugging, design, tool waiting or a different conversation/model version.
- For a supported serial work portion, candidate duration is remaining units
  times median seconds per unit. Other portions keep the model prior. If their
  separation or serial composition is unavailable, abstain from a total correction.
- Do not sum parallel portions unless their dependency/composition is explicitly
  represented; the initial implementation abstains for ambiguous parallel work.
- Preserve the raw forecast and record abstention reasons. All corrected totals
  are shadow outputs only. Do not feed them back as observations of actual speed.

This may initially yield few corrected predictions. Report that availability;
do not silently weaken the eligibility rules to obtain more samples.

## Item 4: offline interval calibration

Calibration requires completed-goal labels with independently established active
duration. Model-inferred completion remains sufficient for the product's status,
but is not automatically a trustworthy research label. Unclear, interrupted or
unfinished records remain unscored; report exclusions. No extra acceptance step
is added to normal product use.

Fit raw and pace-corrected predictors separately. Task identities must be disjoint
between calibration and held-out evaluation; multiple snapshots from one task
are correlated and do not count as independent tasks. Freeze versions, split and
snapshot selection before evaluating; never use future records in a prefix input.

Initial exploratory target: 80% empirical coverage, explicitly not a guarantee.
Use task-balanced absolute residuals with a fixed per-task snapshot schedule.
Keep absolute error bounds internally; percentage is only a representation at
the prediction snapshot, never divided by the live countdown.

Start with predicted-horizon buckets <=30 minutes, <=2 hours, <=8 hours and >8
hours. Only produce a bucket candidate after at least 30 distinct calibration
tasks; this is a minimum-data guard, not proof of reliability. Otherwise report
uncalibrated. Task-type subdivision and formal coverage guarantees are deferred.
Near-zero central estimates retain absolute bounds in offline reports rather
than inventing enormous or capped percentages that misrepresent coverage.

Report task-macro MAE, median/p90 absolute error, empirical coverage, interval
width, and answer availability at matched prefixes. Include per-horizon results
and task-level resampling uncertainty when enough held-out tasks exist. Never
select a candidate solely because a wider interval covers more outcomes, or
because abstention hides difficult tasks. Promotion to live use is a separate
decision after measured results, not automatic at the sample threshold.

## Item 5: bounded display transition

Compare the new raw prediction with the previous accepted prediction aged to the
same effective-work snapshot. Do not compare an aged countdown with an unaged
forecast. Only transition when both are numeric and belong to the same goal.

Initial small-change threshold: absolute difference <= max(5 seconds, 5% of
the aged prior value). Transition from the currently displayed value to the new
accepted countdown over at most two seconds of active display time. This is
animation, not a persistent moving-average estimator. The target continues aging
normally during the transition; no hidden two-second extension is added to ETA.

Large changes, explicit scoped work-change/failure reasons, unknown/new-goal
transitions and completed status bypass animation. If the change reason is
unavailable, only the small numeric threshold is eligible; never suppress a large
revision. Repeated updates retarget from the current display without retaining a
stack of stale forecasts. Pause/wait freezes the display and transition clock.

Never smooth uncertainty percentages into a new statistical claim. Keep the
existing latest-forecast uncertainty label and update its value with the accepted
forecast. Progress remains monotonic and uses the unsmoothed accepted estimate;
zero remaining time is not completion. Display animation cannot trigger calls.

## Verification and acceptance

Use deterministic synthetic fixtures first, no inference calls:

1. Record projection, old response compatibility, byte limits, immutable raw
   values, goal isolation and stale-answer rejection.
2. Pace outliers, insufficient intervals, incompatible units, missing active time,
   parallel work, pauses, source outage and target replacement. Assert both shadow
   values and unchanged live HUD/scheduler inputs.
3. Task-disjoint splits, future-data exclusion, ambiguous completion, repeated
   snapshots, horizon sample guards and near-zero estimates. Hand-check residuals
   and metrics; synthetic fixtures are not accuracy evidence.
4. Small/large upward and downward display changes, aged baselines, repeated
   updates, unknown, pause/resume, completion and multi-conversation independence.
   Verify raw state, uncertainty percentage and monotonic progress are unchanged.

Run focused red/green tests during implementation, typecheck/build and one final
full regression at the milestone. Use one scoped architecture review, with at
most one fix review under the user's routing policy. Update documents with actual
results. Real dataset collection, calibration fitting and accuracy experiments
require a separately bounded test plan before execution.
