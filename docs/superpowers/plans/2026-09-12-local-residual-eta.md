# Local Residual ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect reliable per-turn ETA outcomes and evaluate a frozen local residual predictor without changing displayed ETA or making extra model calls.

**Architecture:** A metadata-only recorder joins immutable request snapshots to independent source-backed terminal events. Offline grouped training produces a validated artifact; a bounded runtime predictor records a separate shadow result. Keep lifecycle truth, feature extraction, storage, fitting and evaluation separate.

**Tech Stack:** TypeScript strict/NodeNext, Node >=22.13.0, existing Zod and Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-local-residual-eta-design.md` (approved 2026-09-12).

## Execution checkpoint (2026-09-12)

Inline implementation selected by the user. Tasks 1–7 have their core implementation in `feat/local-residual-eta`; one architectural review and one fix review completed. Tasks 2 and 7 were integrated together after building the independent recorder/evaluator to avoid repeated scheduler changes. Task 1 is committed as `06fa4a6`; the remaining implementation is delivered as one integration commit rather than the per-task commit sketch below. Final full regression: 2,208 tests in 190 files passed with four workers, plus a prior serial run of 2,206 tests before the last two tests were added. Typecheck/build passed. See `../reports/2026-09-12-local-residual-eta.md` for evidence and limitations. The original detailed checklists below remain a design/validation inventory, not a claim that every proposed stress variant was exercised; exact executed evidence is in the report. Installation, held-out accuracy measurement and promotion to displayed ETA remain outside this turn.

Concrete adapter refinements: `capture.ts` piggybacks on the existing planner iterator, and `telemetry.ts` separates local source keys from persisted anonymous identities. Runtime capture returns an opaque ticket and consumes it once on acceptance. Research uses the actual goal generation as well as source epoch and turn ownership. Changed generation/anchor or a history fingerprint mismatch becomes an explicit unavailable-prefix attempt, not a silently omitted forecast. Whole-turn elapsed and outstanding active action age are conservatively missing until trustworthy measurements are available. These limitations are documented rather than populated with wall-clock guesses.

## Global Constraints

- Shadow-only: do not replace raw ETA, modify UI/countdown, change completion authority, or reuse pace `ForecastRecord.shadowSeconds`.
- No extra remote model calls, main-agent reporting, live training, paid benchmarks, push or installation.
- Reliable current-turn normal end supplies duration truth, not solution-quality truth. Exclude interruptions, failed/cancelled turns and uncertain future intervals.
- Never persist raw conversation, commands, output, titles, paths, credentials or account IDs in research records. Explicit exports stay local and are not automatically committed.
- Training gates: 30 eligible turns and 10 independent training groups. Preliminary aggregate claims require 10 held-out groups. Smaller fixtures test implementation only.
- Ridge grid `{0.1, 1, 10, 100}`; unpenalized intercept; training-only normalization; per-turn total weight 1.
- Recorder limits: 128 queued records, 16 KiB/record, 10 MiB/segment, 100 MiB retained segments. Artifact <=1 MiB. These do not limit model-call concurrency.
- Implement in an isolated feature worktree using using-git-worktrees. Do not reuse or clean unrelated worktrees. Read applicable AGENTS.md before execution.
- If delegating: focused tasks `gpt-5.6-luna`/`medium`; cross-module tasks `gpt-5.6-luna`/`high`; one final architectural/data-isolation review `gpt-5.6-sol`/`medium`, at most one fix review. Explicitly supply both settings. Do not create sidebar tasks for implementation subtasks.

## Files and responsibilities

New production modules under `src/estimation/residual/`: `contract.ts` (schemas), `features.ts` (numeric vector), `lifecycle.ts` (research clock/outcomes), `recorder.ts` (bounded local storage), `predict.ts` (artifact validation/inference), `runtime.ts` (adapter joining callbacks).

New offline modules under `src/evaluation/residual/`: `dataset.ts` (joins/splits), `train.ts` (weighted ridge/baseline), `score.ts` (paired metrics). New command `scripts/evaluation/residual.mjs` imports built modules. New `docs/LOCAL-RESIDUAL-ETA.md` documents collection/training/reporting.

Modify narrowly: `src/observer/conversation-source.ts`, `src/server/passive-goals.ts`, `src/server/http-server.ts`, `src/estimation/observer-scheduler.ts`, `src/desktop/observer-pilot.ts`. Extend `src/observer/history-snapshot.ts` or preparation metadata only if required to bind the true full-context watermark. Keep legacy pilot journal and scorers unchanged.

Tests mirror the new directories. Add integration cases to existing `tests/observer/conversation-source.test.ts`, `tests/server/passive-goals.test.ts`, `tests/server/passive-goals-recovery.test.ts`, `tests/estimation/full-context-scheduler.test.ts`, `tests/estimation/observer-scheduler.test.ts`, `tests/desktop/observer-pilot.test.ts`.

## Shared interface contract

Define and export these in `contract.ts`; persist only strict allowlisted schemas. `versions` uses the existing `ForecastVersions` shape. Every numeric field must be finite, nonnegative where appropriate, and safe for its domain. IDs persisted below are opaque HMAC/random identifiers, never source IDs.

```ts
type Identity = {groupId:string; turnId:string; runId:string;
  sourceEpoch:number; generation:number};
