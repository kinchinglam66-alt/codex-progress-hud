# Production ETA timing and four-task pilot

## Scope and invariants

Measure the installed native ETA path before changing algorithms or cadence. Keep
authorization, account validation, durable accounting, cancellation and the 30s
deadline unchanged. Telemetry must never authorize, cancel or retry a request.
Do not store prompt text, paths, account identifiers or raw errors in timing rows.

## Implementation sequence

1. Add a passive monotonic request clock: source preparation, account/runtime,
   fork/import, compaction, provider inference, result validation/settlement.
   Phases are exclusive; unseen phases remain null, not zero. Preserve the old
   provider timings separately. Record timeout snapshots and final settled time.
2. Attach each clock to the scheduler flight and existing persistent-worker
   phase events. Unsubscribe at flight completion. Keep independent conversations
   isolated. Record through the bounded, allowlisted pilot journal.
3. Test deterministic phase accumulation, repeated phases, timeout snapshots,
   cancellation, non-finite clocks and privacy projection. Test scheduler and
   actual native worker integration, not just an unused helper.
4. Run focused tests, one scoped review, then the full frozen-source regression.
   Build and install only after safe plugin disable; preserve user data.
5. Create four approved independent tasks using Luna/max, standard mode. ETA
   remains Luna/medium. Aim for initial, same-turn update and next-turn samples
   per conversation (12 total), without fake delays or fabricated samples.

## Pilot evaluation

Freeze version and record task IDs privately. Verify standard mode before task
creation. Use substantive project reviews with distinct scopes and read-only
first turns so concurrent tasks do not modify the tested implementation.
Record runtime completion boundaries independently from ETA predictions. Exclude
user waits/pauses; uncertain boundaries are coverage-only, not scored accuracy.
Report accepted/failed/missing observations, phase latency, deadline exceedance,
remaining active-time error and ETA/task token ratio with unknown usage explicit.
Cached input is a subset of input, never added twice. No claims of equivalent
manual-fork comprehension without a paired semantic comparison.

## Measurement definitions

`requestProfile` is additive metadata alongside the existing provider `timings`.
The monotonic clock starts at scheduler-flight creation and ends at result
recording (including account validation and durable settlement before that
result). It excludes subsequent retention release and renderer paint. A timeout
adds a snapshot without pretending that the worker has exited; a later terminal
result retains the full settled duration. An unclean shutdown may leave no result.

`sourceMs` covers source acquisition before native phase callbacks;
`accountProcessMs` covers the existing account/runtime preparation phase;
`forkImportMs` covers native fork/import work; `compactionMs` covers observed
compaction; `inferenceMs` includes network/provider time; `deliveryMs` covers
result validation/settlement. Unsupported workers use `unattributedMs`, not a
fabricated source or model duration. Phases can recur and are summed exclusively.
Null means unobserved; invalid monotonic clocks invalidate the whole profile.
No source text, task ID, path or account identity is added by these fields.

## Completion

Instrumentation alone is not completion. Deliver a tested installed build and
the four-task pilot report, or clearly identify the remaining external blocker.
Private task context and experimental raw files must not be published.

## Pilot-discovered prerequisites

The first installed pilot produced no accepted ETA. Do not score its interrupted
reviews as completed accuracy samples. Preserve its private observations as a
separate failed-connectivity round, not twelve valid timing points.

Before resuming the pilot:

- Parse validated `item_completed/FunctionCallOutput` mirrors as tool data.
  Preserve complete output and explicit turn attribution. Collapse only equivalent
  attributed results; retain changed output and inferred/explicit variants.
- Forward native retention permits and state through the provider host. The
  runtime remains the owner after an outer scheduler lease is released. Idle
  revocation must still reach that owner; disabled/replaced providers receive no
  new keepalive permit.
- Fence every native preparation entry against caller cancellation and provider
  generation changes, before and after awaiting. Preserve existing snapshot
  ownership: paired readers/fallbacks stay caller-owned; legacy transferred native
  snapshots rejected before delegation must be closed by the wrapper.
- Verify with local synthetic regressions and read-only parser replay, then full
  regression/review and a disabled-plugin installation. No algorithm/cadence,
  accounting policy, authentication or thirty-second deadline changes.
- Resume a single approved test conversation first. Expand to the existing four
  only after a valid installed ETA; keep the repaired round separate from the
  failed original round. Do not create extra tasks or fabricate missing samples.
