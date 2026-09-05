# Task 6 report: documentation alignment

## Scope

Updated the public product contract and generated plugin mirror in the
`mcp-lease-fallback` worktree. Production runtime and ETA algorithms were not
changed. No subagents, installs, pushes, merges, or publishes were used.

The contract now states that task-scoped calls use a supplied valid opaque
`task_handle` only when Codex provides one; otherwise the call omits the field
and uses the authenticated MCP-process lease fallback. Handles are never
invented, inferred, persisted, or disclosed. The fallback is process-memory
only, content-free, random, and not telemetry.

The documentation also distinguishes plugin enablement, companion running, and
model-reported task tracking; makes Hooks optional best-effort compatibility;
keeps `tracking_start` as supported explicit start/restart; preserves
observational status semantics; documents restart/no-backfill behavior and the
inability to distinguish conversations sharing one MCP process; preserves the
bounded privacy promises; removes automatic promises from default prompts; and
keeps version 0.2.1.

## Changed paths

- `.codex-plugin/plugin.json`
- `README.md`
- `PRIVACY.md`
- `docs/INSTALL-WINDOWS.md`
- `docs/KNOWN-SIDE-EFFECTS.md`
- `docs/THREAT_MODEL.md`
- `docs/RELEASE-CHECKLIST.md`
- `skills/progress-reporting/SKILL.md`
- `tests/packaging/release-contract.test.ts`
- Generated mirror: `plugins/codex-progress-hud/.codex-plugin/plugin.json`,
  `plugins/codex-progress-hud/README.md`,
  `plugins/codex-progress-hud/PRIVACY.md`, and
  `plugins/codex-progress-hud/skills/progress-reporting/SKILL.md`

## Checks and evidence

- `npm run sync:plugin` — passed; launcher was already current and the release
  plugin was synchronized.
- `npm run check:plugin-sync` — passed: `Release plugin is synchronized.`
- `npm run validate:plugin` — passed: manifest, Hooks, marketplace, and MCP
  launch configurations are valid.
- `npx vitest run tests/packaging/release-contract.test.ts` — passed: 1 test
  file, 7 tests.
- `git diff --check` — passed.
- Manual scoped review — no stale 0.2.0 product labels, mandatory-Hook
  wording, or deprecated `tracking_start` wording remain in the edited public
  contract. The remaining `automatic` matches are negative assertions or
  explicit statements rejecting automatic-tracking promises.
- Existing installed-plugin acceptance supplied by the controller/conversation:
  handle-free `tracking_start` and `progress_report` succeeded with
  `associationSource=mcp_lease`; the companion was running at 0.2.1.

## Concern / pending runtime issue

The latest acceptance also found that after `task_outcome` reaches completed
and verified, a subsequent `tracking_start` plus `progress_report` can return
success while the snapshot remains `succeeded_verified`. The reducer protects
terminal states. This is intentionally not changed in Task 6: the controller
will implement a fresh fallback task on an explicit start after terminal while
preserving the old snapshot. Documentation avoids promising that completed
tasks restart in place today.