type Features = {rawSeconds:number; elapsedActiveSeconds:number|null;
  observedActiveSeconds:number; oldestActionActiveSeconds:number|null;
  outstandingActions:number; completedActions:number; failedActions:number;
  prefixComplete:boolean};
type Prefix = {identity:Identity; predictionId:number; watermark:string;
  anchorActiveSeconds:number; features:Omit<Features,'rawSeconds'>};
type Outcome = 'normal_end'|'interrupted'|'failed'|'superseded'|'clock_unknown'|'recording_gap';
type Shadow = {seconds:number|null; reason:string; artifactId:string|null};
type ResearchRecord =
  | {schemaVersion:1; kind:'forecast'; sequence:number; prefix:Prefix;
      rawSeconds:number; deliveredActiveSeconds:number;
      versions:ForecastVersions; shadow:Shadow}
  | {schemaVersion:1; kind:'terminal'; sequence:number; identity:Identity;
      endActiveSeconds:number; outcome:Outcome; evidenceId:string; clockReliable:boolean}
  | {schemaVersion:1; kind:'invalidate'; sequence:number; identity:Identity;
      reason:'conflicting_terminal'|'clock_unknown'|'recording_gap'};
type Sample = {identity:Identity; predictionId:number; features:Features;
  actualSeconds:number; deliveryLagSeconds:number; versions:ForecastVersions};
```

Use enumerated `Shadow.reason` values `predicted`, `no_artifact`, `invalid_artifact`, `version_mismatch`, `insufficient_support`, `out_of_range`, `unseen_missingness`, `non_finite`, `prefix_unavailable`. Enforce exactly one result per identity/prediction; a conflicting duplicate invalidates the sample. Storage keys and original source identity belong only in the in-memory adapter, never these types.

### Task 1: Immutable contracts and feature vectors

**Files:** Create `src/estimation/residual/contract.ts`, `features.ts`; create `tests/estimation/residual/contract.test.ts`, `features.test.ts`.

**Interfaces:** `parseResearchRecord(value:unknown):ResearchRecord`; `vectorize(features:Features):readonly number[]`. Freeze parsed nested objects. Vector order: log1p of the seven numeric features in declared order, then elapsed/action-age missing flags and prefix-complete flag. Missing numeric values encode zero before training imputation; retain masks so training mean imputation is possible.

- [ ] Write failing tests including mutation isolation, unknown-property rejection, numeric edge cases, exact vector order and missing-vs-zero distinction:

```ts
it('distinguishes unknown action age from no outstanding action',()=>{
  const common = {rawSeconds:60,elapsedActiveSeconds:null,observedActiveSeconds:10,
    completedActions:0,failedActions:0,prefixComplete:false};
  expect(vectorize({...common,outstandingActions:1,oldestActionActiveSeconds:null}))
    .not.toEqual(vectorize({...common,outstandingActions:0,oldestActionActiveSeconds:0}));
});
```

- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/residual/contract.test.ts tests/estimation/residual/features.test.ts`; confirm missing-module/assertion failure, not an unrelated setup failure.
- [ ] Implement strict Zod unions, deep cloned/frozen projections and deterministic feature/mask order. Reject Infinity, negative age, unsafe IDs, undefined required nullable fields and extra keys; permit zero ETA.

