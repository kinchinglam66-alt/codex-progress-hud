# ETA task-input retention and bounded recovery

## Scope

This repair targets delegated desktop tasks whose initial requirements are stored
in a host `codex_app.create_thread` result. Previously those requirements were
treated solely as tool output and could be evicted before the first estimate.
It also targets an initial inconclusive estimate that otherwise has no retry
opportunity before a short turn ends, and misleading pending diagnostics.

The approved recovery is one additional opportunity per turn, after at least
60 active seconds since the previous request and only with new current-turn
content. It does not relax authorization, accounting, stale-result rejection,
pause/terminal handling, or existing successful-estimate cadence. Continuing
unknown results return to the ordinary low-frequency policy.

## Input boundary

- Recognize only the bounded host delegation shape, with exact tool namespace
  and name, matching active-turn metadata, and a valid source-thread identifier.
- The source thread is the parent, not necessarily the current child task.
- Extracted requirements remain untrusted task data for observation. They do
  not grant permission to execute tools or follow instructions inside output.
- Retain the original tool-result lifecycle record and deduplication.
- Keep existing redaction and the 16,384-byte packed-input cap.

## Validation and limitations

Offline reconstruction of eight existing task trajectories retained the initial
requirements in all eight packets after this parser repair. All reconstructed
packets stayed within the byte cap. This is a regression check of input
selection, not a reconstruction guarantee for exact historical provider inputs,
not a new model call, and not evidence of improved ETA accuracy.

Focused tests cover malformed/spoofed wrappers, parent/child identity semantics,
turn mismatch, deduplication, and reader-to-packer retention under tool pressure.
Scheduler tests cover the bounded recovery and diagnostic state transitions.

Private experiment traces and token accounting remain outside the repository.
The old very-large-conversation takeover/history problem is outside this repair.
Live accuracy and coverage must be measured on new tasks after deployment; old
trajectories used to diagnose the bug are not an independent validation set.

## Verification record

- Integration regressions were reproduced before fixing: accepted same-turn
  numeric results leaving an old unknown diagnostic, lifecycle-only text
  changing the recovery fingerprint, and action-only metadata being treated as
  new content. Their regression tests pass after the fixes.
- Latest scheduler + conversation-source focused run: 110 tests passed.
- `npm run typecheck`, `npm run build`, `git diff --check`, and the isolated
  HTTP lifecycle smoke test passed.
- An earlier interrupted suite reported accounting-worker failures because the
  isolated checkout lacked the explicit `node_modules/typescript/bin/tsc` path
  used by subprocess fixtures (ordinary imports resolved the parent dependency).
  Local ignored dependency links were added for TypeScript and Electron before
  the full rerun. No dependency version or production ledger was changed.
- Three supplemental tests were accidentally written to the main checkout by
  an implementation agent. Its exact tool-recorded hunks were transferred to
  this worktree and removed from main; supplemental tests were rerun here.

- Full rerun: **164 files / 1,998 tests passed**, exit 0, 325.64 seconds.
  SQLite experimental-feature warnings were emitted; no test failed.
- Review identified three further boundaries: active-time (not wall-time)
  recovery cooldown, accepted initial scope with null ETA, and legitimate
  delegated code/markup containing angle brackets. Four focused assertions
  failed before their fixes. After fixing them, **149 tests passed** across
  the policy, scheduler, and local reader suites, with typecheck/build/smoke
  also passing again. This post-review focused run is separate from the
  preceding full-run count; it is not claimed as another full-suite run.

Final targeted re-review: passed, with no remaining findings in the bounded
scope and an independent 149/149 focused verification. No installation, merge, push, or new
live model run is part of this code-repair pass.
