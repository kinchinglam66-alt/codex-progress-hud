# Unified Plugin Control and Automatic Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox markers so execution can resume safely after interruption.

**Goal:** Make Codex plugin enablement the sole global switch, automatically track Hook-enabled tasks, support concurrent and late-attached tasks, report truthful compatibility and completion states, and ship the plugin plus companion as one tested release unit.

**Architecture:** Keep the local authenticated loopback companion, but separate four concerns: version capabilities, per-task event reduction, session/lease coordination, and presentation. Codex command Hooks deliver content-free runtime evidence through a quiet `--hook-event` entry mode; MCP tools deliver semantic reports using a Hook-injected opaque task handle. A bounded multi-task store emits revisioned aggregate snapshots to HTTP/SSE and the desktop HUD. The companion lifetime follows renewable MCP leases, while window visibility and per-task tracking remain independent controls.

**Tech Stack:** TypeScript 7, Node.js 22, Electron 44, MCP SDK 1.30, Zod 4, Vitest 4, local HTTP/SSE, Codex plugin Hooks, Windows packaged executable.

**Spec:** `docs/superpowers/specs/2026-09-03-unified-plugin-auto-tracking-design.md`

**Related release plan:** `docs/superpowers/plans/2026-09-01-windows-release-packaging.md`. Its Tasks 1–7 remain the detailed Node-free Windows packaging procedure, but must be executed after Task 10 below and adapted so the same installed executable serves both `--mcp-stdio` and `--hook-event`.

**Global Constraints:**

- Do not edit Codex plugin settings, cache files, or private GUI/App Server state.
- Never persist or transmit prompt text, transcripts, tool arguments/output, source files, repository names, raw working directories, or model reasoning.
- Keep loopback binding, bearer authentication, bounded bodies/responses, deadlines, no-shell process launches, and existing lifecycle race protections.
- Treat plugin enable/disable as Codex-owned. The companion starts only when an enabled plugin Hook or current MCP mutation reaches it and shuts down only after all leases expire plus grace.
- Keep `hud_open` and `hud_close` for one compatibility release, but remove them from normal prompts and documentation. They do not become a second persistent switch.
- Preserve existing public behavior unless a task below explicitly migrates it. Every behavior change starts with a failing test.
- Use `apply_patch` for source edits. Commit after each task only after focused tests pass.
- Before implementation, create an isolated worktree with `superpowers:using-git-worktrees`; do not modify production code on `main`.

---

## File and responsibility map

| Area | Existing files | Planned additions |
|---|---|---|
| Shared identity | `package.json`, `.codex-plugin/plugin.json`, `src/lifecycle/types.ts` | `config/release-capabilities.json`, `src/generated/capabilities.ts`, `scripts/generate-capabilities.mjs` |
| Core state | `src/core/types.ts`, `schema.ts`, `reducer.ts`, `eta.ts` | `src/core/calibration.ts` |
| Task/session state | `src/server/task-store.ts` | `src/server/lease-store.ts`, `src/server/calibration-store.ts` |
| Local API | `src/server/http-server.ts`, `src/mcp/report-client.ts` | `src/hooks/schema.ts`, `src/hooks/adapter.ts`, `src/hooks/client.ts` |
| Plugin runtime | `src/main.ts`, `src/mcp/main.ts`, `src/mcp/tools.ts` | `src/hooks/main.ts`, `hooks/hooks.json`, `scripts/launch-hook.ps1` |
| Desktop lifecycle | `src/desktop/lifecycle.ts`, `src/lifecycle/companion-manager.ts` | no new subsystem |
| HUD UI | `src/ui/index.html`, `renderer.ts`, `styles.css`, `view-model.ts` | no new subsystem |
| Diagnostics/release | `src/diagnostics/*`, `scripts/copy-assets.mjs`, `scripts/validate-plugin.mjs`, `scripts/smoke-test.mjs` | `scripts/package-contract-test.mjs` |

---

### Task 1: Generate one release and protocol capability identity

**Files:**

- Create: `config/release-capabilities.json`
- Create: `scripts/generate-capabilities.mjs`
- Create: `src/generated/capabilities.ts`
- Modify: `package.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `scripts/validate-plugin.mjs`
- Test: `tests/release/capabilities.test.ts`

**Interfaces:**

```ts
export interface ReleaseCapabilities {
  product: "codex-progress-hud";
  buildVersion: string;
  protocol: { current: number; minimumClient: number; maximumClient: number };
  features: readonly string[];
}