```ts
const numeric = (x:number|null) => x === null ? 0 : Math.log1p(x);
// Persist explicit null and quality flags; never infer quality from a zero value.
```

- [ ] Rerun focused tests; run `D:/npm.ps1 run typecheck`.
- [ ] Commit only this task's source/tests: `feat: define residual ETA research contracts`.

### Task 2: Trusted lifecycle labels and request-prefix capture

**Files:** Create `lifecycle.ts` and `tests/estimation/residual/lifecycle.test.ts`; modify conversation source, passive goals and scheduler plus their existing tests. Do not wire disk storage yet.

**Interfaces:** Export `ResearchLifecycle` with optional constructor argument `nextSequence:()=>number` (default: instance-local increasing counter for isolated tests), `transition(identity:Identity,event:{id:string;atActiveSeconds:number;state:'running'|'waiting'|'paused'|'unknown';outcome?:Outcome;trusted:boolean}):readonly ResearchRecord[]`, `invalidate(identity:Identity,reason:'conflicting_terminal'|'clock_unknown'|'recording_gap'):ResearchRecord`, and `forget(identity:Identity):void`. Runtime supplies a shared sequence allocator for all research record kinds. Add optional synchronous, exception-isolated callbacks for research transitions and request/accepted-prefix handoff; production behavior must be identical when callbacks throw.

- [ ] Write failing lifecycle tests: running until active 40, pause/wait with unchanged active anchor, resume, terminal at active 70; normal-end target for prefix anchor 30 is 40. Test final assistant text alone yields no terminal, explicit aborted/failed produce separate outcomes, late duplicate normal end yields one record, conflicting outcome invalidates it, restart cannot join runs.

```ts
it('does not manufacture normal completion from waiting',()=>{
  const life = new ResearchLifecycle();
  const id = {groupId:'g',turnId:'t',runId:'r',sourceEpoch:1,generation:1};
  expect(life.transition(id,{id:'wait',atActiveSeconds:40,state:'waiting',trusted:true}))
    .toEqual([]);
});
```

- [ ] Run the new lifecycle test and existing source/passive-goals suites; verify the new assertions fail before implementation.
- [ ] Emit old-turn terminal metadata before source takeover mutates binding. Audit `local-session-reader.ts` explicit outcome mappings; never derive normal end from model interpretation or `status` alone. Use validated lifecycle active anchors and invalidate clamped/uncertain continuity; do not substitute wall time or blindly use `activeTimeKnown`.
- [ ] Capture structured action counters/ages and coverage from the same prefix watermark as actual full-context preparation. Attach capture to the flight/ticket, not a mutable latest-context object. If preparation moves the watermark, recapture consistently before dispatch; if alignment cannot be proven, emit `prefix_unavailable` and do not train that sample. Null whole-turn elapsed on mid-turn attach; observed age remains available.

```ts
// Adapter pattern: optional research hooks never escape into production control flow.
try { researchCallback?.(Object.freeze(capturedPrefix)); } catch { /* research-only failure */ }
```

- [ ] Test a deferred worker: append another tool result before response resolution and assert captured counters unchanged; stale generation/account/source result produces no forecast. Test quiet running, parallel action age, unobserved starts, late terminal, recovered pause and no-hook takeover.
- [ ] Run focused suites plus `full-context-scheduler.test.ts`, typecheck; commit `feat: capture reliable turn outcomes and residual prefixes`.

### Task 3: Bounded metadata recorder and identity persistence

**Files:** Create `recorder.ts`, `tests/estimation/residual/recorder.test.ts`.

**Interfaces:** `createResidualRecorder(directory:string):Promise<{identify(host:string,conversation:string,turn:string):{groupId:string;turnId:string}; record(row:ResearchRecord):void; status():{written:number;dropped:number;failed:boolean}; close():Promise<void>}>`. Initialization failure is caught by the runtime adapter and disables research only. Persist namespace/key atomically with exclusive creation and restrictive local permissions; race losers read the winner. Do not overwrite a corrupt secret and silently mix identities.

- [ ] Write failing temp-directory tests: reopen preserves identities, changed host or turn changes appropriate identity, extra text property is rejected, queue overflow is visible, missing segment/sequence is detected, close drains queued writes, failure never throws from `record`.

