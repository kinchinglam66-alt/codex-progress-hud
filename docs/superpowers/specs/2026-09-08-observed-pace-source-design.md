# Verified observed pace: shadow integration design

Status: architecture accepted on 2026-09-08; implementation verified on 2026-09-09
and integrated into the main working directory for the authorized commit/push.
Shadow-only; not installed or promoted to live ETA. See the implementation report.

## Objective and boundaries

Connect locally verified execution measurements to the existing shadow-only pace
calculator. Never substitute tool/token counts for task completion. Keep the HUD
raw ETA, progress formula, call frequency, provider, login and consent unchanged.
No additional inference request or main-agent progress report is introduced.
The existing countdown-expiry changes remain separate and uncommitted.

## Current evidence

- `ConversationRecord` carries text, timestamps and action IDs but no typed tool
  provenance or verified work-unit count.
- `conversation-source.ts` currently assembles input with `activeTimeKnown:false`.
- `ObserverScheduler.recordResult` calls `correctPace(..., [])`.
- `correctPace` already requires three comparable non-overlapping intervals and
  uses the median seconds/unit from at most the latest five. It remains reusable.
- A model work breakdown is a hypothesis, not a source of measured completions.

This is an internal data-boundary extension, not a coefficient adjustment.

## Data flow

1. Retain bounded structured tool provenance in the local conversation reader:
   tool name, paired invocation/result identity, capture completeness and timing.
   Preserve existing text separately. Do not infer tool identity from quoted prose.
2. A local adapter recognizes one explicitly supported result format and validates
   it against its actual paired invocation. Unknown commands/formats abstain.
3. A goal-scoped measurement owner validates completeness, serial execution,
   duplicates, pause/wait boundaries, source continuity and comparability.
4. Freeze measurements at the observer request snapshot. Assign a bounded opaque
   measurement reference; expose only static units and numeric summaries to the
   existing observer call. Do not expose file paths or raw command strings.
5. The observer may reference that measurement group in its optional work proposal.
   Local code resolves the reference within that request and checks unit/class
   compatibility. Model-provided durations or completion counts never populate
   the measurement store.
6. After normal ticket acceptance, compute and journal the shadow prediction.
   Keep live ETA, input priors and scheduling based on the raw prediction.

## First supported adapter

Use complete structured Vitest JSON results from an identified Vitest invocation,
not terminal text such as `1541 passed`. The first comparable unit is a completed
test file within an explicitly serial run, mapped to file-processing/file.

Admission requires all of the following:

- The actual recorded command identifies Vitest and explicitly disables file
  parallelism; ambiguous shell composition, wrappers and absent arguments abstain.
- The tool result is complete, successful, valid bounded JSON matching the
  supported report shape. A JSON-looking assistant message is never evidence.
- File-level timestamps and completed status are present, plausible within the
  host invocation window and mutually non-overlapping. Missing timings abstain.
- No user wait, manual pause, interruption, incomplete history, source reset,
  source outage or overlapping host action crosses an admitted interval.
- The measurement group is local to one goal, invocation class, project and
  runtime/configuration signature. Reject repeated files, retries, failed/skipped
  files and incompatible suites rather than counting them as fresh completed work.

Do not enable this adapter merely because a fixture parses. Verify the installed
project's Vitest JSON shape with an isolated deterministic sample before finalizing
the parser. If this format lacks required provenance/timing, report unavailability;
do not replace it with a keyword parser or require normal users to report progress.

This adapter measures test execution only. It cannot estimate debugging, writing
tests or implementing a feature from a test-pass count. Normal text-only test runs
can remain unavailable; broader adapters are separate work.

## Time, identity and retention

- Distinguish observed tool execution duration from whole-goal effective work time.
  Do not mark the existing whole-goal clock known merely because one tool is timed.
- Only admit fully observed intervals containing uninterrupted running work.
  Initially reject crossing waits/pauses instead of reconstructing missing time.
- Snapshot the latest five eligible intervals per compatible group; require three.
  Limit each goal to eight groups, with bounded input/report bytes and total units.
- Goal replacement/end clears measurements; source reset invalidates continuity.
  A late model response cannot use measurements collected after its request.
- Old optional model responses remain valid and produce no correction when the
  measurement reference is absent. Unknown/stale/cross-goal references abstain.
- Private identities remain local. Research records contain only allowlisted
  numeric/static metadata and existing pseudonymous goal keys.

## Remaining work and uncertainty

Observed completed units and remaining units are different evidence classes.
The observer's remaining-unit count remains a model hypothesis unless independently
backed by a known work manifest. Label that provenance in shadow records; do not
claim the remaining workload has been measured or that the shadow is ground truth.

Only the matching serial portion can receive a conditional speed correction;
unmeasured portions retain their model priors. Ambiguous composition, a scope
change, unsupported units or insufficient intervals yields null plus a reason.
No live promotion or calibrated-confidence label follows automatically.

## Verification and implementation slices

1. Characterize supported JSON with a deterministic local sample; define strict
   parser and provenance fixtures, including spoofed text and truncated reports.
2. Test and implement the local goal-scoped measurement owner: duplicates,
   concurrency, waits/pauses, resets, timing bounds, grouping and memory limits.
3. Add optional request snapshot/reference plumbing and response compatibility;
   update pinned assets only through existing build/validation workflow. Preserve
   the current 16,384-byte input ceiling and account/consent safeguards.
4. Wire accepted results to shadow calculation and bounded journal projection.
   Prove no future-data leakage, unchanged raw/HUD ETA and no additional calls.
5. Run focused RED/GREEN tests, typecheck/build and a frozen full regression.
   Use one bounded final review and at most one fix review.

Use deterministic data first. Real observation collection and measured accuracy
claims require a separate bounded experiment. Log correction availability and
abstention reasons; do not weaken eligibility simply to obtain more predictions.

## Review checkpoint

Approve this first-adapter scope before implementation planning. In particular,
the initial result will apply to verified serial test execution, not all coding
tasks, and it may legitimately produce no correction in many ordinary tasks.
