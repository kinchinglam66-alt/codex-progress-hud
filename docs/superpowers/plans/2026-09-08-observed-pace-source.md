# Verified Observed Pace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect verified serial Vitest file timings to conditional shadow ETA corrections without changing live estimates.

**Architecture:** Preserve structured tool provenance before text packing; admit measurements through a bounded goal-scoped owner. Freeze numeric summaries and local lookup tables with each observer ticket, then resolve optional model references only after normal acceptance. The model supplies a remaining-work hypothesis, never measurement truth.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest; existing observer scheduler and JSONL research journal.

**Spec:** `docs/superpowers/specs/2026-09-08-observed-pace-source-design.md` (user accepted 2026-09-08).

## Global Constraints

- Keep the HUD raw ETA, progress formula, call frequency, provider, login and consent unchanged.
- No additional inference request or main-agent progress report is introduced.
- The existing countdown-expiry changes remain separate and uncommitted.
- Distinguish observed tool execution duration from whole-goal effective work time.
- Snapshot the latest five eligible intervals per compatible group; require three.
- Limit each goal to eight groups, with bounded input/report bytes and total units.
- Goal replacement/end clears measurements; source reset invalidates continuity.
- Private identities remain local. Research records contain only allowlisted numeric/static metadata and existing pseudonymous goal keys.
- Preserve the current 16,384-byte input ceiling and account/consent safeguards.
- Use one bounded final review and at most one fix review.

Additional implementation bounds: report limit 65,536 UTF-8 bytes; at most 256 files per report; at most 1,024 seen file identities per goal. Exhausting the identity bound disables admission until goal reset rather than evicting deduplication evidence. Eight groups are a hard admission cap, not an LRU cache. No package installation or real inference is needed for this implementation.

## Characterization already performed

An isolated local invocation of the installed Vitest used `--reporter=json --maxWorkers=1 --no-file-parallelism` on three existing test files. Exit code was 0; all three reports had `assertionResults`, `startTime`, `endTime`, `status`, `message`, and `name`. All passed, had positive durations inside the host window, and no overlap. Assertion counts were 24, 10 and 11. Report order was not chronological; sort by timestamps. End timestamps included fractional milliseconds; do not require integers.

Host duration was 793 ms; reported file durations were approximately 4.17, 3.19 and 3.32 ms. Consequently these timestamps measure a narrower execution component, not launch, module collection, inter-file overhead or overall task duration. Never use this sample as ETA accuracy evidence. Equal file counts also do not imply equal complexity; corrections remain conditional and shadow-only.

## Execution boundary

Use the existing authorized isolated source directory `.hud-reinstall-1a3aa3f-isolated` for focused implementation/testing, preserving its countdown-expiry edits. Before editing, read applicable AGENTS.md files and record main/isolated hashes for overlapping files. Do not copy the dirty main repository wholesale into it. Compare and transfer only this plan's reviewed changes back to main; stop on unexplained overlapping edits. Do not install, push, or stage unrelated diagnostic changes. A requested implementation commit must use selective hunks where countdown and pace changes overlap.

## Task 1: Structured provenance and strict report adapter

**Files:**
- Modify `src/observer/conversation-record.ts`, `src/observer/local-session-reader.ts`.
- Create `src/estimation/vitest-pace-adapter.ts`, `tests/estimation/vitest-pace-adapter.test.ts`.
- Extend `tests/observer/local-session-reader.test.ts`.

**Interfaces:** Define `ToolCapture` with `name:string`, `actionId:string`, `cwd:string`, `command:string`, `complete:boolean`, `exitCode:number|null`, `startedAtMs:number`, `endedAtMs:number`, `output:string`. Reader provenance fields are optional: missing metadata is absence, never a fabricated default. Only authentic command/tool events can populate them; pairing must include turn identity.

Adapter exports `parseVitestPace(capture:ToolCapture): ParsedPace|null`. `ParsedPace` contains `files:readonly {identity:string;startMs:number;endMs:number}[]`, local `signature:string`, and `project:string`. All identities stay local.

- [x] Write tests using synthetic command `node node_modules/vitest/vitest.mjs run tests/a.test.ts tests/b.test.ts tests/c.test.ts --reporter=json --maxWorkers=1 --no-file-parallelism`, an explicit cwd, successful exit, complete report and matching host window. Include this table test:

```ts
it.each(['incomplete', 'failed', 'overlap', 'outside-host', 'duplicate', 'skipped', 'shell-wrapper', 'missing-cwd'])('%s abstains', kind => {
  const capture = validCapture();
  mutateCapture(capture, kind);
  expect(parseVitestPace(capture)).toBeNull();
});
```

Implement `validCapture` in this test using three file results at [100,110], [120,140], [150,180], host [90,200], passed assertions, and zero failed/pending tests. `mutateCapture` independently flips completeness, exit code, the second start to 105, last end to 201, second identity to first, an assertion to pending, prefixes `echo x && `, or empties cwd. Add assistant-quoted JSON and clipped-output reader tests asserting no trusted capture.

