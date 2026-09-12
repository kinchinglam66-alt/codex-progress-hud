# Direction 03: local residual ETA correction

Status: proposed design; product intent and automatic-label policy confirmed; written-spec review required before implementation.

## Goal and boundaries

Learn systematic ETA error from local, structured observations. Predict remaining active work until the authenticated **current turn ends**, not completion of a multi-turn project. The first release of this subsystem is shadow-only: collect and compare predictions without replacing the displayed ETA, changing countdown behavior, or changing lifecycle authority.

This is a small statistical model, not a local language model. It makes no additional remote model calls and never asks the main task model to report progress. Existing estimation calls and full-conversation input behavior remain unchanged. Training must not persist conversation text, commands, tool output, titles, file paths, credentials, or account identifiers.

The user approved automatic labels from reliable normal-end signals. Interruptions, cancellation, source discontinuity and uncertain clocks are separate outcomes, not completed-duration samples. No manual confirmation is required for every ordinary turn.

## Alternatives and selected approach

1. Raw model ETA: retain as the unchanged production output and evaluation baseline.
2. Constant multiplicative correction: cheap and useful for global bias, but cannot represent different execution conditions. Implement as a comparison baseline.
3. Regularized log-residual regression: selected shadow candidate. Use only a small, explicit set of information available at forecast time. Fit offline and load a validated frozen artifact for local prediction.

Do not include quantile regression, conformal intervals, survival models, retrieval, online retraining, ensembles, or new model-based work decomposition in this increment. A regression point estimate is not a calibrated confidence interval. Direction 03 must not relabel the existing HUD uncertainty percentage as statistically calibrated.

## Existing integration points

- `src/estimation/observer-scheduler.ts` creates accepted forecast records with prediction identity, generation, raw ETA, active-time anchor and version provenance.
- `src/estimation/forecast-record.ts` already has `shadowSeconds` for **pace correction**. Preserve that meaning and schema compatibility; residual correction needs a separately versioned record, not reuse of that field.
- `src/observer/local-session-reader.ts` maps explicit `task_complete`, `task_failed` and `turn_aborted` events into runtime outcomes. `conversation-source.ts` exposes current-turn execution identity, outcome and boundary time.
- `src/server/passive-goals.ts` applies source execution transitions and owns active-time accounting. Capture terminal evidence before takeover/reset can replace the old turn. Neither its semantic status alone nor a generic observer `activeTimeKnown` flag is sufficient proof of a complete training clock.
- `src/evaluation/pilot-journal.ts` is a bounded diagnostic journal with a per-process salted key. Its closure is not task completion and its identities cannot join observations across restarts. Do not silently reinterpret it as the new dataset.
- Existing manually labelled pilot scoring, replay outcome definitions and progress-bucket baseline retain their existing contracts.

## Data flow and component responsibilities

1. Capture an immutable structured prefix at the same source watermark used for an ETA request.
2. If the corresponding raw ETA is accepted for the same turn, attach it to that prefix, run the optional frozen residual predictor and enqueue a prediction record.
3. Observe source-backed lifecycle transitions independently of whether the estimator returned a result. Maintain active-clock continuity and enqueue a terminal outcome for the old turn before advancing to another turn.
4. An offline dataset builder joins predictions to eligible terminal outcomes, validates clocks and identities, and reports excluded records with reasons.
5. An offline trainer fits baselines and the residual model on training groups only. An evaluator scores untouched groups and exports a report plus a versioned artifact.
6. Runtime shadow prediction accepts only compatible artifacts and structured features. Any recording or prediction failure leaves production estimation untouched.

Keep feature extraction, outcome recording, dataset construction, fitting and prediction in separate modules with explicit schemas. The scheduler and lifecycle owner supply events; they must not contain the training implementation.

## Identity, snapshots and lifecycle truth

Use a local random dataset namespace and secret HMAC key, separate from credentials and excluded from exports. Derive opaque conversation/task group and turn identities from authenticated host/source identities. Record an observation-run ID, source epoch, turn generation, prediction ID and sequence so duplicate delivery and replay are idempotent. Neither raw IDs nor the HMAC secret are exported.

