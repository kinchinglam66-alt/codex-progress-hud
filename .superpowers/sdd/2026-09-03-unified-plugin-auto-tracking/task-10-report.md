# Task 10 report

Date: 2026-09-04
Base commit: `45ba6e0ffcd346d0ac289ab59b9c944a6a2c0c7c`

## Outcome

- Wired the full Task 10 diagnostic dimensions into both production report callers: `src/desktop/lifecycle.ts` and `src/lifecycle/companion-manager.ts`.
- Added production-path coverage for task tracking, lease state, compatibility history, Hook state, and operational history.
- `observedState: "incompatible"` now reports the companion as online while retaining protocol incompatibility.
- Historical `compatibility.incompatibleClientSeen` is surfaced even when the current client is compatible.
- Hook conclusions distinguish hooks not expected/disabled from expected but untrusted/no activity.
- Operational history is bounded to 20 entries and contains only allowlisted event codes plus canonical timestamps.
- Diagnostic serialization excludes tokens, session IDs, handles, titles, prompts, source paths, Hook payloads, and raw identifiers.
- Corrected README and threat-model restart/control wording, including `hud_hide` window visibility and non-persistent immediate `hud_close` shutdown.

## TDD and verification evidence

- RED: `npx vitest --run tests/diagnostics/report.test.ts tests/desktop/lifecycle.test.ts tests/lifecycle/companion-manager.test.ts --reporter=verbose` produced the expected 3 behavioral failures before implementation.
- GREEN focused run: `npx vitest --run tests/diagnostics/report.test.ts tests/desktop/lifecycle.test.ts tests/lifecycle/companion-manager.test.ts --reporter=dot --maxWorkers=1 --no-file-parallelism`; 135 behavioral tests passed. One existing Windows temporary-directory teardown race reported `ENOTEMPTY`; no test assertion failed.
- Full serialized suite: `npm test -- --run --maxWorkers=1 --no-file-parallelism`; 30 files, 528 tests passed.
- Typecheck: `npm run typecheck`; passed.
- Build: `npm run build`; passed.
- Plugin validation: `npm run validate:plugin`; passed.
- Diff check: `git diff --check`; passed.
- No installation, packaging, network, merge, or push performed.

## Intentional changed files

- `.superpowers/sdd/2026-09-03-unified-plugin-auto-tracking/task-10-report.md`
- `README.md`
- `docs/THREAT_MODEL.md`
- `src/desktop/lifecycle.ts`
- `src/diagnostics/report.ts`
- `src/lifecycle/companion-manager.ts`
- `src/mcp/report-client.ts`
- `tests/desktop/lifecycle.test.ts`
- `tests/diagnostics/report.test.ts`
- `tests/lifecycle/companion-manager.test.ts`

`task-9-review.md` was not modified or staged.

## Final bounded correction

A fix re-review found that production still inferred Hook trust from the selected task's generic runtime evidence. The final correction records Hook receipt once at the HTTP boundary, exposes only `{activitySeen, lastEventAt}` in aggregate/status diagnostics, and uses that global state in both desktop and MCP diagnostic paths. A non-selected task's Hook can therefore establish global activity, while an expected Hook with no observed event is reported as “trust not confirmed” rather than falsely “untrusted.” `PRIVACY.md` now matches the README and threat model for existing-conversation late attachment, `hud_hide`, and non-persistent `hud_close` behavior.

Focused verification after this correction: 5 files and 208 tests passed, including the HTTP boundary, report client, both production callers, and report formatter. The first focused run exposed only the known Windows `ENOTEMPTY` teardown race; an unchanged isolated desktop rerun passed 47/47. Fresh final checks passed: serialized full suite 30 files/529 tests, typecheck, build, plugin validation, and `git diff --check`.

## Compatibility and privacy notes

The report API keeps the Task 10 dimensions optional for existing callers. Both production callers populate them. History is constructed and serialized as the fixed `{code, at}` shape only; no caller-provided identifiers or payloads are retained.
