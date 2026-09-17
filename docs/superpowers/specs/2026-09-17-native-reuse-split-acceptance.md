# Native reuse split acceptance v2

## Prospective amendment: split-v3 (user selected option1)

On2026-09-17 the user approved reporting token growth separately instead of treating it as a qualification veto. Future experiments may explicitly register `--split-usage-report` / `split-v3`; `--split-acceptance` retains v2 behavior. Conflicting selections are rejected. Historical artifacts and verdicts are unchanged.

V3 retains every stage-specific timing threshold below, exact matched checkpoints, content/freshness/isolation requirements, valid accounting evidence, no unresolved execution, confirmed cleanup and non-increasing measured lifecycle time. Only the known/unknown usage growth veto is removed. Each stage separately reports known input+output, cached input already included, and unknown-usage count for both arms. Unknown is never zero; missing or malformed numeric evidence is not permitted. Complete token cost cannot be compared where either arm has unknown usage. No monetary or cheaper-subscription claim follows from passing v3.

Confirmed completed operations with unknown usage remain distinguishable from failed/unconfirmed operations; this amendment does not alter runtime admission, ledger or failure handling. Promotion still requires the registered size strata and fresh-nonce/reversed-order confirmations. No installation is authorized by a scorer pass alone. All v2 prose below is preserved as the original policy, superseded only on the explicit v3 usage-veto point.

Decision: on 2026-09-17 the user selected 分项验收. This prospectively replaces the overall median preparation threshold for future qualification. It does not rewrite Series14–22 results, change production behavior, or authorize installation.

## Stage-specific performance requirements

Compare matched history/native measurements separately for cold long-history preparation, same-source-turn continuation, and a new source turn. Preparation starts before account/process preparation and includes source validation, copying, import and any required compaction. Delivery ends at the first valid ETA. Background work and final cleanup remain in lifecycle accounting; moving work outside the request is not free acceleration.

| Stage | Preparation requirement | Valid ETA delivery requirement |
| --- | --- | --- |
| Cold long history | native <= 0.70 × history (at least 30% faster) | native <= history |
| Same-source-turn continuation | native <= history | native <= history |
| New source turn | native <= history | native <= history |

All three rows must pass. No cross-stage median or cold saving may offset a warm/new-turn regression. Equality passes; no hidden tolerance or post-hoc exclusion. These are observed timing requirements, not statistical proof of equal population latency.

## Unchanged prerequisites

- Three valid matched pairs per series, complete source/content evidence, no expired ETA, unchanged source isolation and account authorization, and confirmed cleanup.
- Content-failure collection is diagnostic only: an invalid slot fails the series even if other pairs pass. Runtime, ambiguous completion and accounting failures retain existing stop behavior.
- Report total and cached input separately without double-counting; retain every unknown-usage record. Missing compaction usage is not zero cost. Existing lifecycle and unexplained-token-increase checks remain; split timing acceptance does not waive them.
- Synthetic history only. Keep the same model, effort, speed, source fixtures and account rules across arms. Apply common preparation optimizations to both arms.
- Preserve existing default flags and the old scorer/results. A future v2 scorer must identify its version explicitly, without overwriting old gate fields.

## Prospective evidence protocol

Before new calls, register source size, code/build identity, fixed operation count/order, scoring version and cache counters. First run the 1MiB stratum; expand to 85KiB only if all requirements of the explicitly registered acceptance version pass (v2 for original registrations; v3 when explicitly selected under the approved amendment). Passing a single series is provisional: before promotion repeat both strata once with fresh synthetic nonces and reversed arm order, retaining all results. A failed series stops expansion pending diagnosis; no success-only reruns. Register any protocol amendment before observing its new results.

## Existing evidence, not a new qualification

Series22 cold preparation was 228.252 s history versus 8.692 s native (about 96.2% faster). Same-turn preparation was 5.216 versus 6.099 s, and new-turn preparation 6.751 versus 11.851 s. New-turn delivery also regressed, 13.366 versus 27.246 s. Therefore the candidate would still fail v2 timing requirements. Its original gate remains failed; earlier semantic failures and unresolved usage/cost questions are not cleared by this decision.

## Next implementation order

1. Add a separate versioned stage scorer with boundary tests: 30% equality, each independent warm/new-turn failure, delivery regression, invalid/expired pairs, and unchanged legacy scoring.
2. Use numeric-only profiling to attribute account/process, local snapshot validation and new-turn supplement import. Preserve both remote identity observations and local integrity checks; existing profiling does not justify removing them.
3. Implement only a measured optimization with a falsifiable hypothesis and focused regression tests. Do not run another model batch merely because the acceptance definition changed.
4. Run the registered paired protocol after a concrete change, then review content, timings, ledger and cleanup together. No merge, push or installation in this milestone.
