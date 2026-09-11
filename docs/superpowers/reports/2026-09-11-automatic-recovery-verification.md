# Automatic estimator recovery verification

## Implemented behavior

- Conversation-owned lazy workers remove the former two-call inference ceiling;
  each conversation still has at most one active request.
- Subscription ownership is persisted before input reaches the child. Windows
  recovery checks a pinned process handle and creation identity before cleanup.
  Uninspectable identity-bearing processes remain quarantined, not age-released.
- Legacy invocations without process identity may release logical occupancy after
  five minutes. This is not proof of remote cancellation: usage stays unknown.
- Subscription and API recovery preserve history and retry claims across restarts.
  Repeated failures back off for 1, 2, 5, 10, then 30 minutes per conversation.
- API credential/endpoint changes isolate retry history. Clock rollback uses
  monotonic grace; retry delay after abandonment starts at actual recovery time.
- Background accounting recovery advances even without incoming worker requests.
  A retained failed worker can be replaced after its child is confirmed inactive.
- Settings explain automatic recovery instead of requiring a reboot. The snapshot
  client accepts the existing typed timing/runtime uncertainty fields, avoiding
  false version-mismatch errors on late Hook events.

## Verification evidence

An initial corrected full suite passed 1,960 tests across 164 files. Subsequent
packaged smoke exposed the snapshot schema omission; four focused true/false and
malformed-field cases were added and verified red/green. The affected client and
Hook smoke helper suites then passed 48 tests. The final full suite passed **1,964
tests across 164 files** in 187.21 seconds (`--maxWorkers=2 --testTimeout=20000`).
The prior serial complete run took 345.44 seconds. The only routine warning was
Node's experimental SQLite notice.

Typecheck, build, plugin validation, native-launcher integrity, plugin sync and
release package contract checks passed. Packaged MCP-first startup, authenticated
health, passive controls, restart and synthetic two-turn Hook isolation passed
with the original strict smoke assertions. The candidate archive was checked
against all 429 generated application files.

One accounting/security review and one scoped fix review were performed. The
controller fixed the remaining lease-replacement, API rollback and account-scope
findings and verified them with focused regression tests; no third review was used.

## Evidence limits

All ledgers and task events in these checks were temporary/synthetic. No live
estimator inference was requested and no production ledger was edited. These
checks establish implementation behavior, not real ETA accuracy or provider
reliability. A normal-use post-install observation remains necessary to establish
that real estimates resume under the user's current account and network.

The absence of a plugin concurrency ceiling does not bypass provider quotas,
authorization, explicit API budgets, or the separate bounded tracked-task capacity.
More concurrent tasks can consume more subscription/API usage.