export const RELEASE_CAPABILITIES: ReleaseCapabilities;
export function acceptsClientProtocol(protocol: number): boolean;
```

- [ ] Write a failing test that imports `RELEASE_CAPABILITIES`, checks a nonempty build version, checks that the current protocol lies inside the accepted range, and compares it with both package manifests.
- [ ] Run `npx vitest --run tests/release/capabilities.test.ts` and confirm failure because no generated module exists.
- [ ] Add `config/release-capabilities.json` as the sole authored source, implement the generator, and add `generate:capabilities` before `typecheck` and `build`.
- [ ] Make plugin validation fail when `package.json`, plugin version, generated version, or protocol range diverges. Do not rewrite manifests during validation.
- [ ] Run the focused test and `npm run validate:plugin`; confirm both pass.
- [ ] Commit with `git add config/release-capabilities.json scripts/generate-capabilities.mjs src/generated package.json .codex-plugin/plugin.json scripts/validate-plugin.mjs tests/release && git commit -m "build: unify release capability identity"`.

### Task 2: Negotiate protocol versions and expose truthful incompatibility

**Files:**

- Modify: `src/lifecycle/types.ts`
- Modify: `src/mcp/report-client.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/mcp/report-client.test.ts`
- Test: `tests/server/http-server.test.ts`
- Test: `tests/mcp/tools.test.ts`

**Interfaces:**

```ts
export interface HudCapabilities {
  service: "codex-progress-hud";
  companionVersion: string;
  protocol: { current: number; minimumClient: number; maximumClient: number };
  incompatibleClientSeen: boolean;
}

export interface HudRequestOptions {
  timeoutMs?: number;
  generation?: number;
  clientProtocol?: number;
  signal?: AbortSignal;
}

export type HudClientErrorCode =
  | "COMPANION_NOT_INSTALLED"
  | "OFFLINE"
  | "VERSION_MISMATCH"
  | "GENERATION_REJECTED"
  | "AUTH_ERROR"
  | "START_TIMEOUT"
  | "REQUEST_TIMEOUT"
  | "REQUEST_CANCELLED"
  | "PORT_CONFLICT"
  | "SHUTTING_DOWN";
```

- [ ] Add server tests for public minimal `/health`, authenticated `/api/health` capability range, missing/unsupported `x-codex-progress-hud-protocol`, and structured `VERSION_MISMATCH` versus `GENERATION_REJECTED` responses.
- [ ] Add client tests proving `ECONNREFUSED` maps to `OFFLINE`, incompatible authenticated health maps to `VERSION_MISMATCH`, and an HTTP protocol rejection is not collapsed to `INTERNAL_ERROR`.
- [ ] Add tool tests proving lifecycle errors preserve the exact structured code and produce upgrade/restart guidance for `VERSION_MISMATCH`.
- [ ] Run the three focused files and confirm the new assertions fail.
- [ ] Implement protocol headers on all mutations, parse bounded structured error bodies, record an incompatible-client flag in companion memory, and expose it through authenticated health/snapshot data.
- [ ] Change broad `catch` blocks in MCP handlers to preserve `HudClientError.code`; keep unknown failures as `INTERNAL_ERROR` only.
- [ ] Run focused tests, then `npm run typecheck`.
- [ ] Commit with `git commit -am "fix: report plugin companion incompatibility truthfully"`.

### Task 3: Model runtime evidence, quiescence, late attachment, and ETA uncertainty

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/reducer.ts`
- Modify: `src/core/eta.ts`
- Create: `src/core/calibration.ts`
- Test: `tests/core/reducer.test.ts`
- Test: `tests/core/eta.test.ts`
- Create: `tests/core/calibration.test.ts`

**Interfaces:**

