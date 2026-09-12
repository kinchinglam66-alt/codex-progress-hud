# Local residual ETA implementation evidence

Status: implementation, architectural fix review and final regression complete. Not merged, pushed, installed or promoted to displayed ETA.

## Scope exercised

- Separate strict metadata schemas and stable numeric feature/missingness vector.
- Independent source-backed normal-end labels, contradiction/clock invalidation and takeover ordering.
- Local anonymous identities, bounded queued recording, digest/closed-run validation and conservative loss handling.
- Offline joins, explicit disjoint manifests, turn-balanced ridge fitting and scale baseline.
- Artifact validation, version/range/missing-pattern fallbacks and paired request/delivery metrics.
- Existing full-context scan instrumentation, optional scheduler integration and default desktop research initialization. Raw ETA and pace shadow retain their original meanings.

The implementation keeps whole-turn elapsed and outstanding action active age unknown where pause-free timing cannot be proved. These are coverage limitations, not zero-valued observations. No artifact is automatically trained from user data or promoted into the HUD display.

## Verification so far

Fresh isolated worktree: `feat/local-residual-eta`, base `60c09e5`. New dependencies were not installed; the worktree uses the existing dependency tree. No benchmark/provider inference was invoked by these tests.

Initial baseline: 2,161 passed and one cross-process test failed because the new worktree lacked `dist/lifecycle/state-store.js`. An explicit build followed by the failing test passed. This was a setup dependency, not a source change.

After implementation, build plus full Vitest suite passed **2,198 tests in 189 files**, duration **230.22 seconds**. Typecheck passed. A subsequently added CLI integration test exercised synthetic train and score commands; both CLI tests passed. Final post-review verification will supersede these counts if fixes are required.

Red/green steps were observed for schemas/features, lifecycle reducer, recorder, dataset, regression/prediction, scoring, command export, history capture, runtime join and takeover/scheduler integration. Existing fake-worker tests confirmed research failure does not change public task state or the number of task-estimator invocations.

## Architectural review corrections

The single architectural review identified four gaps. Corrections now require bounded source terminal time with complete history and a stable wall/monotonic bridge; bind feature metadata fingerprints to the original request prefix; retain unavailable-prefix and unusable-label attempts in coverage; and propagate real goal generations with explicit release on stop/remove/prune. Additional regressions reject contradictory sequence reuse across both affected identities and require one-to-one eligible attempt/sample joins. Build and 52 focused tests passed after these corrections. The one read-only fix review confirmed all four findings resolved with no remaining P1/P2 findings.

After that review, a small bounded-wait adapter completed the planned startup/shutdown isolation: 250 ms per operation, late initialization closes rather than attaches, and slow I/O cannot indefinitely hold the desktop's research wait. Two fake-timer tests and two desktop composition tests passed; this final adapter was self-reviewed, not included in another delegated review.

An unrestricted-parallel full run had 2,199 passes and six failures (five files), including deadline-sensitive runtime, accounting, Hook, HTTP and companion-lifecycle tests. The runtime file passed alone. Failures are retained here rather than reported as a clean run. The repository's serial release-test flags passed **2,206 tests in 189 files**, duration **354.93 seconds**, without weakening assertions or timeouts. That run began before the final availability test file was added.

Final whole-tree verification after the last source edit: `vitest run --maxWorkers=4` passed **2,208 tests in 190 files**, duration **195.02 seconds**. Typecheck and build passed, as did `git diff --check`. This is source-level verification, not packaged GUI acceptance or real-task accuracy evidence. Personal documents, datasets, keys and local fitted artifacts are excluded from the commit; `residual-research/` is explicitly ignored.

## Synthetic microbenchmarks

Environment: Node v24.14.1, AMD Ryzen 9 8940HX. Results are one local run, not cross-machine performance guarantees.

| Operation | Work | Measured result |
| --- | --- | --- |
| Validated frozen-artifact prediction | 1,000 warmups, 10,000 predictions | 20.6397 ms total; 2.06397 microseconds mean |
| Recorder enqueue | 128 structured records, followed by close/drain | 29.43515625 microseconds mean; 38.1 microseconds P95 |
| Recorder drain result | Same 128 records | 128 written; 0 dropped; no recorded failure |

The enqueue measurement excludes final disk drain and is not disk throughput. The predictor measurement excludes artifact loading, context preparation and model invocation. Neither proves that total plugin overhead is zero. Scripts/evidence are retained in ignored `.superpowers/sdd/2026-09-12-local-residual-eta`.

## Accuracy evidence boundary

No held-out real-task accuracy result was produced. Synthetic constant-bias fixtures deliberately have a learnable relation and cannot establish improvement on real long tasks. Support gates, fallback coverage, grouping and exclusions must be reported before making an empirical claim. Runtime normal completion is not benchmark correctness.

No personal positioning documents or private task text were copied into this report. Research datasets, identity secrets and fitted user artifacts are not included in Git.
