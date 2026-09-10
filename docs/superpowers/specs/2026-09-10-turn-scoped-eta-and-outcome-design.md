# Turn-scoped ETA and outcome

## Intent

Replace the cross-turn goal horizon with the current execution turn. ETA and
completion refer to exactly the same authenticated turn: from its start until
the assistant finishes that turn's response. They do not predict completion of
the whole project or work requiring future user turns.

This supersedes previous whole-goal semantics, including the observer prompt's
instruction to judge the user's entire goal. The existing model/provider choice,
authorization, accounting, proxy configuration and low-frequency policy remain.

## Runtime and outcome

- A matching explicit normal terminal event (`task_complete`) ends the active
  clock and marks the turn completed even when the project remains unfinished.
- A matching explicit abort/cancellation marks the turn interrupted. Explicit
  task failure marks it failed. A nonzero tool exit alone does not end a turn:
  the executor may still be repairing or retrying.
- A live turn waiting for approval/input is waiting, not completed. Freeze its
  active clock and resume the same clock if execution resumes in that turn.
- A normal final reply that asks the user a question still completes this turn;
  the reply to that question belongs to the next turn.
- A generic Stop/quiescence observation is not automatically normal completion.
  Preserve the event's reason through normalization; if no unambiguous reason
  is available, stop the clock with outcome unknown pending further evidence.
- No output, an expired ETA, or an unmatched tool result is not an end signal.
- Explicit terminal signals are authoritative. The observer may assist when
  evidence is ambiguous but cannot override a known terminal outcome, stop a
  live clock, or restart a stopped turn. A failed observer call leaves an
  ambiguous outcome unknown rather than defaulting to interrupted.
- Late same-turn activity/model responses cannot revive a terminal turn. Events
  and responses for older turns cannot affect the new turn.

## Current-round estimates

At each genuinely new authenticated turn, create a new timing/estimate identity.
Reset active seconds, prediction, displayed progress high-water mark, summary
watermark, uncertainty and per-turn pace samples. Invalidate old in-flight
answers; do not rely on the model returning `replace` to perform this reset.
Repeated delivery of the same start is idempotent. Late attachment through an
accepted current-turn tool Hook initializes that turn without importing an old
countdown. Preserve session-level call budgets and failure backoff.

The model estimates remaining active work in this turn only. It includes
ongoing tools, inspection, implementation, checks and the final response likely
to happen before this turn ends, but excludes future user decisions and later
turns. It excludes pauses/user waits and includes quiet periods of actual work.
The current-turn summary must not become a persistent multi-turn project goal.

Earlier context may be retained as bounded background to interpret requests such
as "continue". Its role must be explicit in the input; it is not unfinished work
automatically included in the new estimate. Only the current turn owns the
estimate/clock. No broader permission to read or send other conversations is
introduced. Internal compatibility names such as `goalSummary` may remain, but
their prompt/assembly semantics must identify the current turn.

## Source and display changes

Carry normal completion separately from generic waiting through the local
session reader, conversation record, bounded context retention and execution
selector. Preserve the previous fix protecting lifecycle metadata during
trimming, including the new terminal reason. Do not infer normal completion
from the old generic `waiting` representation.

Update PassiveGoals to own turn-scoped resets and terminal outcomes, and the
scheduler to stop scheduling estimates for ended turns. An already-started
model operation must still be drained/accounted for even if its result is stale.
Do not send a fresh final-classification call when an authoritative terminal
signal already provides the answer.

Use current-turn wording in HUD status text. Completed turns retain the existing
green-completion semantics and existing filtering out of active rows. Interrupted
and failed turns retain their own labels; waiting/unknown must not look like
completion. A new turn starts a fresh progress bar; within a turn the existing
non-decreasing progress and ETA uncertainty display behavior remain.

## Verification and delivery

Use failing behavioral tests before implementation. Required cases:

1. `task_complete` ends a turn as completed without an observer response even
   when the project or a requested follow-up remains unfinished.
2. Abort and task failure remain distinct; a tool error followed by more work
   does not become a terminal task failure.
3. Approval wait/resume freezes active time correctly without completion;
   a final clarification reply completes its turn.
4. Next-turn starts and late attachments reset time, ETA and progress; duplicate
   starts and stale completions/model answers do not reset or corrupt it.
5. "Continue" can use background context but cannot inherit previous elapsed
   time, prior ETA or a whole-project completion horizon.
6. Trimming preserves terminal reason; missing source data remains unknown;
   quiet running and countdown zero do not imply completion.
7. UI/scheduler integration filters completed rows and prevents new estimate
   calls for them without bypassing accounting for in-flight calls.

Run focused tests during implementation, then typecheck, build and the full suite
at the integration milestone. Use one independent review and at most one bounded
fix review. No real model calls are required for lifecycle acceptance. Prompt
accuracy is not established by local unit tests and should be evaluated separately.

Prepare the two changes as one coherent candidate. Do not install over a running
companion. Preserve user login, settings and accounting data. Keep private notes
and raw conversation samples outside the public repository.

## Implementation map

- `src/observer/conversation-record.ts`, `local-session-reader.ts`,
  `context-owner.ts`, `conversation-source.ts`: explicit terminal provenance and
  protected round-local source interpretation.
- `src/server/passive-goals.ts`, scheduler integration: round resets, terminal
  fences, scheduling eligibility and stale result accounting boundaries.
- `src/estimation/assets/observer-instructions.md`, context assembly and matching
  packaged assets: current-turn ETA instructions and background/current input roles.
- `src/ui/view-model.ts`, progress projection and corresponding tests: current-turn
  labels, completed filtering and new-round progress reset.
- Relevant reader, source-goal, PassiveGoals, scheduler and UI tests: the behavior
  matrix above; retain unrelated provider/security behavior unchanged.