```ts
it('keeps raw source identities off disk',async()=>{
  const recorder = await createResidualRecorder(directory);
  const ids = recorder.identify('private-host','private-conversation','private-turn');
  expect(JSON.stringify(ids)).not.toContain('private-');
  await recorder.close();
});
```

- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/residual/recorder.test.ts` expecting failure before implementation.
- [ ] Implement serial asynchronous append, strict row projection and byte accounting. Use segment metadata to record sequence ranges/dropped counts; reserve a gap marker so overflow cannot hide data loss. On abrupt shutdown without a clean segment footer, conservatively reject that segment's eligibility. Cross-segment joins require intact metadata. Never log discarded row contents.
- [ ] Implement exact-directory closed-segment rotation with symlink/reparse-point rejection and no recursive deletion. Never remove key material or active segments. Test 100 MiB policy via injected byte limits; a rotation/missing segment yields explicit coverage loss, not a new completed sample.

```ts
// Boundaries are injected into tests, but production uses the approved constants.
const limits = {queue:128,rowBytes:16*1024,segmentBytes:10*1024*1024,totalBytes:100*1024*1024};
```

- [ ] Verify raw IDs, title, command and token sentinel strings are absent from all recorded data; typecheck and commit `feat: persist bounded residual research metadata`.

### Task 4: Offline joins and task-disjoint manifests

**Files:** Create `src/evaluation/residual/dataset.ts`, `tests/evaluation/residual/dataset.test.ts`.

**Interfaces:** `buildDataset(records:readonly ResearchRecord[]):{samples:Sample[];excluded:Record<string,number>}`; `splitSamples(samples:readonly Sample[],manifest:{train:string[];validation:string[];test:string[]}):{train:Sample[];validation:Sample[];test:Sample[]}`. Manifest keys are group IDs; optional benchmark mapping merges groups for repeated problem IDs before split validation. Reject one group assigned twice or absent from the manifest.

- [ ] Write failing tests for exact `end - anchor`, zero target, negative target, terminal correction, missing terminal, delivery after end, gap/restart exclusion and duplicate record handling. Delivery-after-end is excluded from live accepted-forecast scoring and counted, never clamped into an apparently successful result.

```ts
it('rejects group overlap even across different turns',()=>{
  expect(()=>splitSamples([],{train:['g'],validation:[],test:['g']})).toThrow();
});
```

- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/evaluation/residual/dataset.test.ts` before implementation.
- [ ] Join on complete identity plus prediction ID; use terminal evidence independently of raw ETA. Preserve all exclusion counts. Compute `actualSeconds=endActiveSeconds-anchorActiveSeconds` and `deliveryLagSeconds=deliveredActiveSeconds-anchorActiveSeconds`. Reject negative lag, unreliable clocks and wrong-run joins. Treat known pre-attach missingness separately from future clock gaps.
- [ ] Validate immutable explicit split manifests; deterministic optional manifest generation hashes group ID with a recorded seed before looking at outcomes. Explicit benchmark problem mapping must co-locate repeats; do not guess from task text. Reports state conversation-only grouping limitations.
- [ ] Rerun tests/typecheck; commit `feat: build leakage-safe residual ETA datasets`.

### Task 5: Ridge fitting, scale baseline and artifact inference

**Files:** Create `src/evaluation/residual/train.ts`, `src/estimation/residual/predict.ts`, their mirrored tests.

**Interfaces:** Export `ResidualArtifact` from `predict.ts` with schema/feature version, exact forecast-version compatibility tuple, training turn/group counts, feature means/scales/min/max, observed missing masks, coefficients/intercept, chosen lambda, weighted log-scale baseline and artifact content ID. Export `parseArtifact(value:unknown):ResidualArtifact`, `predictResidual(artifact:ResidualArtifact|null,features:Features,versions:ForecastVersions):Shadow`; export `trainResidual(train:readonly Sample[],validation:readonly Sample[]):ResidualArtifact` from `train.ts`. Reject mixed provenance training partitions rather than pool incompatible versions.

- [ ] Write failing numeric tests: deterministic ridge coefficients on a fixed fixture, intercept unpenalized, identical/collinear features finite, weighted medians, missing-mean imputation, test values cannot alter training normalization, no artifact and every abstention reason.

