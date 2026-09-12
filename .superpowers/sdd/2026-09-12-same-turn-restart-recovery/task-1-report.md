# Task 1 report: bounded checkpoint repository

## Scope

Implemented the storage-only sidecar in the `restart-recovery` worktree. The
persisted file is `goal-checkpoint.json`. No PassiveGoals, HTTP-server, ledger,
runtime, installation, or controller-owned files were edited.

## Red/green evidence

Initial TDD red run, before the production module existed:

```text
npm test -- --run tests/server/goal-checkpoint.test.ts --maxWorkers=1
FAIL  tests/server/goal-checkpoint.test.ts
Error: Cannot find module '../../src/server/goal-checkpoint.js'
Tests: 0
```

Focused green run:

```text
npm test -- --run tests/server/goal-checkpoint.test.ts --maxWorkers=1
Test Files  1 passed (1)
Tests       10 passed (10)
```

Typecheck green run:

```text
npm run typecheck
Process exited successfully after generate:capabilities and tsc --noEmit
```

One intermediate typecheck reported the concurrent controller error below;
the later standalone typecheck passed after that concurrent work advanced:

```text
tests/server/http-server-recovery.test.ts(16,5): error TS2353:
Object literal may only specify known properties, and
'isGoalCheckpointOwner' does not exist in type 'ProgressServerOptions'.
```

The full suite was intentionally not rerun, per the task instruction. The
initial baseline had dependency-missing failures before the node_modules
junction/build became available.

## Changed paths

- `src/server/goal-checkpoint.ts`
- `tests/server/goal-checkpoint.test.ts`
- `.superpowers/sdd/2026-09-12-same-turn-restart-recovery/task-1-report.md`

The implementation validates exact versioned fields and bounded numeric values,
filters expired records, rejects future/duplicate/terminal records, enforces
source identity, reads at most 1 MiB before parsing, snapshots and serializes
saves in invocation order, and uses unique restrictive temp files with flush,
ownership, directory/target identity, regular-file, and atomic-replace checks.
Failed writes clean only the temp file they created and preserve the prior
target.

## Concerns / remaining verification

- Full-suite and server integration verification belong to the controller’s
  later milestone and were not run here.
- The symlink test skips only when the host denies creating symlinks; direct
  links are rejected when the filesystem permits the test fixture.
- No live runtime, model call, installation, benchmark, push, or ledger change
  was performed.

Commit: final Task 1 commit containing this report; the exact hash is reported
with the handoff.
