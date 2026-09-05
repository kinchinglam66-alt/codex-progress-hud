# Terminal restart fix report

## Scope

Implemented the live acceptance fix in MCP task association/handlers and MCP
tests. The controller-owned `scripts/smoke-packaged.mjs` change and
`docs/ACCEPTANCE-2026-09-05.md` were preserved and were not staged. No
subagents, installs, pushes, merges, or live installed-runtime calls were
performed.

## Design

- The MCP process keeps one mutable current fallback handle.
- Only an explicit handle-free `tracking_start` can rotate it, and only when
  the current write response reports one of the five terminal reducer states:
  `ended_unknown`, `completed_unverified`, `succeeded_verified`, `failed`, or
  `interrupted`.
- A replacement handle is generated once per logical start operation. If the
  write manager retries after an offline failure, the same candidate and the
  same `makeRequestOptions`/absolute deadline are reused.
- The replacement becomes current only after the complete `executeWrite`
  succeeds. Lifecycle errors, request failures, and manual suppression leave
  the old association current.
- Concurrent handle-free starts serialize, so they share one replacement task.
  Handle-free writes that already captured the old handle retain it; writes
  arriving behind an in-flight start wait for the new association. No selected,
  latest, or status lookup is used for targeting, and explicit handles remain
  unchanged.

## TDD evidence

- RED: terminal restart regression expected three writes and observed two.
- GREEN: terminal fallback rotation test passed for all five terminal states.
- GREEN: concurrent start, same-candidate retry, no progress rollover, failed
  replacement, suppressed start, and delayed-write non-retargeting tests passed.
- RED: protocol mismatch wording assertion rejected the stale `Hook-enabled`
  guidance.
- GREEN: mismatch guidance now refers to Progress HUD tracking without making
  Hooks a prerequisite.

## Changed files

- `src/mcp/tools.ts`
- `tests/mcp/tools.test.ts`
- `tests/mcp/stdio-server.test.ts`
- `README.md`
- `skills/progress-reporting/SKILL.md`
- generated mirror: `plugins/codex-progress-hud/README.md` and
  `plugins/codex-progress-hud/skills/progress-reporting/SKILL.md`
- this report

## Verification

- `npm run build` — passed.
- Focused MCP suite — passed: 5 files, 119 tests.
- `npm run typecheck` — passed.
- `npm run check:plugin-sync` — passed: release plugin synchronized.
- `git diff --check` — passed.
- Source stdio acceptance now completes verified work, performs a second
  handle-free start/report, and confirms two records: immutable old
  `succeeded_verified` history plus fresh running progress/evidence state.
- Full suite and packaged smoke were intentionally left to the controller’s
  final gate. The controller reported the old packaged smoke’s singleton
  interference separately; no singleton/runtime scope was expanded here.

## Commit

`d51fd59` (`fix: restart terminal MCP fallback tasks`).
