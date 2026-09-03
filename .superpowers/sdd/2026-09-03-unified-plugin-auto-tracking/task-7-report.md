## Task 7 implementation report

### RED (before production changes)

Command:

```text
npx vitest --run tests/mcp/tools.test.ts tests/mcp/stdio-server.test.ts --reporter=verbose
```

Result: expected failure, 2 files failed, 6 tests failed, 32 tests passed.

Observed missing behavior:

- `taskHandleSchema` was not exported and `progressReportSchema` still required caller-invented `task_id`.
- Semantic reports with `task_handle` were rejected and controls still queried/guessed the selected task.
- `validationObserved` was not exposed.
- stdio tool inventory did not include `validation_observed` and descriptions/schema did not expose the new contract.
- Missing control association was reported as `INTERNAL_ERROR` instead of `NO_SESSION_ASSOCIATION`.

### Implementation and verification

The MCP semantic write contract now uses `task_handle` matching
`^hud_[A-Za-z0-9_-]{20,96}$`. Reports and controls submit directly to that
handle; they never query the selected or most-recent task as a fallback.
Titles are optional for reports and use the safe generic `Codex task` title
until a bounded title is supplied. `validation_observed` is a separate bounded
tool and emits the existing validation evidence event. The reducer remains the
authority that downgrades verified-only legacy outcomes and preserves runtime
failure/interruption precedence.

Per-task start/pause/resume/stop controls carry the supplied handle, are
idempotent at the reducer boundary, and do not control Codex execution.
Missing control handles return `NO_SESSION_ASSOCIATION` without a status lookup
or companion launch. `tracking_status` remains observational. `hud_open` and
`hud_close` remain callable for this release but are marked deprecated; the
default plugin prompts no longer ask users to start tracking manually.

Exact verification results:

```text
npx vitest --run tests/mcp/tools.test.ts tests/mcp/stdio-server.test.ts --reporter=verbose
  2 files, 40 tests passed

npx vitest --run tests/integration/companion-lifecycle.test.ts --reporter=verbose
  1 file, 12 tests passed

npm run typecheck
  passed
npm run build
  passed
npm run validate:plugin
  passed
npm test -- --run
  25 files, 471 tests passed
git diff --check
  passed
```

Changed files:

- `.codex-plugin/plugin.json`
- `skills/progress-reporting/SKILL.md`
- `src/mcp/tools.ts`
- `src/mcp/main.ts`
- `src/mcp/report-client.ts` (typed structured revision errors)
- `src/lifecycle/companion-manager.ts` (maps revision errors at lifecycle boundary)
- `tests/mcp/tools.test.ts`
- `tests/mcp/stdio-server.test.ts`
- `tests/integration/companion-lifecycle.test.ts` (migrated integration callers to opaque handles)

Task 7 implementation commit: `d743bdc` (`feat: bind reports to hook task handles`).

## Fix round 1

### RED

Command:

```text
npm test -- --run tests/server/http-server.test.ts tests/mcp/tools.test.ts
```

Result: expected failure, 2 files failed, 5 tests failed, 73 tests passed.

The HTTP/store regression demonstrated that an unknown control handle was
accepted as a new task, changing revision and selection. The title regressions
also demonstrated that controls, validation observations, and semantic reports
without a title injected `Codex task`, overwriting an established title.

### Ruling and implementation

Opaque task handles are correlation keys in Task 7, not authorization
capabilities. Task 8 must bind each handle to an MCP lease/owner capability
before the product claims strong cross-session or cross-task authorization.
No lease or owner mechanism was added in this fix round.

The `/api/events` boundary now rejects pause, resume, and stop for an unknown or
expired handle with HTTP 404 and structured code `TASK_NOT_FOUND`. The existence
check is observational and occurs before `TaskStore.apply`, so rejection cannot
create a task, increment the revision, or alter selection. `tracking_start`
retains its explicit create/restart behavior.

Progress envelope titles are backward-compatibly optional. TaskStore preserves
the established title when a control or semantic report omits it; a supplied
title still passes the existing non-empty 160-character bound and replaces the
stored title. New title-less tasks retain the safe `Codex task` fallback.

### GREEN and release verification

```text
npm test -- --run tests/mcp/tools.test.ts tests/mcp/stdio-server.test.ts tests/server/http-server.test.ts
  3 files, 79 tests passed

npm run typecheck
  passed
npm run build
  passed
npm run validate:plugin
  passed (manifest and MCP launch configuration valid)
npm test -- --run
  25 files, 475 tests passed
git diff --check
  passed
```

Fix-round changed files:

- `src/core/schema.ts`
- `src/server/task-store.ts`
- `src/server/http-server.ts`
- `src/mcp/report-client.ts`
- `src/mcp/tools.ts`
- `src/lifecycle/companion-manager.ts`
- `tests/server/http-server.test.ts`
- `tests/mcp/tools.test.ts`
- `.superpowers/sdd/2026-09-03-unified-plugin-auto-tracking/task-7-report.md`
