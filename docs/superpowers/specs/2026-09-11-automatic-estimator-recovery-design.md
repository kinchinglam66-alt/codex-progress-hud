# Automatic estimator recovery and uncapped cross-conversation concurrency

Status: detailed design pending user review; implementation not started.
Base: main 2f54a4b. Supersedes the manual-confirmation and legacy-reboot-only
requirements in the 2026-09-10 orphaned estimation recovery design for this scope.

## Approved product decisions

- No plugin-imposed total concurrent estimation-call ceiling by default.
- One active estimation request per conversation; coalesce additional triggers.
- An exceptional invocation must not stop unrelated conversations.
- Legacy calls without verifiable process identity may be abandoned after a
  conservative timeout, accepting possible remote overlap and additional usage.
- Preserve missing usage as unknown, never zero. No ledger deletion/reset.
- Ordinary recovery must not require a repair button, another login, or reboot.

## Architecture

Replace the fixed two-worker array with lazily allocated conversation-owned
workers. Remove the matching two-call gates in scheduling policy, ledger admission,
and persisted-ledger validation. Do not preallocate unbounded processes. Create a
worker only for an eligible conversation and dispose it after confirmed cleanup.
Keep task selection/tracking limits separate from inference concurrency; report
them honestly rather than presenting a hidden two-call cap as unlimited.

Retain a single serialized ledger writer and short account-metadata critical
sections. Inference runs outside those critical sections. Default concurrency has
no finite configured ceiling; adding a user-facing concurrency setting is outside
this repair. Existing trigger coalescing and per-conversation intervals remain.
OS capacity or provider refusal produces a retryable diagnostic, not a promise of
unlimited physical resources. Arithmetic/storage checks remain but must not use
the removed two-call constant to calculate overflow safety.

## Durable invocation ownership

Persist a unique admission/attempt identity, conversation and turn generation,
runtime owner, provider kind, dispatch phase, deadline, and available process
creation identity. Bind subscription children before sending the inference input;
the spawn-to-binding crash window remains unconfirmed, not falsely undispatched.
For HTTP calls, record request ownership and cancellation separately; local abort
is not evidence of provider-side cancellation.

Track local cleanup and returned usage independently. Settlement, orphan
classification and retry claims are atomic and idempotent. Stale results cannot
update a newer turn or settle a replacement admission. All process termination
must use verified HUD ownership plus creation identity, never executable name or
PID alone. Never terminate the primary Codex task or unrelated processes.

## Automatic reconciliation

Run a local reconciliation pass on ledger acquisition and upon an unresolved-call
event. While enabled, schedule checks at the next relevant deadline, with a
30-second maximum interval when unresolved records remain. No extra periodic
model call is needed for these checks.

For new records, confirmed local exit releases occupancy immediately and preserves
unknown usage if needed. A live verified HUD-owned call retains occupancy until
its recorded timeout, when owned cleanup is attempted. Failed cleanup quarantines
that invocation; it must not poison all workers. Missing ownership evidence is
handled as unconfirmed, never converted into confirmed process closure.

For legacy records without sufficient ownership evidence, initially wait until
five minutes after persisted admission. If already older at acquisition, reconcile
immediately. Five minutes is a grace policy, not proof of remote completion; the
current normal inference process/API timeout is 60 seconds. Clock rollback or a
future timestamp uses a five-minute monotonic grace from acquisition, avoiding
premature release. A verified post-reboot boundary may release earlier.

In one transaction, release logical occupancy and retain an explicit
`abandoned_unconfirmed` outcome with unknown usage and recovery provenance.
Do not label this `safe_unknown` or set remote-cancellation-confirmed. Record that
the user's accepted overlap policy, rather than process-exit proof, allowed it.
Do not let an old global unsafe-unknown flag re-block all requests after migration;
derive invocation-local blocks from records, retaining genuinely global failures.

After release, permit one normal estimate for an eligible current conversation
under existing authorization. Do not require a synthetic model trial, and do not
generate estimates for idle or completed conversations. Coalesce multiple old
records into one pending retry per conversation. Persist the retry claim before
dispatch so restarts cannot grant duplicate immediate retries. If the replacement
also fails unconfirmed, apply per-conversation retry backoff: 1, 2, 5, 10, then
30 minutes, retaining the 30-minute ceiling. Successful calls reset the failure
streak. New user turns cannot erase the conversation's retry backoff.

## Failure scopes and interface

Process failure, malformed output and abandoned calls are invocation-local.
Provider 429/cooldown may apply to the affected account/provider, respecting its
retry delay. Revoked authorization, an unreadable/corrupt ledger, or loss of
exclusive ledger ownership remain legitimate provider/account-wide blockers.
Do not bypass these protections under the label of automatic recovery.

Show temporary recovery or next retry information in diagnostics. A recovered
legacy unknown is historical information, not a permanent repair-required state.
Retain optional diagnostics/manual retry, but normal recovery does not depend on
user interaction. Disabling the plugin stops new calls and recovery timers;
account changes isolate both ownership and retries. No authentication approvals
are implicitly expanded by this policy.

## Validation and delivery

Use temporary ledgers, fake clocks and controlled owned processes. Cover more than
two simultaneous conversations, per-conversation coalescing, no global stop after
one poisoned worker, legacy ages on both sides of the grace threshold, clock
rollback, migration/reopen, PID reuse, live/exited/uninspectable processes, HTTP
abort, late responses, disabled/account-switch races, and crash at each durable
dispatch/settlement/retry boundary. Preserve accounting totals and unknown history.
Test retry claims across restarts and confirm no periodic synthetic inference.

Run focused tests during implementation, then full suite/typecheck/build and one
accounting/security review (Sol medium), with at most one fix review. Perform
packaged startup/settings/shutdown checks and verify installed archive hashes when
installation is requested. Real recovery validation must separately establish that
normal estimation resumes without a repair click; unit tests alone do not prove it.
No batch accuracy evaluation, personal documents, or unrelated refactoring is in
scope. Do not mutate the production ledger manually to simulate success.
