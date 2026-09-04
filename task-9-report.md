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
