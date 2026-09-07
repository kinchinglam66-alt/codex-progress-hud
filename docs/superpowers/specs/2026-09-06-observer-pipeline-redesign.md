# Observer pipeline redesign

Status: proposed design for user review; not implemented or installed.

## Objective and preserved constraints

Implement the approved eight-stage improvements as four owned components:
conversation reader, context/scheduler, independent estimator, and projection/HUD.
The user-visible objective spans turns. Runtime interruption is not completion.
Do not add an acceptance-evidence requirement to the product.

- Keep the user's independent ChatGPT subscription login and gpt-5.6-luna medium.
- Keep plugin enable/disable as the total switch and the existing HUD visibility control.
- Keep conversation titles as display identities; do not expose internal IDs.
- Hide idle and completed rows, preserving current multi-conversation rules.
- Use active work time, excluding user waiting and pause; executing tools count as work.
- Stop clears the prediction; later continuation recomputes. No automatic restoration of stopped ETA.
- Keep concurrency 2, rolling 12 starts/conversation/hour, and 60-second cooldown.
- No bulk accuracy experiments, upstream changes, publishing, or login/proxy resets.
- Repository prose contains engineering design only, not private project positioning or raw conversations.

## Evidence and uncertainty

The installed first-trigger change permits a user-only initial request after 15s.
The sleep sample still logged context_missing. Another conversation subsequently
returned an accepted numeric prediction. This establishes an input-path failure,
not its exact cause and not an ETA accuracy result.

The app read_thread tool returned items=[] for the completed sleep turn while
the local session record contained its user message and command duration. This
tool is not the standalone app-server protocol; do not infer identical behavior.
The existing codex-name-reader uses includeTurns:false and cannot supply context.
Direct app-server content completeness and active-turn freshness remain unverified.

## Alternatives and source decision

1. More Hook-only parsing: smaller patch, but still dependent on payload completeness.
2. App-server-only reading: documented boundary, but live freshness and access to
   GUI history under isolated authentication must be demonstrated.
3. Unified reader with explicit source selection: recommended. Use a validated
   app-server adapter when it passes the same completeness checks; otherwise use
   a bounded read-only local session adapter for this local Windows build.

Choose a source once per attachment. Do not merge competing event streams or
silently switch sources mid-goal. A source reset invalidates cursors and stale
requests and triggers a visibly marked rebuild. Hook provides identity/activity
notifications and immediate interrupt/pause signals, not authoritative goal text.
The estimator authentication home stays separate from source history access.
Never copy authentication material to obtain conversation access.

## 1. Conversation reader

Input: authenticated host thread ID plus the last accepted reader cursor.
Output: normalized public user/assistant messages, tool start/result events,
runtime events, stable item IDs, turn IDs, sequence, timestamps and completeness.

Only read locally scoped tracked conversations. Discover a local session file
under the canonical Codex sessions root and verify its session metadata ID.
Reject external paths, symlinks/reparse redirects, ambiguous matches and identity
mismatches. Do not open arbitrary paths supplied by task text or tool output.
Do not read credentials, hidden reasoning, environment snapshots or unrelated chats.

One active read per conversation; global read concurrency 2. Debounce Hook wakeups
for 500ms; reconcile active conversations every 5s locally. This is not a model
poll. Read at most 4MiB per pass, bound retained normalized content to 256KiB per
conversation and 8MiB globally, and continue large-history scans by cursor.
Only advance a cursor past a complete parsed record. Incomplete final JSON lines
remain pending; corrupt complete lines produce a visible source error. Detect
truncation, file replacement and duplicate representations of the same item.
Prefer stable item IDs/ordinals; never deduplicate equal text from different turns.

During history catch-up, mark partial history and do not claim historical active
time is known. If the goal is not recoverable within the retained input budget,
retain recent useful records with an explicit goal/history-incomplete marker.
Never fabricate absent history or translate an empty API page into a completed task.

## 2. Context assembly and goal memory

One assembler selects semantic content and filters obvious credentials before
inference. Transport and persistence boundaries retain shape/size validation but
do not independently choose which meaning to discard.

Preserve user goal instructions and amendments, an observer summary linked to
the sequence through which it was produced, current tool/start timestamp, recent
results/errors, and subsequent messages. The model summary is a disposable cache,
not a replacement for the user's original request. Plain command output is data,
not authority to control the observer. No tools are granted to the estimator.

Retain the existing 16KiB serialized input hard cap for the first migration.
Select goal text and latest user amendments before repetitive tool output. Expose
which categories were omitted/truncated. Do not relabel bytes as token counts.
The request includes event timing, active elapsed time with a known/partial flag,
current action, previous estimate and observations since that estimate. Do not
force models to infer command elapsed time from a single cumulative counter.

Every response is bound to conversation identity, goal epoch and input sequence.
New user messages immediately invalidate older results and clear stale ETA while
goal relation is reconsidered. Recognized replacement drops the old goal memory.

