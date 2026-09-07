# Connection-owned lifetime implementation plan

> **For agentic workers:** Use executing-plans for inline execution of this approved, bounded lifecycle repair.

**Goal:** Keep the companion alive for initialized plugin connections without model progress calls.

**Architecture:** The MCP initialized notification starts the existing lease lifecycle, without a task binding. A bounded connection supervisor retries failed acquisition while connected. Renewal loss clears only the matching lease so the connected supervisor can recover. Closing stops the supervisor and releases the lease. Hooks deliver to an existing companion and cannot spawn it.

**Tech Stack:** TypeScript, MCP SDK, Node timers, Vitest, Electron.

**Spec:** User-approved connection-owned lifetime design in this conversation, 2026-09-05.

**Execution status:** Connection ownership and connected-only Hook delivery implemented; focused red/green tests, full 689-test suite, compilation, bounded review, Windows build and all three packaged acceptance entry points passed. See `../reports/2026-09-05-connection-owned-lifetime-acceptance.md` for exact evidence, the additional rendering-readiness race repair, and installed-host limitations. Installation and current-conversation association acceptance remain pending; checklist below preserves the original planned scope.

## Constraints

- No model calls, fabricated tasks, credential changes, or Hook trust changes.
- Preserve explicit off state, generation checks, fail-open Hook JSON and bounded diagnostics.
- Preserve final-owner expiry/grace cleanup; do not disable cleanup globally.
- Initialization acknowledgment and tools/list must not wait for companion startup.
- No installed cache edits or automatic replacement of live MCP executables.

## Task 1: Connection ownership

Files: src/mcp/main.ts, src/mcp/connection-owner.ts,
src/mcp/lease-lifecycle.ts, tests/mcp/connection-owner.test.ts,
tests/mcp/lease-lifecycle.test.ts, tests/mcp/stdio-server.test.ts.

- [x] Add failing tests: initialized stdio acquires one lease before any task tool, store remains empty; supervisor retries acquisition, ignores duplicate start, stops timers and stops lifecycle; failed renewal invalidates only its own generation.
- [x] Run focused Vitest and confirm assertions fail against the old behavior.
- [x] Implement supervisor with `start(): void` and `stop(): Promise<void>` over McpLeaseLifecycle; retry every 10000 ms, at most one in-flight start.
- [x] Wire `server.server.oninitialized = () => owner.start()` and transport closure to `owner.stop()` with bounded error handling. Keep existing lease coordinator for task writes.
- [x] On renewal failure clear matching lease/client association; do not automatically acquire from the renewal callback.
- [x] Run focused tests and compilation; run the real stdio integration against rebuilt dist.

## Task 2: Hook delivery without process ownership

Files: src/hooks/client.ts, tests/hooks/main.test.ts.

- [x] Test the connected-client boundary for offline delivery with no launcher dependency; production defaults use this boundary.
- [x] Replace default Hook manager startup with reading settings and invoking existing guarded HTTP delivery. Return suppressed on desiredState off; forward signal, timeout and current generation. The HTTP server remains authoritative for generation races.
- [x] Retain the generic createHookClient boundary and its failure classifications; test delivery and disabled/offline behavior.

## Task 3: Acceptance

- [x] Run full suite, type check, build and one bounded review.
- [x] Build installer and run both packaged smoke entry points. Confirm initialization alone owns a lease without creating tasks, connection survives the Hook grace interval, and final disconnect still cleans up.
- [ ] Record exact tests and distinguish packaged tests from installed Desktop acceptance. Retain rollback materials. Commit only scoped files; leave unrelated existing documentation edits intact.