```ts
export type TaskStatus =
  | "idle" | "running" | "quiescent" | "paused" | "stopped"
  | "waiting_approval" | "waiting_user" | "stalled_suspected"
  | "disconnected_suspected" | "ended_unknown"
  | "completed_unverified" | "succeeded_verified" | "failed" | "interrupted";

export type TrackingOrigin = "session_start" | "late_attach" | "manual";

export type RuntimeEvidence =
  | { type: "session_attached"; origin: TrackingOrigin }
  | { type: "turn_started"; turnId?: string }
  | { type: "activity_seen"; category: "tool" | "hook" }
  | { type: "turn_stopped" }
  | { type: "session_ended" }
  | { type: "lease_lost" };

export interface EtaEstimate {
  lowSeconds: number;
  highSeconds: number;
  confidence: number;
  confidenceClass: "low" | "medium" | "high";
  signals: readonly ("plan" | "model" | "calibration")[];
}
```

- [ ] Write reducer tests for `Stop -> quiescent`, `SessionEnd -> ended_unknown`, interruption/failure precedence, verified-only success, reconnect recovery, idempotent pause/resume/stop, and no active-time increase while quiescent/waiting/disconnected.
- [ ] Write ETA tests for late-attach widening, plan rewrite/validation-failure widening, confidence classes, and active-time-only behavior.
- [ ] Write calibration tests showing aggregation accepts only anonymous phase class, duration, estimate error, and outcome category; reject extra/title/path/prompt-like fields.
- [ ] Run focused tests and confirm failure.
- [ ] Extend task snapshots with `trackingOrigin`, `trackedFrom`, runtime timestamps, estimate volatility, and verification evidence. Keep old serialized progress events parseable during this release.
- [ ] Implement precedence in one pure reducer; do not duplicate terminal classification in Hooks, MCP handlers, or UI.
- [ ] Implement deterministic interval blending and a minimum-sample calibration lookup. If insufficient samples exist, omit the calibration signal rather than inventing a prior.
- [ ] Run core tests and `npm run typecheck`.
- [ ] Commit with `git add src/core tests/core && git commit -m "feat: model truthful task evidence and eta uncertainty"`.

### Task 4: Replace the single current task with a bounded multi-task store

**Files:**

- Modify: `src/server/task-store.ts`
- Create: `src/server/calibration-store.ts`
- Create: `tests/server/task-store.test.ts`
- Create: `tests/server/calibration-store.test.ts`

**Interfaces:**

```ts
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  lastActivityAt: number;
  hiddenForTask: boolean;
}

export interface HudAggregateSnapshot {
  revision: number;
  selectedTaskId: string | null;
  selectionMode: "follow_activity" | "pinned";
  tasks: TaskSummary[];
  selected: { task: TaskSnapshot; eta: EtaEstimate | null } | null;
  compatibility: { incompatibleClientSeen: boolean };
}

export class TaskStore extends EventEmitter {
  apply(envelope: ProgressEnvelope, nowMs?: number): HudAggregateSnapshot;
  select(taskId: string, mode: "pinned" | "follow_activity", nowMs?: number): HudAggregateSnapshot;
  setHidden(taskId: string, hidden: boolean, nowMs?: number): HudAggregateSnapshot;
  snapshot(nowMs?: number): HudAggregateSnapshot;
  sweep(nowMs?: number): HudAggregateSnapshot;
}
```

- [ ] Write tests for two interleaved tasks, most-recent-active selection, manual pinning, terminal unpin, per-task hide, monotonic aggregate revisions, terminal retention, and bounded eviction.
- [ ] Write persistence tests proving calibration records are content-free, bounded, schema-versioned, written atomically, and recover from a corrupt file without blocking task updates.
- [ ] Run focused tests and confirm failure against the single-task implementation.
- [ ] Implement a `Map`-backed store with configurable `maxTasks`, `terminalRetentionMs`, and injected clock. Preserve `changed` emission only after a real mutation.
- [ ] Keep task IDs opaque in API data and never use them as file names. Persist only calibration summaries, not live task titles/snapshots.
- [ ] Run focused tests and `npm run typecheck`.
- [ ] Commit with `git add src/server tests/server && git commit -m "feat: add bounded multi task state"`.

### Task 5: Add revisioned task, selection, visibility, and Hook ingestion APIs

**Files:**

- Modify: `src/server/http-server.ts`
- Modify: `src/mcp/report-client.ts`
- Create: `src/hooks/schema.ts`
- Create: `tests/hooks/schema.test.ts`
- Modify: `tests/server/http-server.test.ts`
- Modify: `tests/mcp/report-client.test.ts`