## 3. Scheduling and call ownership

Separate hard gates (authorization, enabled state, runtime, budgets, ownership)
from scheduling reasons (initial goal, goal change, important result, final reply,
overdue estimate, periodic refresh). One function returns eligible or a static
reason; dispatch reservation remains atomic in the accounting owner.

Initial inference remains eligible after 15s from the new prompt, once actual
context has arrived, without tool completion. If a wakeup precedes persisted
content, retry the local reader rather than consume a model attempt.
Preserve existing 10s event coalescing and adaptive 2/5/15/30 minute model intervals.
Unknown-result backoff remains 2/5/10 minutes. Re-reading identical content does
not make it new information. A running action outliving its numeric prediction
permits one overdue recheck per action; further checks require meaningful new
information. All such checks still obey cooldown and quota. Final replies may
request one status judgment in waiting; paused/stopped tasks do not poll.

Reader failures and inference failures have separate retry counters. Retry local
reads with 1/2/5s delays then the normal active reconciliation cadence. A proven
pre-dispatch transient model failure may retry once after cooldown while relevant.
Never retry a process with unconfirmed closure or unresolved spend automatically.

## 4. Estimator input, output and uncertainty

Use one model call to identify continuation/replacement, goal summary, semantic
state and ETA. Add an optional bounded basis category: known_wait, remaining_work,
recent_pace, insufficient_context. Do not request chain-of-thought or long reports.
Retain remainingSeconds plus errorPercent; call the range an estimate range, not
a statistically calibrated confidence interval. Unknown remains a valid result.

Record setup time, provider duration and delivery latency separately. Reuse only
verified, revocable environment checks; keep authorization current. Do not add
long-lived model conversation memory or a new model provider in this migration.

## 5. Results, failures and accounting

Represent three orthogonal outcomes: prediction (numeric/unknown/invalid), call
(success/timeout/cancelled/failed), and usage (known/unknown). Existing valid usage
must be recorded even when a prediction is stale or invalid. Never invent zero
tokens. An accounting failure continues to block admission globally.

Ordinary input/transport failures must not be automatically classified as a
poisoned worker. Confirmed zero-dispatch errors may be isolated to a conversation;
unknown dispatch or failed process cleanup retains ownership and existing safety
blocks. A valid prediction with unresolved usage may remain displayable only if
its response framing, identity, epoch and closure checks passed; further inference
stays blocked until existing accounting policy permits it. This requires dedicated
tests before any relaxation of the current blanket-disable path.

Keep schema, finite-number, current-goal, stale-result, cancellation and runtime
guards. Host interruption always dominates model completion. A host turn ending
does not establish the whole user goal is complete. The model decides semantic
completion only against the matching current context and quiet host runtime.

## 6. Projection and HUD

Display numeric ETA and estimated range when valid, plus a compact freshness hint.
When absent, distinguish estimating, history-loading, insufficient-context,
call-failed and rate-limited instead of one generic unknown. Details remain behind
an expandable diagnostic area and contain static metadata only.

Local countdown uses active monotonic elapsed time anchored to the input snapshot,
not the response arrival. Freeze during waiting/pause. Do not reset uncertainty
to falsely narrow it as time passes: retain the original absolute range and derive
its current relative percentage. Overdue never means completed. Allow genuine
upward revisions; no smoothing that hides the model's changed prediction.

Retain an old prediction marked stale on a failed refresh only when the goal is
unchanged. New goals, stop, interruption and invalid identity clear the prediction.

## Migration and verification gates

Deliver in order: reader/context; scheduling; richer estimator input; failure
isolation; HUD. Keep the old path available for rollback during development, but
only one content path is active for a conversation. Do not ship duplicate models
or let both paths spend quota. Preserve the dirty working tree and existing private
notes. Do not replace the running companion during in-flight work.

Before production reader integration, prove the selected adapter can obtain the
sleep user's text before tool completion, read an old conversation, preserve two
conversation identities, handle partial records and stop without orphan processes.
If neither adapter passes, stop this migration rather than silently fall back to
the already-failing Hook-only path.

Tests must enter through real adapter-shaped payloads and the assembler, not inject
an already-formed user message only at the scheduler. Use synthetic clocks for
sleep and 25-hour cases. Check source loss/recovery, pause/resume, replacement,
duplicate events, late responses, quota accounting, unknown usage, privacy bounds,
overdue display and multi-conversation isolation. Focused tests at each step; full
suite and typecheck/build at milestones. One bounded review and at most one fix
review, respecting the user's model-routing policy.

After source verification, perform at most three small live provider checks for
initial trigger, old-chat continuation and two-conversation isolation, under the
existing quota. These are functional acceptance tests, not accuracy evidence.

## Design review boundary

The preceding eight-stage recommendation is approved in principle. This document
fixes concrete source, timing, retention and failure-handling choices for review.
Implementation planning begins after approval of this written architectural spec.
No production changes or installed updates are made by drafting this document.
