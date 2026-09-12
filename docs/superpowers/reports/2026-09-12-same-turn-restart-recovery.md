# Same-turn restart recovery — implementation report

Status: implementation, consolidated review, fix review and final regression complete. Ready for integration; not merged, pushed or installed. Reviewed production source: `751a718`; final test-fixture revision: `5cec3d3`.

## Recovery contract

The companion keeps a bounded, atomic value-only checkpoint: opaque session/turn keys, confirmed active seconds, prediction/revision, runtime state, progress floor and timing uncertainty. It contains no conversation text, model summary, tool output, account identifiers, credentials or raw source paths.

A new process must observe the same authenticated conversation and verify the same native turn before restarting its active clock. Pending recovery cannot dispatch inference. A different turn starts fresh, explicit native completion remains authoritative, and old in-memory request tickets cannot settle into the recovered goal. Pause survives recovery. Progress never moves backwards because an estimate grows or the renderer restarts.

Orderly desktop shutdown retains runtime ownership until the server close/checkpoint attempt has completed or reached its existing timeout, then clears runtime identity. Other cleanup remains concurrent; a stuck server close does not prevent exit.

Checkpoint storage is capped at 256 records and 1 MiB, with seven-day read retention. Changes are coalesced at one second and periodic writes run at five seconds. The HTTP writer retains at most one in-flight save and one newest pending snapshot under slow storage. A separate storage lock and runtime ownership checks protect replacement; storage failure degrades recovery rather than the main task.

## Measurement integrity

Recovered observations include `timingUncertain`, `recoveryState`, and optional `recoveryGapSeconds`. The gap is the unobserved wall interval from the saved checkpoint to its reload, **not** known downtime or work duration; it is never added to confirmed active seconds. An unavailable or regressing wall clock produces an unknown gap. New turns clear this metadata. Research journals allowlist these fields and omit arbitrary diagnostic strings.

Restarted research segments must not be silently joined as clean continuous timing samples. This change preserves state and labels uncertainty; it does not repair the already-frozen interrupted benchmark or establish ETA accuracy.

## Accounting boundary

Startup attempts existing recovered-call reconciliation only with validated OS boot evidence and unchanged authorized account binding. An ordinary companion restart is not an OS reboot; unavailable/invalid evidence cannot release an unresolved call through this path. Unknown usage remains unknown. No account, proxy, authorization or ledger reset is introduced.

## Lifecycle investigation

The two-manager delayed-readiness test reproduced two spawns before arbitration and one spawn after it. A separate bounded startup claim covers manager startup/readiness, with authenticated re-probes and identity-fenced release. Lifecycle diagnostics distinguish desktop and manager producers and startup attempts. The original incident's exit cause remains unproven. Duplicate `startup_ready` messages alone are not proof of two companion processes.

The first consolidated review found two important lifecycle gaps: startup timeout released a still-live launch, and termination request was not integrated with confirmed exit or persisted post-readiness exit evidence. Follow-up commit `751a718` adds prelaunch revalidation and short generation-locked launch admission, conservative live owner/child fences, an actual child exit promise, and correlated `child_exit` records. A dispatched launch keeps its claim until confirmed exit or later verified process absence; an unconfirmed close does not clear owned runtime. Concurrent explicit reopen remains authoritative.

PID liveness is used only to refuse unsafe takeover, never to authorize killing an arbitrary PID. PID reuse can therefore conservatively delay takeover. OS process creation and filesystem child-PID binding are not an atomic transaction: a manager death between those operations remains a limitation, not a verified guarantee. No operating-system crash injection or installed-window validation was performed.

## Verification

- Recovery/journal/HTTP focused tests: 27 passed before the slow-storage case.
- Recovery repository, goals, HTTP and journal with slow-storage case: 43 passed.
- Broader controller regression (seven files): 135 passed.
- Desktop close-order and HTTP integration milestone: 64 passed.
- Lifecycle sidecar focused tests: 100 passed.
- Milestone full regression: 168 files, 2,073 tests passed (385.18 seconds).
- Build and typecheck passed. The initial milestone was superseded by the frozen final run below.
- Post-review lifecycle fixes: 166 focused tests across five files passed.
- Final frozen full regression: **168 files and 2,079 tests passed**, exit 0, 381.93 seconds (2026-09-12, started 13:41:09 local time).
- Final typecheck and diff check passed. All 151 production source-file hashes remained unchanged from the reviewed follow-up source through final verification; only test fixtures and documentation changed afterward.

## Review outcome

One consolidated Sol/medium review identified the two lifecycle findings above. The single allowed fix review of `80a9351..751a718` reported no remaining Critical, Important or Minor findings, with code approval conditional on final regression. It independently ran 131 relevant tests and typecheck. These test counts overlap the controller's runs and must not be added together as independent samples.

The first post-review full run passed 2,077 tests and failed two fixture checks: the integration delegate used an untyped offline error and lacked the new confirmed-exit promise; a unit case gave real filesystem setup only a 20 ms launch budget. Commit `5cec3d3` aligns the integration fixture with the real client/child contract and gives the fake-clock startup case a 1,000 ms I/O budget while retaining its timeout assertions. No production source changed after code approval. Both affected files then passed all 91 tests, followed by the final 2,079-test full pass.

All new checks use temporary files and synthetic workers. No new live inference, benchmark run, installed-runtime replacement or private benchmark publication was performed.