A forecast record is immutable. Request-time features and the raw prediction refer to the same source watermark and active-time anchor. Response arrival records delivery lag separately; features must not absorb tool results that arrived while the estimator was working. Results rejected as stale, cancelled or for a different generation do not become accepted forecasts.

Automatic `normal_end` requires an explicit supported normal-end runtime event for the matching authenticated turn, a complete readable event boundary and no conflicting terminal evidence. A final assistant message alone, silence, waiting state, HUD close, journal close, model interpretation, or the start of a later turn does not supply this label. Normal end describes runtime completion, **not independently verified solution quality**.

Store interrupted, failed, superseded, recording-gap and clock-unknown outcomes separately. Contradictory outcomes invalidate an earlier normal-end label for scoring; append a correction record rather than silently editing history. Duplicate terminal delivery must not double-count a turn. If takeover occurs before terminal evidence can be captured, mark the previous turn unresolved rather than fabricate a completion.

For version 1, process restart or source/clock discontinuity invalidates the affected run's completed-regression eligibility. Stable opaque grouping still prevents cross-run data leakage; it does not authorize reconstructing missing clock intervals. Do not backfill old diagnostic logs with invented labels. Mid-turn attachment is allowed: record elapsed-from-attachment separately, and mark total elapsed-before-attachment unknown.

## Active time and labels

Maintain an observation-relative active clock from trusted transitions. Explicit user waiting and manual pause do not advance it. Quiet reasoning and running tools do advance it while source execution remains reliably running. Source unavailability is a clock-quality gap, not an assumed user pause or assumed active work.

For an accepted prediction at active anchor A and reliable terminal boundary E in the same continuous observation run:

`actualRemainingSeconds = E - A`

Accept a zero target if the snapshot genuinely coincides with the boundary; reject negative or non-finite differences. Subtract pauses and user waits between A and E. Require reliable continuity throughout that interval, not a guessed total duration since the original user message. Unknown pre-attachment elapsed time does not invalidate a reliable future interval, but cannot be supplied as a known whole-turn feature.

Boundary timestamps must use the lifecycle owner's validated clock mapping, with provenance for any clamping or uncertainty. An uncertain timestamp cannot become a precise label simply because its numeric value is finite. Test explicit normal-end mapping independently from model output.

## Feature contract

Initial numeric features are log-transformed nonnegative raw ETA, known elapsed active work, observed active work since attachment, oldest outstanding action's observed active age, number of outstanding actions, completed-action count and failed-action count. Record explicit missing/quality flags. No outstanding action is distinct from an action whose start was not observed.

Failure counts use structured tool completion/exit metadata only. Do not infer retries by comparing arbitrary command text. A retry feature is deferred until there is a reliable structured retry identifier. Parallel action age uses active-time intervals, not wall time; missing timestamps yield missing features, not invented durations.

Preserve estimator model, prompt, input, algorithm and feature-schema versions as provenance and compatibility guards, not unbounded one-hot features. Never use HUD progress percentage, eventual total duration, future tool results, final outcome, post-hoc early/middle/late labels, test split membership or model-generated confidence as truth.

Feature extraction must not add a second full-history scan per prediction: reuse the captured structured context and incremental action state. If full-turn counters are unavailable, store observed-prefix counters with the appropriate coverage flag.

## Model and fallback

Fit ridge regression on the log residual:

`z = log1p(actualRemainingSeconds) - log1p(rawSeconds)`

`shadowSeconds = max(0, expm1(log1p(rawSeconds) + predictedResidual))`

Use deterministic finite-number validation and train-only feature normalization. Leave the intercept unpenalized, map missing numeric features to the training mean with separate missing flags, and map zero-variance normalized features to zero. Select regularization from `{0.1, 1, 10, 100}` using group-disjoint training validation, minimizing turn-macro absolute log error and preferring stronger regularization on a tie; never tune against the final test set. Give each turn equal total training weight across its snapshots so frequent estimates do not dominate the fit.

The multiplicative baseline uses a training-only turn-balanced weighted median log residual and the same nonnegative conversion (it scales `1 + seconds`, not exactly seconds). Compare it on the same eligible observations as the residual model. Invalid numeric output, schema/version mismatch, absent artifact or insufficient support returns no residual prediction with a reason; raw ETA still works. Version 1 also abstains when a present continuous feature lies outside its training min/max or a missingness pattern was never observed in training. Record this conservative extrapolation fallback and its coverage cost. Do not cap corrected values to make errors look smaller; the nonnegative floor above is the only numeric bounding, and non-finite output is rejected.