```ts
it('abstains without an artifact',()=>{
  const features = {rawSeconds:60,elapsedActiveSeconds:10,observedActiveSeconds:10,
    oldestActionActiveSeconds:0,outstandingActions:0,completedActions:0,failedActions:0,prefixComplete:true};
  const versions = {input:'i1',prompt:'p1',model:'m1',algorithm:'a1'};
  expect(predictResidual(null,features,versions).reason).toBe('no_artifact');
});
```

- [ ] Run train/predict focused tests and verify failures precede implementation.
- [ ] Implement weighted normal equations with stable bounded pivoting or Cholesky (ridge regularizes features, not intercept); reject singular/non-finite solutions explicitly. Cap feature dimension at the fixed contract length. Fit training mean/scales only; impute missing numeric inputs with training means and retain masks. Fit four lambdas; choose on validation turn-macro log error, larger lambda wins ties. Require validation nonempty and disjoint. Do not refit on test.

```ts
const residualTarget = Math.log1p(sample.actualSeconds) - Math.log1p(sample.features.rawSeconds);
const seconds = Math.max(0, Math.expm1(Math.log1p(features.rawSeconds) + predictedResidual));
```

- [ ] Enforce 30-turn/10-group training support and version compatibility; production artifacts cannot bypass support with test flags. Validate <=1 MiB before JSON parsing, strict array lengths, finite values and content ID. Present out-of-training-range features and unseen masks abstain. Unit fixtures may construct sufficiently large deterministic independent groups without calling a model.
- [ ] Test duplicated snapshots do not change a turn's total weight; artifact roundtrip leaves predictions unchanged; report all floors/fallbacks. Run focused tests/typecheck; commit `feat: fit and predict shadow residual ETA`.

### Task 6: Paired accuracy report and local command

**Files:** Create `src/evaluation/residual/score.ts`, `tests/evaluation/residual/score.test.ts`, `scripts/evaluation/residual.mjs`, `tests/evaluation/residual/cli.test.ts`; create `docs/LOCAL-RESIDUAL-ETA.md`.

**Interfaces:** `scoreResidual(samples:readonly Sample[],artifact:ResidualArtifact):object` returns versioned JSON with group/turn/prediction counts, coverage/fallback counts, paired raw/scale/residual metrics, request/delivery clocks separately and an insufficient-evidence flag. CLI actions: `dataset --input DIR --output DIR`, `train --dataset FILE --manifest FILE --output FILE`, `score --dataset FILE --manifest FILE --artifact FILE --output FILE`. Refuse existing output paths rather than overwrite evidence; never accept arbitrary code in an artifact or contact network.

- [ ] Write failing metric tests using errors calculable by hand, including unequal snapshots per turn and residual abstention. Test 60-second denominator floor, signed error orientation and P90 convention (nearest rank). Label phase-stratified metrics absent when whole-turn duration is unknown; provide observed-age buckets `<60s`, `60–600s`, `>600s` instead.

```ts
it('uses the declared near-zero percentage denominator',()=>{
  const actual = 5, predicted = 15;
  expect(Math.abs(predicted-actual)/Math.max(actual,60)).toBeCloseTo(1/6);
});
```

- [ ] Run score/CLI tests before implementation; score tests must invoke `scoreResidual` with schema-valid fixtures in addition to the arithmetic check.
- [ ] Implement exact spec metrics and equal-turn weighting: MAE, per-turn median log-error aggregation, signed bias, median/P90 of per-turn max underestimation, within30% using max(actual,60). Compare identical eligible samples for all three predictions and report overall coverage separately. For delivery metrics subtract active delivery lag from prediction and truth; clamp prediction at zero only, never silently clamp invalid truth.
- [ ] CLI writes local immutable manifests/reports, strips secret material and labels synthetic results as correctness-only. Capture full exclusion counts from Task 4 and independent-group limitation. Add examples to docs:

```powershell
D:/npm.ps1 run build
D:/node.exe scripts/evaluation/residual.mjs dataset --input .superpowers/sdd/residual-fixtures --output .superpowers/sdd/residual-dataset
D:/node.exe scripts/evaluation/residual.mjs train --dataset .superpowers/sdd/residual-dataset/dataset.json --manifest .superpowers/sdd/residual-dataset/manifest.json --output .superpowers/sdd/residual-artifact.json
D:/node.exe scripts/evaluation/residual.mjs score --dataset .superpowers/sdd/residual-dataset/dataset.json --manifest .superpowers/sdd/residual-dataset/manifest.json --artifact .superpowers/sdd/residual-artifact.json --output .superpowers/sdd/residual-report.json
```