**Interfaces:**

```ts
export interface HookEnvelope {
  schemaVersion: 1;
  taskHandle: string;
  eventId: string;
  sessionKey: string;
  turnKey?: string;
  hook: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "Interrupt" | "SessionEnd";
  source?: "startup" | "resume" | "clear" | "compact";
  receivedAt: number;
}

POST /api/hooks/events
POST /api/tasks/:taskId/select
POST /api/tasks/:taskId/visibility
POST /api/leases/acquire
POST /api/leases/:leaseId/renew
DELETE /api/leases/:leaseId
GET /api/snapshot?afterRevision=<n>
```

- [ ] Add strict Hook schema tests with representative Codex Hook payloads; assert prompt, transcript path, tool input/output, cwd, and arbitrary fields never appear in the normalized object.
- [ ] Add API tests for authentication, protocol/generation/revision headers, duplicate event IDs, stale task revisions, selection, visibility, aggregate SSE, reconnect-after-gap, and bounded request bodies.
- [ ] Add report-client tests for aggregate snapshot parsing and explicit per-task calls.
- [ ] Run focused tests and confirm failure.
- [ ] Implement URL-safe task routing without accepting path traversal or decoded separators. Return `409 STALE_REVISION` with the current revision and no mutation.
- [ ] Keep SSE payloads complete and revisioned; `afterRevision` may suppress an unchanged immediate response but must return a full snapshot after a gap.
- [ ] Run focused tests, typecheck, and the existing integration lifecycle test.
- [ ] Commit with `git add src/server src/mcp src/hooks tests && git commit -m "feat: expose revisioned multi task api"`.

### Task 6: Build the privacy-bounded command Hook adapter and package Hooks

**Files:**

- Create: `src/hooks/adapter.ts`
- Create: `src/hooks/client.ts`
- Create: `src/hooks/main.ts`
- Modify: `src/main.ts`
- Create: `hooks/hooks.json`
- Create: `scripts/launch-hook.ps1`
- Modify: `scripts/copy-assets.mjs`
- Modify: `.codex-plugin/plugin.json`
- Create: `tests/hooks/adapter.test.ts`
- Create: `tests/hooks/main.test.ts`
- Modify: `tests/desktop/entry-mode.test.ts`
- Modify: `scripts/validate-plugin.mjs`

**Interfaces:**

```ts
export type EntryIntent =
  | { mode: "hud"; launchReason: DesktopLaunchReason }
  | { mode: "mcp-stdio" }
  | { mode: "hook-event"; hookName: HookEnvelope["hook"] };

export interface HookResult {
  continue: true;
  additionalContext?: string;
}

export function normalizeHookInput(
  hookName: HookEnvelope["hook"],
  input: unknown,
  nowMs: number
): { envelope: HookEnvelope; result: HookResult };
```

- [ ] Write tests for all six Hooks, malformed/oversized stdin, duplicate delivery, a companion-offline fail-open result, stdout JSON purity, stderr bounds, and a hard timeout.
- [ ] Assert `SessionStart` and `UserPromptSubmit` return only an opaque handle plus a concise reporting instruction in `additionalContext`; other Hooks return no context.
- [ ] Run Hook and entry-mode tests and confirm failure.
- [ ] Implement deterministic local HMAC handles/event IDs using the existing protected token as key; never echo raw `session_id` or `turn_id` to UI/API output.
- [ ] Make `--hook-event=<name>` read one bounded JSON value from stdin, ensure/start the companion, post the normalized event, emit one Hook result JSON value, and exit zero on HUD failures.
- [ ] Add `hooks/hooks.json` using the bundled PowerShell launcher, short timeout, and the selected event matchers. Configure async behavior only where Codex supports it.
- [ ] Implement `scripts/launch-hook.ps1` with the same strict installed-manifest and executable-path validation as the Node-free MCP launcher in the related Windows packaging plan. It must invoke the installed executable directly with `--hook-event=<name>`, emit no stdout before takeover, and never require Node.js on an end-user machine.
- [ ] Extend asset copy and plugin validation to require Hook files and reject launchers that accept an unvalidated executable path or reference an absent packaged asset.
- [ ] Run focused tests, `npm run build`, and `npm run validate:plugin`.
- [ ] Commit with `git add src hooks scripts .codex-plugin tests && git commit -m "feat: add automatic privacy bounded hooks"`.