- [x] Run `npm test -- --run tests/estimation/vitest-pace-adapter.test.ts tests/observer/local-session-reader.test.ts`; verify failure is the absent adapter/provenance, not malformed fixtures.
- [x] Implement conservative direct-command recognition. Accept only the explicit Node/Vitest runner form above, with quoted tokens handled deterministically; reject shell operators, redirection, substitutions, wrappers, unknown flags and incomplete argv. Require explicit serial flags, reporter JSON, and explicit test paths. Signature includes normalized cwd, executable/runner identity and all non-file arguments. Unknown tool envelopes abstain; do not guess the command from rendered text.

```ts
if (!capture.complete || capture.exitCode !== 0 || !capture.cwd) return null;
if (Buffer.byteLength(capture.output, 'utf8') > 65536) return null;
// Validate supported JSON fields before constructing results.
// Sort file intervals, reject repeated names, non-positive durations,
// host-window violations and any previous.endMs > current.startMs.
```

Use Zod bounded arrays/numbers for the report projection. Require success, every file/ assertion passed, finite timestamps, empty failure messages and consistency of report counts. Reject retries when present. Ignore unrelated reporter metadata only after validating every evidence-bearing field. Retain a completeness bit before reader text clipping; never parse the subsequently shortened message.
- [x] Re-run the two focused files and `npm run typecheck`. Record supported command/envelope shapes and abstentions. Do not broaden admission to obtain a passing sample.

## Task 2: Bounded goal-scoped measurement ownership

**Files:** Create `src/estimation/pace-measurements.ts`, `tests/estimation/pace-measurements.test.ts`; modify `src/observer/conversation-source.ts` and `tests/observer/conversation-source.test.ts`.

**Interfaces:** Export `PaceMeasurements` with `ingest(scope, parsed, continuity):void`, `snapshot(scope):readonly PaceGroup[]`, `clear(scope):void`. `scope` is an opaque goal object; `continuity` carries source epoch, history-complete flag, running windows and competing action windows. `PaceGroup` contains local signature, fixed `workClass:'file_processing'`, `unit:'file'`, and existing `PaceInterval[]`. Use source epoch changes to invalidate prior groups. Runtime/config equality means only the verified signature, not a claim of equal test difficulty.

- [x] Write owner tests for minimum three samples, last five, eight groups, 1,024 identity cap, duplicates across invocations, source resets, missing history, goal replacement, pause/wait crossing and overlapping host actions.

```ts
expect(owner.snapshot(goalB)).toEqual([]);
owner.clear(goalA);
expect(owner.snapshot(goalA)).toEqual([]);
```

Test a valid three-file run followed by the same run: accepted interval count must not increase. Invalid continuity must invalidate the affected evidence, not silently retain a seemingly eligible snapshot.
- [x] Run `npm test -- --run tests/estimation/pace-measurements.test.ts` and capture RED.
- [x] Implement the owner with private maps, immutable snapshot copies and hard caps. Within a proven uninterrupted window, translate timestamps relative to a local tool-time origin into seconds for `PaceInterval`; set completedUnits to 1 per file. Do not assign these values to the whole-goal clock. Validate interruption/overlap using the complete host action window as well as file intervals. Clear on source loss/reset and on goal end/replacement. If history lacks the needed provenance, return no groups.

```ts
const interval = {
  workClass: 'file_processing' as const, unit: 'file' as const,
  startActiveSeconds: (file.startMs - originMs) / 1000,
  endActiveSeconds: (file.endMs - originMs) / 1000,
  completedUnits: 1, complete: true, serial: true,
};
```

- [x] Run owner/source focused tests and typecheck. Check that `activeTimeKnown:false` remains unchanged in the production conversation source.

## Task 3: Frozen request references and backward-compatible protocol

**Files:** Modify `src/server/passive-goals.ts`, `src/estimation/observer-contract.ts`, `src/estimation/observer-retention.ts`, `src/estimation/assets/observer.schema.json`, `src/estimation/assets/observer-instructions.md`, `src/estimation/asset-pins.ts`; extend `tests/server/passive-goals.test.ts`, `tests/estimation/observer-contract-work.test.ts`, `tests/estimation/asset-pins.test.ts`; create `tests/estimation/pace-request-snapshot.test.ts`.

**Interfaces:** Optional input `paceMeasurements` has at most eight entries: `{measurementRef:string,workClass:'file_processing',unit:'file',sampleCount:number,medianSecondsPerUnit:number,clock:'tool_execution'}`. Refs match `^pm_[a-f0-9]{32}$`. Optional `WorkPart.measurementRef` uses the same constraint. Local ticket lookup is a private WeakMap, not part of serialized input. Add `PassiveGoals.paceIntervals(ticket, work):readonly PaceInterval[]`, returning no intervals for absent, stale, foreign or incompatible refs. Permit only the single concrete target already supported by `correctPace`.

