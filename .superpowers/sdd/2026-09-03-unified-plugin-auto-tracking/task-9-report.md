# Task 9 report

Implemented the compact concurrent-task HUD presentation and controls.

## TDD record

- RED: focused UI/desktop tests failed 7 assertions because the new view fields, per-task window behavior, and tray actions were absent.
- GREEN: focused tests pass after the minimal implementation.

## Changes

- Added aggregate task items, selected task, compatibility banner, late-attachment label, ETA confidence, and explicit text statuses to the view model.
- Added compact task switcher, follow-activity control, compatibility/origin/confidence text, and revision-aware stale refresh/retry to the renderer.
- Added per-task hide/selection state to the window controller; same-task activity stays hidden, new-task activity may show once, and terminal activity never shows the window.
- Added tray follow-activity, task selection, dynamic task refresh, show/hide, diagnostics, and exit; no companion start/stop or second plugin switch.
- Wired desktop tray refresh and selection through authenticated, generation- and revision-bearing requests.

## Verification

- Focused UI/desktop: 35/35 passed.
- Typecheck: passed.
- Production build: passed.
- Plugin validation: passed.
- Full suite: 28 files, 509/509 tests passed.
- `git diff --check`: passed.

## Scope and remaining risks

Task 10 diagnostics prose and Task 11 packaging were not changed. Window show policy remains event-driven by the existing lifecycle/server flow; terminal notifications do not request focus.
