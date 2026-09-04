# Task 9 fix evidence

## Scope

Implemented the single requested fix round in the shared worktree. The only
scope extension is the minimal authenticated `GET /api/bootstrap` contract in
`src/server/http-server.ts`, plus the two focused UI helper modules needed to
test and reuse renderer mutation/accessibility behavior. No companion controls,
second plugin switch, or Task 8 security/lease lifecycle behavior was changed.

## Regressions added before production changes

- Renderer selection, follow-activity, and visibility mutations require the
  protocol, generation, and current revision headers.
- Renderer mutation intents serialize; stale responses cannot overwrite the
  newest intent; only `STALE_REVISION` triggers one fresh-snapshot retry.
- Renderer task buttons expose `aria-pressed` and selected-state text.
- Window X-hide delegates the selected task to the server-backed visibility
  mutation handler and hidden state is supplied by the server snapshot.
- Desktop lifecycle wires changed task activity to the window controller and
  projects aggregate `selectedTaskId` into exactly one checked tray entry.
- The authenticated bootstrap returns the current protocol and generation.

The initial focused RED run failed in the expected missing-contract paths:
the new helper modules were absent, bootstrap returned 404, lifecycle activity
was not wired, and X-hide did not invoke its handler.

## Fix evidence

- Focused GREEN: `npx vitest run tests/ui/task-mutations.test.ts tests/ui/task-controls.test.ts tests/server/http-server.test.ts tests/server/lease-http.test.ts tests/desktop/window-controller.test.ts tests/desktop/tray-controller.test.ts tests/desktop/lifecycle.test.ts --reporter=dot`
  - 7 files passed, 124 tests passed.
- Typecheck: `npm run typecheck` passed.
- Build: `npm run build` passed.
- Plugin validation: `npm run validate:plugin` passed.
- Serialized full suite: `npm test -- --run --reporter=dot`
  - 30 files passed, 517 tests passed.
- Diff check: `git diff --check` passed.

## Review notes

Renderer mutations now use an authenticated server bootstrap, a serialized
intent queue, monotonic snapshot acceptance, and stale-only refresh/retry.
Lifecycle activity is compared against the prior aggregate snapshot before the
window selection is synchronized, preserving different-new-task show-once and
terminal no-focus behavior. Hide state is server-owned and is re-applied from
snapshots after SSE updates or window recreation. Tray entries are projected
from `selectedTaskId` and tasks, and task buttons expose non-color selection
state.

## Second bounded fix round

### Remaining findings addressed

- The production static allowlist now serves the complete compiled renderer
  graph: `renderer.js`, `view-model.js`, `task-mutations.js`, and
  `task-controls.js`, all with the exact JavaScript content type. Source maps,
  declarations, unknown files, and traversal targets remain outside the
  allowlist.
- Tray selection, follow activity, and X-hide now share the same serialized
  intent/revision controller as renderer mutations. The desktop adapter adds
  bearer authentication while preserving protocol, generation, and revision
  headers. Only `STALE_REVISION` triggers one authenticated snapshot refresh
  before retry.
- Lifecycle synchronizes the selected task and its server-owned
  `hiddenForTask` value before creating the BrowserWindow and after every store
  change. `ready-to-show` therefore keeps a hidden current task hidden, while a
  different eligible new task may show once and terminal tasks do not focus the
  window.

### TDD evidence

All second-round regressions were added before production edits. The focused
RED run had five expected failures: renderer dependency modules returned 404,
three desktop mutations started concurrently, desktop stale handling skipped
the snapshot refresh, selected visibility was synchronized after window
creation without hidden state, and a recreated hidden-current window showed.

Focused GREEN command:

`npx vitest run tests/server/http-server.test.ts tests/desktop/lifecycle.test.ts tests/desktop/window-controller.test.ts --reporter=dot`

- 3 files passed, 103 tests passed.

Related Task 9 and Task 8 regression command:

`npx vitest run tests/ui/task-mutations.test.ts tests/ui/task-controls.test.ts tests/ui/view-model.test.ts tests/desktop/window-controller.test.ts tests/desktop/tray-controller.test.ts tests/desktop/lifecycle.test.ts tests/server/http-server.test.ts tests/server/lease-http.test.ts tests/server/lease-store.test.ts tests/integration/companion-lifecycle.test.ts tests/lifecycle/companion-manager.test.ts tests/lifecycle/state-store.test.ts tests/mcp/lease-lifecycle.test.ts --reporter=dot`

- Clean rerun: 13 files passed, 272 tests passed.
- The first run encountered only the previously documented Windows temporary
  directory cleanup race (`ENOTEMPTY`); the behavioral tests passed and the
  clean rerun completed without it.

### Final verification

- `npm run typecheck` passed.
- `npm run build` passed and emitted all four renderer modules under `dist/ui`.
- A live HTTP check against the built `dist/ui` loaded the complete renderer
  module graph with exact JavaScript MIME types and rejected maps and traversal
  targets.
- `npm run validate:plugin` passed.
- Serialized full suite:
  `npm test -- --run --reporter=dot --maxWorkers=1 --no-file-parallelism`
  passed 30 files and 522 tests.
- One intervening serialized rerun hit the same cleanup-only `ENOTEMPTY`
  race; the affected test passed in isolation and the final exact serialized
  rerun passed all 522 tests.
- `git diff --check` passed before final staging.

No install, merge, push, Task 10 work, companion control, second switch, or
Task 8 security/lifecycle expansion was performed.
