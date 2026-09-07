# Observer re-estimation trigger policy

Status: user approved the proposed rules and defaults; written specification ready
for review. No scheduling code has been changed by this document.

## Objective and scope

Allow useful low-frequency re-estimation during ongoing work without new prose,
and recover from an exhausted ETA without requiring a current tool action ID.
Keep main-task execution passive, independent model selection unchanged, and
existing worker authorization, accounting, cancellation and stale-ticket rejection.
This follows input-facts stage one; preserve its local changes independently.

## Current behavior verified in source

`observer-scheduler.ts` delegates admission to `long-task-policy.ts`. Ordinary
checks require a source revision/content change. Its overdue exception requires
a currentActionId and is consumed per action. Initial delay is 15 seconds, event
coalescing 10 seconds, start-to-start cooldown 60 seconds, rolling-hour admission
12 starts per conversation, with at most two global in-flight requests.
Adaptive intervals currently use 2/5/15/30 minutes for known estimates.

## Architecture

Retain the scheduler/worker split. Add a pure trigger decision that returns one
static trigger reason or one static block reason and the earliest eligible time.
The scheduler owns event coalescing, observed active-time anchors, accepted-prediction
identity and reservations; the worker remains the final authority on spend.
Selection must not execute model calls synchronously on Hook/HTTP callbacks.

A source revision is information availability, not automatically an important event.
Keep semantic target/completion judgments in the independent observer.

## Trigger classes

1. Initial: context must be ready; retain the existing 15-second startup gate.
   Repeated polling or tool output must not restart that gate indefinitely.
2. Important event: user amendments, runtime resumption, structured tool failure,
   and final/phase-result evidence may schedule an event check. An assistant claim
   is evidence to inspect, not a locally confirmed completed phase. Unstructured
   log text or keywords alone must not classify success/failure. Generic tool output
   remains ordinary new information, not an immediate-call event.
3. Periodic: running, context ready and observed active work increased since the
   last attempt. A new text revision is not required. Never interpret elapsed wall
   time alone as new work while paused, waiting, terminal or source-unavailable.
4. Overdue: a valid accepted prediction has exhausted its remaining active time.
   Allow a recheck after 15 additional active seconds, without a tool action ID.
5. Status check while waiting: retain one check for newly arrived final-answer
   evidence. Ordinary periodic and overdue checks remain disabled while waiting.
6. Proven pre-dispatch transient retry: preserve current eligibility and single-retry
   restriction. A timer or overdue condition never supplies proof of safe retry.

When multiple reasons are eligible, coalesce into one request. Prefer waiting-status
or important-event work, then overdue, then ordinary periodic work. Preserve fairness
across conversations; sustained important events must not starve another eligible
conversation indefinitely. Record the selected reason, not raw event text.

## Default timing and budget

| Condition at scheduling snapshot | Ordinary interval |
| --- | --- |
| Remaining <= 30 minutes | 5 active minutes |
| Remaining <= 2 hours | 10 active minutes |
| Remaining <= 8 hours | 15 active minutes |
| Remaining > 8 hours | 30 active minutes |

Use pause-excluding observed active time for periodic spacing and overdue grace.
Use monotonic wall time for the 60-second start cooldown and rolling-hour counts.
Important events coalesce for 10 wall seconds after the first pending eligible
event; later noise joins the batch without postponing it forever. Events received
after a request snapshot remain pending for the next permitted call.

No valid estimate: ordinary checks back off to 5, 10, then 30 active minutes after
successive no-estimate results without meaningful new evidence; remain at 30.
Also apply that backoff to repeated timer-only answers already overdue on arrival,
so a new tiny/zero forecast cannot continuously rearm 60-second calls. New meaningful
evidence can reset this backoff, not the rolling-hour budget or in-flight ownership.

All classes obey existing limits: 12 starts per conversation per rolling hour,
two global workers, one in-flight request per goal, and 60 seconds between starts.
These are ceilings, not usage targets. Initial reservations remain conservative;
do not refund or bypass admission on uncertain dispatch/usage outcomes.

## Identity, deduplication and failure boundaries

- Track a local identity for each accepted non-null prediction, including goal
  lifetime/source epoch. Do not use rounded ETA values, currentActionId or a numeric
  generation alone as identity. Summary-only updates must not rearm overdue checks.
- A prediction gets at most one overdue reservation. Mark it only after admission
  and goal-ticket reservation, never while blocked by capacity or context readiness.
- Pausing/resuming the same goal keeps its overdue reservation and accumulated
  periodic active interval. A replacement goal gets fresh local trigger state but
  keeps the conversation rolling-hour budget.
- Old in-flight replies cannot update a replacement goal's anchors or reservations.
- Provider errors, account failure, unknown usage and disabled/poisoned workers keep
  their current safety behavior. There is no new broad retry mechanism.
- Reject invalid clocks/counters conservatively. Source readiness and authorization
  gates precede model dispatch even when an ETA is overdue.

## Diagnostics and evaluation

Extend existing bounded observation records with static trigger reason codes and
active-time scheduling anchors. Keep skip reasons distinguishable: context missing,
runtime ineligible, coalescing, cooldown, adaptive interval, no active progress,
overdue already checked, retry backoff, hourly limit and worker/concurrency limits.
Do not include task text, credentials or new raw host identifiers in diagnostics.

Virtual-clock fixtures cover initial context delay; pure-model work with no new
prose; long tool runs; dense logs; amendments; overdue without action ID; exhausted
forecasts returned repeatedly; waiting/final evidence; pause/resume; replacements;
stale replies; provider failures; rolling-hour exhaustion; concurrent fairness;
and late-arriving events during an in-flight call. Assert actual worker invocation
counts and observed inputs, not only decision-helper return values.

Measure missed eligible triggers, extra/duplicate calls, dispatch delay from the
earliest eligible instant (separating cooldown/budget/capacity blocks), per-hour
starts, and service fairness. A blocked request is not automatically a missed trigger.
Use synthetic virtual time, no live inference or batch accuracy evaluation in this
stage. Then run focused integration tests, typecheck/build, one final full regression,
and one independent review with at most one fix review under the user's agent policy.

## Acceptance and handoff

No-text running work receives a periodic opportunity; ETA exhaustion receives one
bounded recheck regardless of tool ID; pause/wait never produces periodic calls;
bursts cannot create duplicate starts or indefinitely postpone a pending event;
all budget, isolation, stale-response and accounting protections remain intact.
These tests establish scheduling behavior, not improved ETA accuracy or lower cost.
Implementation, commit/push and local installation are separate subsequent actions.