### Task 7: Correlate MCP reports to Hook task handles and keep controls per task

**Files:**

- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/main.ts`
- Modify: `skills/progress-reporting/SKILL.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/mcp/stdio-server.test.ts`

**Interfaces:**

```ts
export const taskHandleSchema = z.string().regex(/^hud_[A-Za-z0-9_-]{20,96}$/u);

export const progressReportSchema = z.object({
  task_handle: taskHandleSchema,
  title: title.optional(),
  phase: phase,
  current_step: step.optional(),
  progress: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  eta_low_seconds: boundedSeconds.optional(),
  eta_high_seconds: boundedSeconds.optional(),
  waiting_for: z.enum(["approval", "user"]).optional()
});
```

- [ ] Add tests proving semantic writes require a valid injected handle, never guess the most recently active task, cannot cross-update another handle, and preserve idempotent start/pause/resume/stop behavior.
- [ ] Add stdio tests for the expected tool inventory, schemas, no protocol noise, and clear `NO_SESSION_ASSOCIATION`, `STALE_REVISION`, and `VERSION_MISMATCH` results.
- [ ] Run MCP tests and confirm failure.
- [ ] Change tool inputs from caller-invented `task_id` to opaque `task_handle`; allow a generic safe title until the model submits a bounded title.
- [ ] Make `tracking_status` observational: it must not launch the companion. Keep `tracking_start` as manual restart/create for stopped tasks, not a normal prerequisite.
- [ ] Deprecate `hud_open`/`hud_close` in descriptions and skill instructions; retain callable aliases for this release. Remove all default prompts that ask users to start tracking manually.
- [ ] Run MCP tests, typecheck, and plugin validation.
- [ ] Commit with `git add src/mcp skills .codex-plugin tests/mcp && git commit -m "feat: bind reports to hook task handles"`.

### Task 8: Make MCP leases control companion lifetime without a second switch

**Files:**

- Create: `src/server/lease-store.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/mcp/main.ts`
- Modify: `src/lifecycle/types.ts`
- Modify: `src/lifecycle/state-store.ts`
- Modify: `src/lifecycle/companion-manager.ts`
- Modify: `src/desktop/lifecycle.ts`
- Modify: `src/desktop/main.ts`
- Create: `tests/server/lease-store.test.ts`
- Modify: `tests/lifecycle/state-store.test.ts`
- Modify: `tests/lifecycle/companion-manager.test.ts`
- Modify: `tests/desktop/lifecycle.test.ts`
- Modify: `tests/integration/companion-lifecycle.test.ts`

**Interfaces:**

```ts
export interface SessionLease {
  id: string;
  ownerNonce: string;
  expiresAt: number;
}