- [x] Write tests that old responses without refs remain valid; a future sample ingested after request does not affect lookup; another ticket's ref cannot resolve; replacement invalidates refs; dropping summaries during packing also removes their ability to resolve.

```ts
const before = goals.paceIntervals(ticket, work);
// Ingest a new valid measurement through the source after this ticket exists.
expect(goals.paceIntervals(ticket, work)).toEqual(before);
expect(goals.paceIntervals(otherTicket, work)).toEqual([]);
```

- [x] Run the new snapshot/contract tests to verify RED.
- [x] Generate opaque refs locally using Node crypto, freeze request groups and retain only refs actually serialized after packing. Extend strict Zod schemas and JSON output schema together. Keep absent optional fields valid. When input approaches 16,384 bytes, remove lowest-priority pace summaries before sacrificing protected user context; bound numeric summaries before entering the existing retention loop.

Add observer instruction text: “Measurements describe test execution only, excluding launch/collection and other work. Reference a group only for matching serial test execution. Remaining units are your hypothesis, not observed truth. Omit the reference when workload compatibility is uncertain. Never apply file timings to implementation or debugging.”
- [x] Recompute only the two observer asset SHA-256 source pins after intentional edits, using LF bytes; keep numeric pilot assets unchanged. Run snapshot/contract/pin tests, retention regressions and typecheck. Assert packed input stays <=16,384 bytes and contains no command, cwd or file identities in `paceMeasurements`.

## Task 4: Accepted shadow calculation and safe journal projection

**Files:** Modify `src/estimation/observer-scheduler.ts`, `src/estimation/forecast-record.ts`, `src/evaluation/pilot-journal.ts`; extend their corresponding `tests/estimation/observer-scheduler.test.ts`, `tests/estimation/forecast-record.test.ts`, `tests/evaluation/pilot-journal.test.ts`.

**Interfaces:** Reuse `correctPace(rawSeconds, work, intervals)`. Add optional forecast `measurement` projection: `{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:number}` with sampleCount 3..5. No opaque refs or local signatures in research output. Existing `paceReason` remains the abstention reason; absent/unresolvable references produce `missing_measurements`.

- [x] Add a scheduler test with three 10-second file intervals, raw 100 seconds, serial target prior 80 seconds and remainingUnits 2: shadow must be 40 seconds, raw must remain 100. Add stale ticket, mismatched unit, scope-change and no-reference cases; require null shadow. Compare worker call count and live prediction with the same input without measurements.

```ts
expect(record.forecast.rawSeconds).toBe(100);
expect(record.forecast.shadowSeconds).toBe(40);
expect(worker.observe).toHaveBeenCalledTimes(1);
```

- [x] Run focused scheduler/forecast/journal tests, verify RED for the missing integration.
- [x] Replace the empty interval argument only in accepted `recordResult` handling:

```ts
const work = result?.interpretation?.work ?? null;
const intervals = this.options.goals.paceIntervals(flight.ticket, work);
const pace = correctPace(rawSeconds, work, intervals);
```

Keep raw prediction assignment, trigger policy and HUD formatting untouched. Journal constructs a fresh allowlisted projection and rejects invalid metadata instead of spreading source objects. Record hypothesis provenance only for admitted correction; calibration remains `uncalibrated`. Preserve countdown-expiry hunks already in these files.
- [x] Run focused tests and typecheck. Explicitly assert no extra calls, no change to consent/accounting and no raw private identities in serialized research records.

## Task 5: Frozen regression and bounded review

**Files:** Create `docs/superpowers/reports/2026-09-08-observed-pace-source.md`; update this plan's checkboxes only for completed steps.

- [x] Run all new focused tests plus existing pace-correction, source-goal integration, passive goals, retention and countdown-expiry regressions. Save exact command, counts and exit codes in the report; separate this work from prior 1,557-test evidence.
- [x] Freeze edits, then run `npm run typecheck`, `npm run build`, and `npm test -- --run --maxWorkers=1 --no-file-parallelism`. If code changes during the suite, rerun the relevant milestone against the final snapshot.
- [x] Request one bounded architectural review using `gpt-5.6-sol` with explicit `medium` effort. Scope: trusted provenance, clocks, frozen references, lifecycle resets, private-data boundaries, raw/shadow isolation and changed tests. Routine implementation uses `gpt-5.6-luna` medium; cross-module work uses Luna high. At most one fix review.
- [x] Record eligible and abstaining synthetic cases, local format characterization and limitations. State explicitly: no real-task accuracy claim, no live promotion, no installation and no new inference consumption from this test workflow. Verify `git diff --check` and inspect the final scoped diff before any requested commit.

## Self-review

Spec coverage: Task 1 provenance/format; Task 2 ownership, time and bounds; Task 3 request fencing/protocol/privacy; Task 4 conditional correction and research projection; Task 5 regression/review. Broader tool adapters and real accuracy experiments remain deliberately outside this change. The first adapter may abstain for normal text output or indirect shell wrappers; that is expected rather than a reason to weaken validation.