- [ ] Rerun focused tests/build; commit `feat: report grouped residual ETA accuracy`.

### Task 7: Wire shadow runtime and verify no production impact

**Files:** Create `src/estimation/residual/runtime.ts`, `tests/estimation/residual/runtime.test.ts`; modify `src/server/http-server.ts`, `src/desktop/observer-pilot.ts` and existing desktop/scheduler integration tests. Update spec status and `docs/LOCAL-RESIDUAL-ETA.md` with measured limitations only.

**Interfaces:** `createResidualRuntime(directory:string):Promise<{capture(prefix:Prefix):void; accept(prefix:Prefix,rawSeconds:number,deliveredActiveSeconds:number,versions:ForecastVersions):void; lifecycle(record:ResearchRecord):void; close():Promise<void>}>`. Directory is the dedicated research subdirectory of the existing data directory. Load optional `artifact.json` once at startup; no polling, live fitting or provider configuration mutation. Sequence allocation must remain unique across forecast/lifecycle records: runtime owns the shared sequencer passed to `ResearchLifecycle` at construction using the Task 2 contract. Prefix retention is keyed by full identity/prediction ID; rejection/detach releases it, and acceptance without a matching captured prefix records a coverage failure rather than estimating from latest state.

- [ ] Write failing fake-worker end-to-end tests for enabled recorder vs absent/failed recorder: exact same model-call count, raw estimate, countdown anchor, pace shadow and lifecycle status. Add disk-full/slow-write/invalid-artifact variants and two simultaneous conversations.

```ts
// In the existing scheduler fixture, compare public outputs and worker call counts.
expect(withResearch.workerCalls).toBe(withoutResearch.workerCalls);
expect(withResearch.publicView).toEqual(withoutResearch.publicView);
expect(withResearch.forecast.shadowSeconds).toBe(withoutResearch.forecast.shadowSeconds);
```

- [ ] Run runtime and integration tests before wiring. Use existing test factories rather than launching a real estimator.
- [ ] Connect callbacks through `http-server.ts`; create/close research runtime in the existing desktop observer lifecycle, default on for metadata collection. Catch startup failure, leave production estimation enabled. Only accepted numeric raw estimates enter the new predictor. No artifact means collection plus `no_artifact`, not a new authorization prompt.
- [ ] Release per-turn state at detach and invalidate unfinished data on discontinuity. Shutdown bounded recorder independently of worker/account cleanup. Verify no source/HUD API publishes dataset secrets and no output directory enters packaging inputs.
- [ ] Measure vector inference over 10,000 frozen synthetic inputs and recorder enqueue cost with a stubbed sink; report timings/hardware and queue behavior, do not infer main-task speed gains. Verify slow disk cannot block a model response or Hook callback.
- [ ] Run `D:/npm.ps1 run typecheck`, `D:/npm.ps1 run build`, then `D:/node.exe node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism`. Run `git diff --check`. Keep logs in ignored `.superpowers/sdd/2026-09-12-local-residual-eta`.
- [ ] Perform one final architectural/data-isolation review. Fix verified issues and use at most one fix review; rerun affected tests and full suite if shared runtime changes. Commit `feat: integrate non-blocking residual ETA shadow mode`.
- [ ] Hand off exact commit/branch, fresh test evidence, limitations and collection readiness. Do not claim accuracy improvement without held-out data. Do not merge, push, install or run paid benchmarks absent a new request.

## Self-review coverage

- Source truth/clock/current turn: Task 2; bad joins/restarts/contradiction: Task 4.
- Snapshot immutability/no future leakage/parallel actions: Tasks 1–2; grouped preprocessing: Tasks 4–5.
- No raw text/secrets/bounded retention/export safety: Tasks 1, 3 and 6.
- Raw/scale/residual comparison, abstention/support and exact metrics: Tasks 5–6.
- Pace compatibility/no added calls/failure isolation and measured overhead: Task 7.
- Legacy pilot semantics remain untouched; no UI, interval calibration, survival, live training or publication expansion.
