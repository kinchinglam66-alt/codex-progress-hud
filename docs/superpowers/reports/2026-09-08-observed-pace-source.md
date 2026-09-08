# Verified observed pace — implementation evidence

Status: verified source integrated into the main working directory for the
user-authorized commit and push. Not installed or promoted to live ETA.

## Main integration verification (2026-09-09)

- The exact commit snapshot was checked out through a separate Git index based on
  main at `0f4e4ec`, with only the 30 scoped source/test changes applied.
- Existing countdown-expiry hunks in four overlapping files were excluded from
  that index and retained in the main working directory. Other uncommitted
  diagnostic changes and private documents are not part of this integration.
- Snapshot typecheck and build passed, followed by **1,589/1,589 tests passed**,
  132 files, exit 0, 297.91 seconds; started at 01:05:31 Asia/Hong_Kong.
- This count is lower than the isolated source's 1,605 because the separate
  countdown-expiry changes are not included in the commit snapshot.
- The integrated working-directory copies of all 30 files matched the reviewed
  frozen hashes, including the preserved pre-existing expiry hunks.
- No installation, live ETA promotion, or real-task accuracy claim is included.

## Final outcome (2026-09-09)

- Frozen full suite: **1,605/1,605 tests passed**, 132 files, exit 0,
  310.46 seconds, started at 00:27:37 Asia/Hong_Kong.
- Typecheck and build both passed before that run.
- All 30 scoped source/test file hashes matched the frozen snapshot.
- One final architectural review found two functional gaps plus the stale version
  test. One bounded fix wave resolved all three. One scoped Sol-medium re-review
  accepted the fixes with no new fix-induced findings.
- The fixes require file-level passed/empty-message evidence, preserve eligible
  measurement-bearing rows in the offline scorer, and align the facts-v2 test.
- The controller-owned local test commands did not launch estimator inference.
  Development/review subagents are separate model usage.

Final verification commands (all exit 0):

```text
npm run typecheck
npm run build
npm test -- --run --maxWorkers=1 --no-file-parallelism
```

Implementation directory:
`C:/Users/asus/Documents/Codex/2026-09-01/z/.hud-reinstall-1a3aa3f-isolated`.
The exact 30-path handoff list and review evidence are retained in the main
repository's ignored `.superpowers/sdd/2026-09-08-observed-pace-source/` directory.
Integration started from main at `0f4e4ec`; its pre-existing diagnostic/countdown
edits were preserved. The user authorized main integration and push; installation
remains a separate operation.

One non-functional formatting item remains: a trailing space at
`src/estimation/assets/observer-instructions.md:70`. The prompt's verified/pinned
bytes were retained rather than changed solely for formatting. The scoped
whitespace check therefore is not reported as fully clean.

## Execution decisions and tradeoffs

1. Reused the existing isolated source instead of creating another Git worktree;
   this preserves existing edits but leaves a separate integration step.
2. Followed the user's review cap: controller task checks, one final review and one
   scoped re-review; task-level defects can consequently be detected later.
3. Bash helper was unavailable, so plan-scoped artifacts were created with
   apply_patch using the same naming and ledger identity; recovery artifacts remain
   local instead of commit-derived.
4. Did not pool different host invocations; stronger comparability reduces sample
   availability.
5. Moved production goal/source wiring from Task 2 to Task 3 so one task owned
   lifecycle identity; the pure owner was not usable until that next slice landed.
6. Retained the pinned prompt whitespace; a later formatting cleanup must also
   refresh its source pin.

## First frozen full regression (2026-09-09)

Typecheck and build passed. Full serial suite completed in 295.63 seconds:
1,600 passed, 1 failed, 132 test files, exit 1. The failure is
`tests/estimation/observer-identity-runtime.test.ts:56`, which expects the old
`observer-input-facts-v1` provenance label instead of the intentionally introduced
v2. This run was not a full pass. At that checkpoint, final review and the bounded
fix wave were still open; the final outcome above records their resolution.

## Scope

Connect locally verified serial Vitest JSON file measurements to shadow predictions.
No additional estimator inference calls, main-agent reports, consent changes or
live countdown/progress changes. Model remaining units remain a hypothesis.

## Local characterization

Installed Vitest 4.1.11 was invoked with `--reporter=json --maxWorkers=1
--no-file-parallelism` on three existing tests. Exit 0; each file passed; timestamps
were positive, inside the host window, mutually non-overlapping and included
fractional milliseconds. File report order was not chronological.

The host invocation took 793 ms, while the three file durations were approximately
4.17, 3.19 and 3.32 ms. These timings do not represent process startup, collection,
inter-file overhead or the whole coding task. No accuracy conclusion follows.

## Adapter verification

After Task 1, 35 focused reader/adapter tests passed in an independent controller
rerun. Build passed. The built adapter also admitted a fresh real local three-file
Vitest JSON report (3 files, process exit 0). No estimator inference was used by
these local test commands. Development subagents are separate model usage. This
proves supported format admission, not end-to-end goal integration or accuracy.

Vitest reported 5 total/passed suites for those 3 files and 45 tests, confirming
that suite counts and file counts must not be equated.

## Measurement owner verification

Task 2 owner, adapter and existing correction tests passed together: 3 files,
38 tests, exit 0. The owner exposes a pure record bridge and requires explicit
complete-history, source-epoch and uninterrupted host-window evidence. It does
not yet provide production lifecycle wiring by itself. Controller independently
ran the combination; implementer also reported a clean TypeScript check.

## Pre-change baseline

Before this implementation, focused local-reader and pace-correction tests passed:
2 files, 29 tests, exit 0. This is baseline evidence, not evidence for the new
adapter. The earlier countdown-expiry full regression is a separate change.

## Conservative admission decisions

Shadow-only means application code does not replace the model's raw estimate with
the corrected value. It does not guarantee that the model produces the same raw
answer after receiving additional pace summaries. Such input conditioning can
affect the model's own prediction; these records are not an unchanged-input
control experiment. A later accuracy study must account for that distinction.

- No pooling across distinct host invocations, even with identical command flags.
- No conversion between the host monotonic goal clock and wall-time log timestamps.
- Only complete actions after a verified observation continuity boundary can count.
- Unavailable provenance remains unavailable; text-only test summaries do not count.
- When the existing input is already near the byte ceiling, pace summaries are
  dropped first. Long dense conversations may therefore abstain even with locally
  valid measurements; no availability/coverage claim is made by unit-test success.

This report intentionally makes no real-task ETA accuracy claim. Real observation
coverage and accuracy need a separate bounded experiment; this implementation
supplies the verified shadow data path for that work.
