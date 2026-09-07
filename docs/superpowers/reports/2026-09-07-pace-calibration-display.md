# Pace, calibration and display implementation evidence

Status: local source implementation complete; final full regression passed.

## Scope

Roadmap steps 2, 4 and 5 are implemented locally alongside the existing input-facts
and trigger-policy prerequisites. Changes remain uncommitted on main. No installed
plugin, login state or live inference configuration was changed for this work.

- Accepted forecast records carry bounded version metadata and preserve raw ETA.
- Pace correction is a shadow calculation; production supplies no structured pace
  intervals yet, so the engine abstains rather than fabricating measurements.
- Task-disjoint interval fitting and held-out scoring are offline. Synthetic
  fixtures demonstrate arithmetic and safeguards, not real-world ETA accuracy.
- Small ETA revisions receive a two-second active-time display transition. Raw
  progress, uncertainty and scheduling remain independent of this display value.

## Verification

- Final frozen-source full suite: 129 files, 1,541 tests passed, zero failures;
  exit code 0, duration 285.08 seconds. Command:
  `npm test -- --run --maxWorkers=1 --no-file-parallelism --reporter=dot`.
- Final `npm run typecheck` and `npm run build`: exit code 0.

- Focused display/goal tests: 58 passed across five files.
- Hidden Electron probe: DOM, countdown and transition checks passed after build.
- First full suite: 1,534 passed, one failed across 129 files (307.19 seconds).
  The authenticated HTTP module graph exposed a missing eta-transition.js static
  route. The route was added; HTTP/module-graph regression: 45 tests passed.
- One final architecture review identified four corrections: forwarding forecast
  provenance through the desktop wrapper, using replacement-goal time coordinates,
  task-macro availability, and complete snapshot schedule validation.
- The single bounded fix review identified two remaining cases: null replacement
  anchors and inconsistent paired training labels. Both were reproduced as failing
  tests, then fixed by the main agent. Four affected files: 107 tests passed;
  typecheck/build passed. No additional review round was requested, and the last
  reviewer verdict must not be represented as approval of these subsequent edits.

## Integration details

Accepted settlement anchors are retained in a ticket-keyed WeakMap independently
of prediction presence, and are not added to public HUD snapshots. Null forecasts
retain null predictions without mixing old-goal time into new-goal records.
Calibration comparison accepts nullable training attempts so complete schedules
can represent abstentions. Both training and held-out paired labels are validated
before fitting; task keys must be disjoint between these splits.
Versioned comparison currently permits one version per predictor per run and a
uniform complete snapshot manifest, rather than silently pooling missing prefixes.

The first full regression and final full regression are distinct runs; the earlier
failure was fixed and is included in the final passing module-graph test. No
implementation commit, push, installation or live model experiment was performed.

## Limits

No real dataset was collected or fitted. No claim of improved empirical accuracy
or calibrated live confidence is made. The 80% fitting target and bootstrap
bands are exploratory statistics, not a guarantee. Trusted structured pace input,
live promotion, installation and real accuracy experiments are separate work.
Pace correction currently supports one measured serial portion plus unmeasured
prior portions; multiple measured portions conservatively abstain.