Initial training gate: at least 30 eligible turns from at least 10 independent task groups in the training partition. This is a conservative engineering prerequisite, not evidence of accuracy. Evaluation also needs at least 10 held-out task groups for a preliminary aggregate claim; otherwise report descriptive numbers as insufficient evidence. No automatic promotion to displayed ETA occurs at either threshold.

## Local storage and runtime cost

Enable the new metadata-only shadow recorder without an authorization dialog or remote transmission. Store it under a dedicated local data subdirectory, outside Git and packaging inputs. Use an allowlist schema and asynchronous bounded writes: proposed initial limits are 128 queued records, 16 KiB per record, 10 MiB per segment and 100 MiB total retained segments. These are recording limits, never estimation/concurrency limits.

Rotate by removing only closed oldest dataset segments within that exact directory. Preserve the active segment; if a record cannot be retained, report dropped counts and invalidate affected sample completeness. Missing joins are excluded with a coverage-loss reason. Exports are explicit local commands and omit secrets. No data is uploaded, committed or attached to a paper automatically.

No training on the HUD event loop. Artifact loading has a bounded size (1 MiB), strict coefficient/feature limits and finite validation. Local prediction is a bounded vector operation, with no shell or network calls. Keep only bounded incremental feature state per attached turn, and release it on detachment. Recorder failure must not disable ETA or consume an inference budget slot.

## Evaluation contract

Assign every snapshot of a task to the same split. Group repeated benchmark attempts by benchmark problem ID when explicitly supplied; otherwise group by opaque conversation ID and clearly state that equivalent tasks in different conversations cannot be automatically identified. Keep training, validation and test manifests immutable and disjoint. Normalization, feature choices, weights and hyperparameters are fixed before reading test results.

Report paired raw, multiplicative and residual results: per-turn macro MAE in seconds, median of per-turn median absolute `log1p` error, turn-macro signed error (prediction minus actual), median and P90 of each turn's maximum underestimation in seconds, and turn-macro fraction within 30% using `abs(prediction - actual) / max(actual, 60 seconds)`. Label the latter explicitly as a 60-second-denominator-floor metric, not ordinary percentage error. Include counts of independent groups/turns/predictions, missing labels, excluded clocks, residual fallback and recording gaps. Report both paired valid-prediction accuracy and all-eligible coverage so selective fallback cannot masquerade as improvement.

Request-anchor accuracy is primary. Separately score delivery-time countdown after subtracting measured active time between snapshot and delivery; never mix the two clocks. Report early/middle/late strata only post hoc where whole-turn active duration is known; otherwise use observed-age strata and label them accordingly. Do not treat several snapshots of one turn as independent experiments. Resampling uncertainty, if reported, is at task-group level.

Synthetic fixtures test correctness, not empirical accuracy. Existing short or interrupted benchmark data are not automatically eligible. Real collection can begin after implementation, but this change does not authorize a new paid benchmark batch.

## Acceptance and non-goals

- Trusted normal end produces exactly one eligible label when the clock is continuous; waiting, final text alone, interruption, failure, restart and source gaps do not.
- Pause/resume, quiet running, parallel tools, mid-turn attachment, delayed terminal records, duplicate events and same-session takeover have focused tests.
- Request-time features cannot see later events; cross-task/account/generation association is rejected.
- Fit/predict is deterministic; zero/large/null values, insufficient samples, bad artifacts and version mismatch degrade safely.
- Dataset splitting and preprocessing resist same-task and future-information leakage; corrupted and rotated records are accounted for.
- Raw ETA, pace shadow, countdown, lifecycle semantics, provider accounting and default model-call frequency are unchanged, including when the recorder or predictor fails.
- Run focused tests during implementation and the full suite at the integration milestone. Report measured overhead separately; passing tests alone does not establish accuracy gains.

No UI redesign, automatic artifact retraining/promotion, install/push, publication, private-document export or benchmark execution is included. A later explicit decision is required to replace displayed ETA after held-out evidence is available.
