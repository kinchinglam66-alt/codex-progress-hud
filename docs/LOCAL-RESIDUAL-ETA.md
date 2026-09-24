# Local residual ETA research mode

Direction 03 is a **shadow experiment**. The HUD still displays the original model ETA. A local ridge model can compute a separate candidate prediction; it does not replace that ETA, recalibrate its displayed uncertainty, or call another language model.

## What is collected

The observer records accepted numeric ETA predictions and structured prefix counters while the existing full-context planner reads its fixed snapshot. It does not read the conversation a second time for research. An explicit source-backed current-turn normal-end event provides the outcome label. Final assistant text alone and an observer model's completion interpretation are not labels.

Research files contain anonymous conversation/turn identities, a local recording-run identity, clock anchors, numeric features, estimator versions and outcomes. They contain no conversation text, task titles, commands, outputs or credentials. Existing full-context provider transmission is unchanged and is separate from this metadata recording.

The current capture marks whole-turn elapsed time unknown. Outstanding action active age is also unknown when it cannot prove subtraction of manual pauses; an empty action set has age zero. The model retains explicit missing flags. These conservative missing values are not measured zeros and must not be described as complete feature coverage.

The request prefix and scanned feature prefix must have matching metadata fingerprints, and acceptance must preserve the request clock anchor and goal generation. A mismatch, incomplete scan or counter overflow produces an unavailable-prefix attempt without invented features. Initial model bootstrap can change the generation and therefore lose research feature coverage even while its ordinary HUD ETA works normally.

Terminal labels additionally require complete source history, a stable wall/monotonic clock bridge and a boundary inside the current trustworthy clock interval. Old terminal events arriving across an unrecorded pause and wall-clock jumps are excluded rather than assigned guessed durations.

## Storage and failure behavior

Data lives in `residual-research` beneath the existing HUD data directory. `identity.json` contains a local secret for anonymous identifiers: never publish it. Groups derive from authenticated local conversation keys; ordinary restarts preserve grouping while replacement of the underlying identity token can change it. Explicit benchmark problem mapping is required to group equivalent problems in different chats or identity namespaces.

Each writer uses bounded JSONL segments and a digest/closed footer. Interrupted or incomplete recording runs and runs with dropped records are rejected conservatively. Close the plugin normally before exporting the newest run; the exporter intentionally does not score an open writer's partial data. Rotation retains at most 100 MiB of closed/active segments, excluding key/artifact files; oldest closed research segments can be removed. Export research evidence before long-term archival needs exceed that budget.

Failed recording never authorizes another model call or disables the provider. Missing/invalid artifacts leave raw ETA available. Files and exports stay local; this feature does not upload data or add it to Git or a paper automatically.

Desktop startup and shutdown wait at most 250 ms each for the research owner. A late startup result is closed rather than attached; a slow close may finish asynchronously. This bounds extra waiting, not operating-system I/O itself. An interrupted drain remains an excluded recording gap, never fabricated training evidence.

## Offline evaluation commands

Build before running the command. Use Node 22.13 or later. Examples below run from the repository root; select fresh output paths to avoid overwriting evidence.

```powershell
npm run build
node scripts/evaluation/residual.mjs dataset --input "C:/path/to/HUD-data/residual-research" --output ".superpowers/sdd/residual-dataset-01"
node scripts/evaluation/residual.mjs train --dataset ".superpowers/sdd/residual-dataset-01/dataset.json" --manifest ".superpowers/sdd/residual-dataset-01/manifest.json" --output ".superpowers/sdd/residual-artifact-01.json"
node scripts/evaluation/residual.mjs score --dataset ".superpowers/sdd/residual-dataset-01/dataset.json" --manifest ".superpowers/sdd/residual-dataset-01/manifest.json" --artifact ".superpowers/sdd/residual-artifact-01.json" --output ".superpowers/sdd/residual-report-01.json"
```

`dataset` assigns groups deterministically with a fixed hash split (approximately 60% training, 20% validation, 20% test). This does not guarantee enough samples in every partition. Keep that manifest fixed rather than repeatedly changing the split after seeing test results.

For benchmark repeats, supply `--group-map FILE` to `dataset`: a JSON object mapping each opaque conversation group ID to its benchmark problem identifier. The command hashes those problem identifiers before export. Map all repeated attempts consistently, including attempts in different accounts/chats. Without this mapping, the report can claim conversation-disjoint, not necessarily problem-disjoint, evaluation.

Training requires at least 30 eligible turns in at least 10 training groups, plus a nonempty disjoint validation partition with matching estimator versions. No real benchmark is launched by these commands. Score refuses training/validation groups in the test input. Preliminary aggregate claims require at least 10 test groups with usable paired predictions; otherwise the report flags insufficient evidence.

Hyperparameter selection uses only validation rows that the frozen runtime artifact would actually predict. Rows with unseen missingness patterns or features outside the training range remain validation-coverage evidence, but are not scored as predictions. Training stops with `RESIDUAL_VALIDATION_UNSUPPORTED` when every validation row would be rejected; it never promotes an arbitrary model from a zero-prediction validation pass.

## Model and metrics

The candidate fits `log1p(actual remaining seconds) - log1p(raw seconds)` with turn-balanced ridge regression. The comparison scale baseline is a weighted median log residual. Missing fields use training means plus missingness flags; normalization and hyperparameter selection never use the final test partition.

Out-of-training-range features and previously unseen missingness patterns return no shadow prediction. Read coverage and fallback counts alongside paired accuracy: a model that predicts on only a small easy subset has not demonstrated general improvement.

Exports retain an `attempts` list, including unavailable prefixes and missing or invalid terminal labels. Scoring uses all exported test-partition attempts as the coverage denominator, not only successfully joined samples. Rejected recording runs remain separately reported gaps: their missing contents cannot be reconstructed or counted as zero failures. Legacy hand-built sample-only inputs have a sample-only denominator and must not be used to claim overall runtime coverage.

The report separates request-anchor and delivery-time error. It includes turn-macro MAE, signed bias, median absolute log error, tail underestimation and fraction within 30% using a **60-second denominator floor**. The latter is not ordinary percentage error near zero. Observed-age strata are not full-task progress phases. Normal runtime end does not prove a correct benchmark solution.

Loading an artifact remains an explicit local developer operation: validate the generated artifact, place a copy at `residual-research/artifact.json` while the plugin is disabled, and restart. There is no automatic training or promotion to displayed ETA. Do not copy the data directory or identity secret into a release package.

Passing synthetic tests demonstrates schema, numerical and integration correctness only. Actual accuracy improvement, long-task generalization and acceptable coverage still require held-out real data.
