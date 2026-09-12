# Residual research prefix repair

## Scope

Research collection only. Production estimator input selection, full-context preparation, displayed ETA, exact active-time anchors, generation checks and source-bound terminal validation remain unchanged. No additional history scans or model calls are introduced.

## Changes

- Local-session records retain explicit source turn attribution separately from the legacy reader's inferred `turnId`. Research fingerprints use explicit attribution consistently across metadata reads and fixed-watermark history scans. Existing producers without the new field retain their previous semantics.
- Item events also carry explicit attribution on their outer envelope. Research preserves this when the inner item omits it, and treats conflicting explicit inner/outer IDs as unknown. Normal estimator `turnId` behavior is not changed.
- Research attribution is excluded from the existing per-conversation and global production retention budget. A boundary regression verifies identical retained production records with and without the extra metadata. The metadata stays attached to retained records (including compacted lifecycle records).
- Unattributed messages are excluded from the research fingerprint, not reassigned to the current turn. History coverage remains incomplete where the source reader reports a gap.
- An unattributed tool anywhere in the scanned history conservatively excludes action features with `unknown_attribution`. This can reduce coverage for long conversations; it avoids inventing zero activity when ownership cannot be established. This is not a new production ETA restriction.
- A completed capture survives a partial compression replay of the same fixed snapshot. A contradictory completed replay invalidates the capture permanently.
- Unavailable forecasts retain the legacy `prefix_unavailable` reason and can carry an optional enum-only `detail`. The recorder and dataset exporter preserve it; old records without it remain readable. Aggregate coverage still counts unavailable forecasts once, under the legacy reason.

Details include incomplete scans, unknown attribution, action overflow, snapshot changes, missing/changed fingerprints, changed owners, changed anchors/generations, capture errors and rejected settlement. No transcript text or credentials are included in these diagnostics.

## Evidence and limits

Final validation: 190 test files / 2,217 tests passed (`npm test -- --run --maxWorkers=4`, 172.11 seconds); 107 focused research/export/reader/retention tests passed, as did TypeScript checking, production build and `git diff --check`. These are local automated checks, not live installed ETA measurements.

One independent architectural review and one fix review identified outer-envelope attribution and production-retention accounting respectively. Both were reproduced with failing tests and fixed. No additional review round was run after the retention fix; focused and full automated verification were rerun on the final code.

Regression tests reproduce the original partial-replay reset and attribution mismatch, and verify conservative unknown-tool handling, changed history watermarks, source resets, turn replacement and ordinary ETA independence from research failure. A real local-session reader fixture verifies the same research fingerprint while preserving the two readers' different normal attribution behavior.

Historical generic unavailable records cannot establish which exclusion occurred. This repair does not retrospectively create samples or demonstrate ETA accuracy improvement. Installed collection must be checked after a separately authorized update, followed by source-backed completed samples and held-out evaluation. No trained residual artifact is created by this repair. Unrelated context compression failures are outside scope.
