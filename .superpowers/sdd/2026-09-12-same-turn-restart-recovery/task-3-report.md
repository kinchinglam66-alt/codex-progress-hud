# Task 3 — lifecycle sidecar report

## Scope

Implemented only the lifecycle/diagnostics sidecar in the restart-recovery worktree.

Committed files:

- `src/lifecycle/startup-claim.ts`
- `src/lifecycle/companion-manager.ts`
- `src/lifecycle/process-launcher.ts`
- `src/diagnostics/logger.ts`
- `tests/lifecycle/startup-claim.test.ts`
- `tests/lifecycle/companion-manager.test.ts`
- `tests/diagnostics/logger.test.ts`

Commit: `d371e33` (`fix: arbitrate companion startup across managers`)

`src/desktop/lifecycle.ts`, `src/server`, `src/desktop/observer-runtime.ts`, and accounting were not modified.

## Behavior

- Added a separate `.companion-startup-claim.json` sidecar keyed by the data directory and generation.
- Claim creation uses a trusted-directory check, restrictive temporary-file creation, atomic hard-link publication, owner nonce, and expiry bounded by the startup deadline.
- Competing managers perform authenticated identity/health re-probes and attach to the ready child instead of spawning a second child.
- Expired claims can be taken over only after the authenticated re-probe path; claim release is identity-fenced and bounded acquisition retries prevent churn loops.
- Claim reads are capped before parsing and use an opened handle, fixed 1,025-byte read buffer, and before/after file identity checks. The transient hard-link nlink-2 publication window is accepted for normal attach.
- Startup logs now allowlist role, attempt UUID, generation, child PID, and bounded child outcome fields. Manager startup records correlate request/ready entries and distinguish spawned vs attached.
- The real process launcher records `running`, `termination_requested`, `terminated`, `exited`, or `unknown` from its own child events. A `kill()` exception remains observable to the caller and marks the outcome unknown; no executable-name lookup is used.

## TDD evidence

RED reproductions:

- Missing startup-claim module: Vitest failed to import `src/lifecycle/startup-claim.js`.
- Two-manager reproduction: expected one spawn, received two.
- Launcher exit probe: expected `running`, received `undefined`.
- Claim safety checks were added as focused oversized-file and transient nlink-2 tests.

Final focused GREEN command:

```text
npm test -- --run tests/lifecycle/startup-claim.test.ts tests/lifecycle/companion-manager.test.ts tests/diagnostics/logger.test.ts tests/diagnostics/output-races.test.ts --maxWorkers=1 --no-file-parallelism
Test Files  4 passed (4)
Tests       100 passed (100)
```

Final typecheck command:

```text
npm run typecheck -- --pretty false
exit code 0
```

No full-suite or live process/settings/model action was performed by this task. The final launcher safety change landed after the controller’s milestone build, so rebuild/manifest verification must be refreshed.

## Remaining uncertainty and concerns

- The native exception/cause of the original 03:06 exit remains unknown; startup arbitration and evidence correlation do not establish a crash cause.
- Desktop lifecycle event linkage remains controller-owned; desktop producer changes were intentionally not made here.
- A `startup_ready` event remains evidence of readiness/role/attempt, not proof by itself that two processes existed.
- The sidecar prevents the reproduced cross-manager spawn race; installed-runtime and real-window validation remain outside this task.