export class LeaseStore extends EventEmitter {
  acquire(ownerNonce: string, ttlMs?: number): SessionLease;
  renew(id: string, ownerNonce: string, ttlMs?: number): SessionLease | null;
  release(id: string, ownerNonce: string): boolean;
  active(nowMs?: number): readonly SessionLease[];
  sweep(nowMs?: number): number;
}
```

- [ ] Write lease tests for opaque IDs, renewal, wrong-owner rejection, expiry, two overlapping MCP processes, and clock-safe bounded TTLs.
- [ ] Write lifecycle tests showing: first current MCP mutation starts companion; long work with a renewing lease stays alive; final lease loss schedules 30–60 second idle shutdown; a new lease cancels shutdown; explicit compatibility `hud_close` shuts down now but does not persist `off`; next eligible event restarts it.
- [ ] Add migration tests proving legacy `desiredState: off` cannot permanently suppress an enabled plugin, while corrupt state and stale generations remain safely handled.
- [ ] Run focused tests and confirm failure.
- [ ] Acquire a lease after MCP initialization, renew below half TTL, and release during clean stdio shutdown. Rely on expiry after crashes.
- [ ] Replace persistent user-facing desired on/off behavior with process generation plus lease presence. Preserve generation guards for start/stop races and keep automatic-login disabled unless a future spec reintroduces it.
- [ ] On final expiry, mark associated nonterminal tasks disconnected after grace, then request graceful companion shutdown. Never terminate an unverified PID or a port-conflicting process.
- [ ] Run lifecycle/server/integration tests and typecheck.
- [ ] Commit with `git add src tests && git commit -m "feat: drive companion lifetime with mcp leases"`.

### Task 9: Present concurrent tasks, compatibility, visibility, and ETA honestly

**Files:**

- Modify: `src/ui/index.html`
- Modify: `src/ui/renderer.ts`
- Modify: `src/ui/styles.css`
- Modify: `src/ui/view-model.ts`
- Modify: `src/desktop/window-controller.ts`
- Modify: `src/desktop/tray-controller.ts`
- Modify: `src/desktop/lifecycle.ts`
- Modify: `tests/ui/view-model.test.ts`
- Modify: `tests/desktop/window-controller.test.ts`
- Modify: `tests/desktop/tray-controller.test.ts`

**Interfaces:**

```ts
export interface HudView {
  taskItems: readonly { id: string; title: string; statusLabel: string; selected: boolean }[];
  selectedTaskId: string | null;
  compatibilityBanner: string | null;
  trackingOriginLabel: string | null;
  etaLabel: string;
  confidenceLabel: string | null;
  canFollowActivity: boolean;
  // existing selected-task presentation fields remain
}
```

- [ ] Add view-model tests for no tasks, multiple tasks, pinned selection, late attachment, quiescent/disconnected/ended states, incompatibility banner, ETA interval/confidence, and hidden current task.
- [ ] Add controller tests proving window X hides only the selected task, same-task activity does not reopen it, a different new task may show once, and terminal background notifications do not steal focus.
- [ ] Run focused tests and confirm failure.
- [ ] Add a compact task switcher and “follow activity” control without expanding the overlay beyond its small-window role. Keep status visible without relying on color alone.
- [ ] Wire selection/visibility calls with current revisions, retry only after fetching a fresh aggregate snapshot, and avoid optimistic cross-task state corruption.
- [ ] Update tray items to show/hide, task selection, follow activity, and diagnostics. Do not expose companion start/stop as ordinary menu commands.
- [ ] Run UI/desktop tests, typecheck, and build.
- [ ] Commit with `git add src/ui src/desktop tests/ui tests/desktop && git commit -m "feat: show multi task progress in hud"`.

### Task 10: Expand diagnostics, onboarding, privacy docs, and migration guidance

**Files:**

- Modify: `src/diagnostics/logger.ts`
- Modify: `src/diagnostics/report.ts`
- Modify: `tests/diagnostics/logger.test.ts`
- Modify: `tests/diagnostics/report.test.ts`
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `CONTRIBUTING.md`

**Interfaces:**

```ts
export interface DiagnosticReportInput {
  versions: { plugin: string; mcp: string; companion?: string; protocol: number };
  hooks: { expected: boolean; activitySeen: boolean; lastEventAt?: number };
  lease: { active: boolean; count: number };
  compatibility: { compatible: boolean; incompatibleClientSeen: boolean };
  tracking: { taskCount: number; selectedStatus?: TaskStatus; lateAttached: boolean };
}
```

- [ ] Write diagnostics tests for hook-untrusted/no-activity, MCP disconnected, companion offline, protocol mismatch, active-but-quiescent task, and late attachment. Ensure no secret/session/task title/path appears.
- [ ] Run diagnostics tests and confirm failure.
- [ ] Add bounded operational event codes for Hook receipt/failure, lease acquire/expire, late attach, stale revision, and protocol mismatch. Store categories and timestamps only.
- [ ] Update the report’s first conclusion to distinguish installation, Hook trust/activity, MCP lease, companion process, compatibility, and tracking state.
- [ ] Rewrite usage docs around one global switch: install/enable in the plugin page, trust Hooks, then tracking is automatic. Explain show/hide and task controls separately.
- [ ] Document old-conversation best effort, full-restart requirement after updates, mismatched-version recovery, deprecated lifecycle aliases, local retention, and exactly which Hook fields are discarded.
- [ ] Run diagnostics tests, plugin validation, and a case-insensitive search for obsolete “manual closed disables reporting” language.
- [ ] Commit with `git add src/diagnostics tests/diagnostics README.md PRIVACY.md docs/THREAT_MODEL.md CONTRIBUTING.md && git commit -m "docs: explain automatic tracking and diagnostics"`.

### Task 11: Integrate Node-free Windows packaging and prove end-to-end behavior

**Files:**

- Modify: `scripts/smoke-test.mjs`
- Create: `scripts/package-contract-test.mjs`
- Modify: `package.json`
- Modify/Create: the files listed in Tasks 1–7 of `docs/superpowers/plans/2026-09-01-windows-release-packaging.md`
- Create: `tests/integration/automatic-tracking.test.ts`
- Create: `tests/integration/multi-session.test.ts`
- Create: `tests/integration/protocol-mismatch.test.ts`
- Modify: `docs/superpowers/reports/` with the final dated verification report only after all checks pass

**Interfaces:**

```json
{
  "scripts": {
    "test:package-contract": "node scripts/package-contract-test.mjs",
    "verify:release": "npm test && npm run typecheck && npm run build && npm run smoke && npm run validate:plugin && npm run test:package-contract"
  }
}
```

- [ ] Add failing integration tests for SessionStart-before-MCP, automatic new-task tracking, late attachment without backfilled elapsed time, two MCP sessions/two tasks, final lease expiry, old-client mismatch banner, and Hook failure that never blocks the simulated Codex action.
- [ ] Execute Tasks 1–7 of the related Windows packaging plan through its local install/reinstall acceptance checkpoint. Extend its canonical plugin sync and whitelist to include `hooks/hooks.json` and `scripts/launch-hook.ps1`; make both launchers resolve the same installer-written executable.
- [ ] Add a package-contract test that stages the exact release tree in a temporary directory and verifies plugin manifest, Hooks, both PowerShell launchers, executable entry modes, generated capabilities, and versions all agree. It must not depend on globally installed Node for the end-user path.
- [ ] Run new integration/package tests and confirm failure before wiring missing pieces.
- [ ] Make the smallest packaging and integration changes required for the tests. Build the local unsigned installer and plugin ZIP, but do not publish artifacts or perform GitHub network operations in this task.
- [ ] Run `npm run verify:release` and `npm run diagnose:mcp`.
- [ ] Run `git diff --check`, `git status --short`, and inspect the complete branch diff for secrets, absolute developer paths, generated junk, and accidental cache changes.
- [ ] Use `superpowers:requesting-code-review`; address findings with fresh failing tests and focused commits.
- [ ] Use `superpowers:verification-before-completion`; rerun the release gate from a clean checkout/worktree and record exact command outcomes in a dated report.
- [ ] Commit the verification report with `git add docs/superpowers/reports package.json scripts tests/integration && git commit -m "test: verify automatic tracking release contract"`.

---

## Release acceptance checklist

- [ ] Plugin install/enable plus trusted Hooks automatically starts tracking without a `start` instruction.
- [ ] Plugin disable/uninstall behavior is described as event/lease-driven and companion shutdown occurs after final lease expiry plus grace.
- [ ] Window show/hide and per-task pause/resume/stop do not masquerade as plugin enable/disable.
- [ ] An older Hook-enabled conversation can late-attach on its first observed turn; a frozen pre-install snapshot gets truthful fallback guidance.
- [ ] Runtime failure and Interrupt outrank model completion; Stop is quiescence; SessionEnd without outcome is unknown.
- [ ] ETA is an interval with confidence and widens under late attachment, sparse evidence, rewrites, and failed validation.
- [ ] Concurrent tasks cannot overwrite each other and the user can pin or follow activity.
- [ ] Old/current version mismatch is explicit and never reported as companion offline.
- [ ] Hook data retention is content-free and verified by tests.
- [ ] Existing lifecycle concurrency, deadline, cancellation, PID identity, and port-conflict protections still pass.
- [ ] No release, GitHub push, plugin installation, or local Codex cache modification occurs until separately authorized.

## Execution handoff

Execute tasks in order because Tasks 2–9 build on the shared capability identity and state model. A task may be split into smaller commits if a red-green-refactor cycle reveals an independent concern, but do not combine adjacent tasks into one unreviewable commit. Stop at the end of Tasks 2, 6, 8, and 11 for explicit review checkpoints.
