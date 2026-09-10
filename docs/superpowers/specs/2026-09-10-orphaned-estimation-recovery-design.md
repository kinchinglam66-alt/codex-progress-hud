# Recovering interrupted estimation calls

Status: recovery direction and legacy reboot fallback approved.

Delivery sequence: first make local blocks visible and enable conservative
post-reboot reconciliation. Same-boot per-process automatic recovery is a later
increment; this first increment must not infer process closure from a new runtime.

## Problem

On ledger reopen, existing pending admissions enter `recoveredPending`. Ordinary
reservations are refused until those entries settle. Recovery status, however,
can report `normal` because it considers unknown settlements but not recovered
pending admissions. The worker loses the local admission reason and the HUD
renders the rejection as waiting for quota.

The current recovery boundary checks delegates created by the current runtime.
It does not establish closure of a process belonging to a previous runtime.
A successful synthetic trial likewise cannot prove the old call ended.

## Proposed contract

1. Expose a typed local blocking reason throughout accounting, worker, scheduler
   and HUD diagnostics. Distinguish unresolved previous call, concurrency,
   backoff, local budget, and provider rate limiting. Do not include arbitrary
   exception strings, account identifiers or conversation content.
2. Persist a per-call ownership record before dispatch. Bind it to the admission,
   runtime instance and process identity, including creation identity so PID
   reuse cannot establish ownership. Record dispatch and confirmed local cleanup
   separately from usage. Writes must be atomic and crash recovery idempotent.
3. During recovery, stop new admissions, hold exclusive ledger ownership, and
   verify closure of the owned invocation. Inability to inspect ownership is
   not proof of closure. Never terminate unrelated Codex processes.
4. Once local closure is established, settle an orphaned admission as unknown
   usage unless reliable usage was recovered. Preserve starts, known tokens and
   history. Do not represent missing usage as zero or invent remote cancellation.
5. Permit one recovery trial through the existing authorization and bounded
   runner. Retain concurrency and recovery budgets. A failed trial follows the
   existing cooldown policy; it must not initiate an unbounded retry loop.
6. Restore ordinary estimation only after durable recovery completion. A crash
   at any transition must not duplicate settlement or grant extra trials.

## Existing records

Old pending records lack durable process identity. Do not automatically upgrade
them to closure-confirmed. Show a specific recovery-required explanation.
Provide a separate, explicitly confirmed legacy recovery path only after a
reliable local closure check (for example, a verified post-reboot boundary with
HUD ownership established). Account usage remains unknown. If that check cannot
be established, retain the block and explain the missing evidence; do not advise
deleting the ledger. The implementation plan must specify the exact supported
closure evidence before this path is enabled.

## Alternatives

- Raise call limits: does not address the recovered-pending gate.
- Clear pending automatically on startup: loses occupancy evidence and may
  overlap a still-running invocation.
- Recommended: explicit ownership and closure-aware reconciliation, using the
  existing recovery controller rather than a second inference mechanism.

## Verification

Use temporary ledgers and controlled child processes, not user accounting data.
Cover crash before dispatch, crash after dispatch, live orphan, exited orphan,
PID reuse, inaccessible process metadata, two pending admissions, concurrent
recovery requests, account switch, disable during recovery, and a crash between
each durable transition. Verify unknown usage remains unknown after restart,
trial budgets remain effective, and stale results cannot update a new turn.

Add an end-to-end diagnostic test proving a local pending block never appears as
provider quota exhaustion. Run focused tests during development and the full
suite at the integration milestone. Require accounting/security review before
merging. Installation and a small real functional check follow verification;
no batch accuracy evaluation is part of this repair.
