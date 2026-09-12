# Same-turn HUD restart recovery

Status: conceptual design approved; written specification awaiting user review.
Baseline: main b44baadaf6c1d34e211f5def2d0d6e20c952728b.

## Problem and evidence boundary

The observed companion restart was followed by all eight tracked conversations
losing accumulated active time and prediction revisions. PassiveGoals currently
keeps those values in memory. Rediscovery constructs new zero-valued goals.
This explains the state loss, not the cause of the process exit. Startup and
crash-recovery labels alone do not establish a crash exception or its cause.
An unresolved prior invocation also blocked one recovered conversation.

The repair has three separately verified outcomes: preserve same-turn state,
reconcile orphaned invocation occupancy under the existing recovery policy, and
make lifecycle evidence sufficient to distinguish exits from competing starts.
Do not claim to have eliminated the original exit without a reproduced cause.

## Product contract

- Recovery is automatic, with no model call required merely to restore state.
- Persist confirmed active time, runtime/pause state, latest numeric prediction,
  its active-time anchor, estimate revision and progress high-water mark.
- Restore only the same native conversation and native turn. A verified new turn
  starts fresh; matching a display name, arrival time or process-local epoch is
  insufficient. Never resurrect a completed turn as running.
- Exclude unverifiable downtime from confirmed active time. Record timing
  uncertainty explicitly; wall-clock elapsed time is not proof of active work.
- Preserve pause/wait semantics. Resume countdown only after fresh native source
  evidence confirms that the same turn is running.
- Do not persist conversation text, model summaries, tool output, credentials,
  account identifiers or raw source paths in the recovery checkpoint.
- Keep the ledger, authorization, proxy and account configuration unchanged.

## Architecture and responsibilities

Introduce a bounded checkpoint repository, separate from the usage ledger and
measurement journal. PassiveGoals exports and restores validated value records;
it does not perform filesystem I/O. The HTTP-server composition layer owns the
repository, persistence scheduling and startup reconciliation. Conversation source
evidence remains authoritative for turn identity and execution boundaries.

Each record contains a schema version, opaque source-root identity, conversation
and native turn identity, record revision, saved wall time, confirmed active
seconds, saved runtime state, latest numeric estimate with its active-time anchor,
prediction revision, progress high-water mark and uncertainty flags. Store no
process-local performance.now() origins, object identities, tickets or pending
model requests. Rebuild new local identities after validation. Rebuild textual
context from the existing source; a restored prediction does not imply that a
previous semantic summary has been restored.

Persist prediction uncertainty relative to its original estimate, not the live
countdown denominator. Restore any numeric exclusion/anchor values necessary to
avoid deducting previously excluded paused time twice. Reject inconsistent or
non-finite values rather than guessing their interpretation.

## Persistence and ownership

Place the checkpoint within the existing companion user-data directory, not the
repository or plugin installation directory. Use schema-validated JSON, verified
regular files, restrictive creation permissions and trusted-directory checks.
Existing safe-files helpers are building blocks, not an atomic-replacement API.

Only the current exclusive companion owner may write. Serialize writes, fence
stale owners and prevent older asynchronous snapshots replacing newer revisions.
Write a sibling temporary file, flush and atomically replace the checkpoint;
replacement failure must preserve the last valid checkpoint. Retain no raw-data
backup history. Validate directory and file identity around access and reject
links or path replacement. Restore at most 256 records from a maximum 1 MiB file;
oversized or malformed data produces a local diagnostic, not a server crash.

Checkpoint meaningful state changes with a coalesced write within one second.
While active, checkpoint every five seconds. Attempt a final serialized flush on
orderly shutdown. Under successful storage, abrupt termination can lose up to
five seconds of confirmed active time plus write latency; do not promise zero
loss. Storage failure leaves live tracking operational and marks persistence
degraded. Never block the main Codex task on checkpoint I/O.

Remove completed/stopped records on the next successful write. On startup discard
records older than seven days and reject future timestamps as clock uncertainty.
These are cache retention bounds, not task execution limits. If record capacity
is exceeded, prioritize currently tracked active records, then most recently
updated records; report omitted recovery coverage without limiting live tracking.

## Startup reconciliation

1. Acquire the existing companion ownership before reading or writing state.
2. Load checkpoint values into a pending recovery set, not live running rows.
3. Obtain fresh native source identity and current turn/execution evidence.
4. Same turn: restore confirmed values and create fresh runtime identities;
   anchor subsequent monotonic accounting at the current monotonic clock.
5. Running evidence: continue countdown from the saved active-time position and
   mark the intervening unobserved interval uncertain. Waiting/paused evidence:
   retain the frozen value. Terminal evidence: apply the native terminal state.
6. New turn: discard the old record and follow normal new-turn initialization.
   Unavailable or ambiguous evidence: keep recovery pending, without a running
   countdown or automatic model dispatch based only on the checkpoint.

Repeated discovery is idempotent. A late old-turn observation or model response
cannot overwrite recovered state belonging to a newer native turn. Native turn
identity, runtime generation and measurement segment identity remain separate:
recovery does not stitch independent measurement segments into clean evidence.
Emit recovery provenance and the uncertain gap in local diagnostics/measurement
events without including conversation contents.

## Orphan calls and lifecycle diagnostics

Continue the approved policy in
`2026-09-11-automatic-estimator-recovery-design.md`: verified local closure releases
occupancy; unconfirmed legacy calls may be abandoned after its conservative grace
period with explicit overlap risk and unknown usage retained. This repair does
not silently tighten that approved policy or introduce an unlimited retry loop.

Reconcile prior calls before replacement admission, preserve admission identities
and retry claims, and apply the existing per-conversation backoff. Restoring a
goal never restores a pending ticket or settles a usage record. A late result
cannot settle a replacement call. Neither a successful checkpoint restore nor
the absence of a local process proves zero remote usage.

Lifecycle diagnostics should identify owner/run identity, startup cause,
ownership acquisition/rejection, orderly exit intent and available exit/error
details. Report diagnostics for the current runtime, labeling historical entries
as historical. An external kill may leave no exit event; report cause unknown.
Any behavior change to startup arbitration requires a failing reproduction first.

## Verification and delivery boundaries

Use fake clocks, temporary user-data directories, controlled child processes and
synthetic source events. No new benchmark or paid inference is needed here.

- Eight independent running turns survive a companion recreation with their
  confirmed time, prediction, revision and progress preserved independently.
- Pause/wait survives restart, incurs no countdown during recovery, and resumes
  only with valid same-turn running evidence.
- New-turn, terminal, stale-event, source-root mismatch and missing-source cases
  cannot revive an old goal or spend tokens from a checkpoint alone.
- Monotonic origins changing, wall-clock rollback, large gaps and successive
  restarts neither invent active time nor subtract a pause twice.
- Torn/malformed/oversized data, links, replacement failures, stale owners and
  out-of-order write completion preserve valid state or degrade explicitly.
- Outstanding known/unknown calls recover under existing ledger rules without
  duplicate admission, lost usage or global blocking of unrelated conversations.
- Recovery diagnostics distinguish a new measurement segment from uninterrupted
  observation; preserved benchmark data remains untouched.

Run focused tests first, then full tests/typecheck/build at the milestone, with
one accounting/security review. Report checkpoint recovery and crash-cause
findings separately. Installation and real-window validation are later delivery
steps; unit tests alone are not evidence of a fixed installed runtime.

Out of scope: new ETA algorithms, model/frequency changes, benchmark reruns,
ledger clearing, personal research documents, and authentication redesign.
