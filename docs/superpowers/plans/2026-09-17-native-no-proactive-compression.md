# Native foreground latency implementation plan

> **For agentic workers:** Use superpowers:executing-plans. The user approved direct implementation in the current task.

**Goal:** Remove repeated foreground history compression and silent legacy fallback, and bound accepted ETA work to 30 seconds.

**Architecture:** Completed-turn native inheritance supplies prior context; the complete current-turn delta is appended. Runtime capacity handling remains available, but the plugin does not initiate compaction based on a byte/token approximation. A scheduler deadline rejects late output while retaining ownership until cleanup and accounting finish.

**Tech Stack:** TypeScript, Vitest, Windows Codex app-server.

**Spec:** User-approved 2026-09-17 design in this task; this prospective absolute-latency requirement does not rewrite the failed Series31 relative-performance result.

## Constraints

- No truncated source presented as complete; preserve request-size and local source-size safety bounds, authentication, custody and accounting.
- No silent full-history fallback when a native pair is unavailable.
- Runtime automatic compaction is distinct from plugin-initiated `thread/compact/start`.
- Timeout is not successful ETA. Retain unknown usage honestly; no automatic paid retry in experiments.
- Installed build remains untouched in this implementation/test milestone.

## Tasks

- [x] Session/worker: add native runtime-managed capacity mode. Test importing more than the conservative reserve without invoking a compaction callback; preserve complete records and report resident size unverified.
- [x] Scheduler: replace native fallback with explicit failure. Test unavailable/unsupported native pairs never import history or run a model.
- [x] Deadline: abort accepted work after 30 seconds across preparation/inference, show timeout immediately, retain in-flight cleanup ownership and reject late answers. Tests use controlled time and delayed preparation/inference.
- [x] Trigger timing: remove fixed first delay and initial coalescing. Source readiness itself is not a remote-service SLA; cooldown and later event coalescing remain deliberate eligibility policy.
- [x] Run focused regression, build and review; register and complete Series32 synthetic initial/same/new-turn tests. Three valid returns below30seconds; no proactive/automatic compaction, unknown usage or cleanup failure.
- [x] Fresh uninterrupted full regression70833/2b3c2a:260 files /3249 tests passed,506.74s. Report updated; no merge/push/install performed.

## Verification commands

`D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/observer-persistent-session.test.ts tests/estimation/full-context-scheduler.test.ts tests/estimation/observer-scheduler.test.ts --maxWorkers=1 --no-file-parallelism`

`D:/npm.ps1 run build`

Full suite after the focused milestone. Do not commit unrelated preexisting work or install without a separate release step.
