# Unified Plugin Control and Automatic Tracking Design

**Status:** Approved for implementation planning on 2026-09-03

**Date:** 2026-09-03

**Target:** Next Codex Progress HUD release

**Supersedes where conflicting:** `2026-09-01-companion-lifecycle-release-design.md`

## Context

Codex Progress HUD currently exposes task-reporting, tracking, and companion-lifecycle MCP tools, but it has no plugin-bundled lifecycle Hooks and stores only one current task. Users must reason about separate plugin, companion, window, and tracking controls. A task loaded with an older eight-tool plugin can read a newer companion snapshot but cannot submit generation-guarded writes; the old client collapses that protocol rejection into the misleading message that the companion is not running.

The next release must make the Codex plugin page the sole global on/off control, start tracking automatically, support multiple concurrent tasks, attach to an older conversation when the host loads the plugin on a later turn, and preserve deterministic completion, interruption, privacy, and lifecycle behavior.

## Goals

- Treat install/enable and disable/uninstall in the Codex plugin page as the only user-facing global switch.
- Start the companion and tracking automatically for enabled Codex sessions without requiring `tracking_start`.
- Keep window visibility and per-task tracking controls independent from the global plugin switch.
- Show the most recently active task and allow switching among concurrent tasks.
- Support best-effort late attachment to an existing conversation from the first Hook-enabled turn onward.
- Combine runtime Hooks with cooperative model reports without letting model claims override authoritative failures or interruptions.
- Detect plugin/companion incompatibility explicitly and never report it as ordinary offline state.
- Keep the integration local, authenticated, content-minimal, and independent of undocumented Codex GUI scraping.

## Non-goals

- Guaranteed hot injection into a conversation whose host snapshot does not contain the newly installed plugin.
- Reconstruction of elapsed time, tool events, or exact progress from before late attachment.
- Making the companion modify Codex plugin settings or cache files.
- Making the private App Server bridge a release dependency.
- Using task transcript contents, prompts, source files, command output, or hidden reasoning for automatic tracking.
- Pausing or cancelling Codex execution when HUD tracking is paused or stopped.

## User mental model

There is one global switch and two ordinary controls:

```text
Codex plugin page: enable or disable the whole feature
HUD window: show or hide what is already being tracked
Current task: start, pause, resume, or stop its tracking record
```

The companion process is implementation infrastructure, not a second product switch. Its running/exited state appears only in diagnostics. The overlay close button hides the window. Normal tray actions show or hide the window, select a task, and open diagnostics; they do not disable the plugin.

## Global switch and companion lease

Codex remains the source of truth for plugin availability:

- Installing or enabling the plugin makes its MCP server and trusted Hooks eligible in new sessions.
- Disabling or uninstalling the plugin stops new Hook events and eventually closes its MCP stdio connections.
- The companion never edits Codex configuration, marketplace state, or plugin caches.

The companion runs on demand rather than continuously:

1. A plugin Hook or the first current-version MCP mutation asks the lifecycle manager to ensure the companion is running.
2. Each connected plugin MCP process acquires a renewable, opaque session lease and refreshes it periodically while stdio remains connected.
3. The companion stays alive while at least one valid lease exists, including during long tool calls with no Hook events.
4. When all leases expire, the companion enters idle shutdown after a short grace period. The target is 30–60 seconds after the final MCP connection disappears, subject to Codex actually closing that connection.
5. A later enabled session starts the companion again automatically.

This is eventual rather than instantaneous synchronization. Codex does not expose a supported companion callback for the exact moment a plugin is disabled. If an existing conversation retains its prior plugin snapshot and MCP connection, the companion may remain until that session closes or its lease expires.

There is no persistent user-facing `desiredState: off` separate from plugin disablement. Existing `hud_open` and `hud_close` tools remain temporarily as deprecated compatibility/diagnostic aliases but are removed from prompts, normal documentation, and primary UI. `hud_close` means an immediate process shutdown request only; an enabled session may restart the companion on its next eligible event.

## Hook architecture

The plugin bundles `hooks/hooks.json`. The release documentation and first-run UI explain that non-managed Hooks must be reviewed and trusted in Codex. Until they are trusted, automatic tracking is unavailable, but explicit MCP reporting remains usable.

Command Hooks call the installed, packaged executable in a dedicated `--hook-event` mode through a stable plugin launcher. They do not depend on an MCP tool already being connected because Codex may run `SessionStart` before MCP initialization. Hook handlers are non-blocking where supported, have short timeouts, write no protocol noise to stdout, and fail open so HUD failure never blocks Codex work.

The minimum event set is:

| Codex Hook | HUD meaning |
|---|---|
| `SessionStart` (`startup`, `resume`, `clear`, `compact`) | Ensure a task record exists; mark a resume/attachment heartbeat without resetting prior state |
| `UserPromptSubmit` | Begin a new active turn and select this task as most recently active |
| `PostToolUse` | Content-free activity heartbeat; never copy tool arguments or output |
| `Stop` | Mark the turn quiescent; this alone is not task completion |
| `Interrupt` | Record authoritative user interruption for the active turn |
| `SessionEnd` | End the task/session association and classify any nonterminal task as ended without a verified outcome; the MCP stdio lease closes independently |

Every command Hook receives JSON on stdin. The hook adapter validates an allowlist and retains only `session_id`, `turn_id` when present, `hook_event_name`, a bounded source/status category, and timestamps generated locally. It ignores `transcript_path`, prompt content, tool input/output, current source files, and arbitrary fields. Events include a deterministic idempotency key derived from session, turn, Hook event, and bounded sequence data so concurrent or repeated Hooks cannot double-apply state transitions.

`SessionStart` and `UserPromptSubmit` return a short Hook `additionalContext` containing a locally derived opaque HUD task handle and an instruction to use that handle for this session's progress tools. This is the supported correlation path between a Hook's `session_id` and later cooperative MCP reports; the MCP transport itself is not assumed to expose Codex session identity. The context contains no title, prompt, path, or transcript data. Semantic reporting tools accept the handle explicitly and reject ambiguous writes instead of guessing the most recently active task.

Plugin Hooks may be disabled globally or individually by Codex policy. Diagnostics therefore report `hooks_expected`, `hook_activity_seen`, and `mcp_lease_active` separately instead of assuming that plugin enablement guarantees Hook execution.

## Automatic and late tracking

For a new enabled session, the first `SessionStart` or `UserPromptSubmit` event creates a task keyed internally by the opaque Codex `session_id`, returns a separate opaque HUD task handle to model context, starts active timing, makes it the selected task, and shows the overlay unless that task was manually hidden. Until a model supplies a safe short title, the UI uses a generic local label such as “Codex task” rather than exposing a session identifier.

For an older conversation, any first Hook event received without an existing task creates a late-attached record:

- `trackingOrigin` is `late_attach` rather than `session_start`.
- `trackedFrom` is the local receipt time.
- Earlier elapsed time and progress remain unknown.
- The HUD displays a short “tracking started partway through this task” indicator.
- The reporting skill asks the executing model for a fresh phase, remaining-step summary, ETA range, and confidence based on context already available to that model.

This path works only if Codex loads the plugin Hooks or MCP tools for the resumed conversation. If the old conversation retains a pre-install snapshot, the plugin cannot execute and cannot self-diagnose from inside that turn. Documentation offers creating or forking a continuation task as the reliable fallback.

## Multi-task state

`TaskStore` becomes a bounded collection keyed by opaque task id rather than one `current` snapshot. It maintains:

- task snapshots and per-task timing;
- `selectedTaskId` for the overlay;
- `lastActivityAt` ordering;
- per-task `hiddenForTask` and manual tracking state;
- lease/session association;
- terminal retention and bounded eviction metadata.

The most recently active nonterminal task becomes selected automatically. A user selection remains pinned until that task becomes terminal or the user enables “follow activity” again. The API exposes a summary list and one selected-task detail; SSE emits a revisioned aggregate snapshot. Terminal tasks remain visible for a bounded local retention period and are then evicted without uploading history.

Background completion, failure, or interruption produces a lightweight local notification. It does not forcibly steal window focus. A new task shows the overlay. Manually hiding the overlay marks only the current task as hidden so additional events from that task do not reopen it; a different newly active task may show it once.

## Task controls

The existing controls become explicitly per-task and idempotent. Automatic Hook-created tasks use their injected opaque handle; manual controls without a handle are accepted only when the caller's current session association is unambiguous:

- `tracking_start`: manually creates or restarts the selected/identified task when automatic tracking was stopped.
- `tracking_pause`: freezes accepted semantic updates and active-work timing for that task.
- `tracking_resume`: resumes timing and updates.
- `tracking_stop`: preserves the final snapshot as manually stopped but does not stop Codex.
- `tracking_status`: observes state and never launches or mutates the companion.

Natural-language commands default to the current Codex session. An explicit opaque task id or user-visible task selection is required to affect another task. Repeated commands return the existing state as success rather than generating duplicate transitions.

## Completion and interruption evidence

Runtime evidence and semantic evidence remain separate. Precedence is:

1. Authenticated runtime failure or `Interrupt` is authoritative and cannot be overwritten by a model completion claim.
2. A model `task_outcome` with actually observed passing validation may produce `succeeded_verified`.
3. A model completion report without validation produces `completed_unverified`.
4. `Stop` means only that one agent turn stopped; it moves an active turn to quiescent/awaiting-next-turn and never marks the task complete.
5. `SessionEnd` without a terminal outcome produces an ended/unknown-interruption state, not success or failure.
6. Loss of Hook activity while an MCP lease remains live produces `stalled_suspected` after a configurable threshold; later activity restores running state.
7. Loss of both Hook activity and the owning lease marks the task disconnected after a grace period. It remains a suspected interruption unless an authoritative event establishes the cause.

The model may help interpret ambiguous semantic completion, but it cannot decide process liveness, plugin enablement, protocol compatibility, or whether a runtime interruption occurred.

## ETA model

ETA remains a range and uses active-work time only. Waiting, manual pause, quiescent turns, disconnection, and terminal states have no ticking active ETA.

Signals are blended only when available:

- weighted plan completion and observed active throughput;
- executing-model low/high estimate and confidence;
- phase-change volatility and recent estimate error;
- late-attachment uncertainty;
- optional, content-free local calibration buckets after enough completed samples exist.

The estimator widens intervals after exploration, plan rewrites, repeated validation failures, sparse Hook evidence, or late attachment. It narrows only after stable progress observations. A point estimate is never displayed without its interval and confidence class. The history contains durations, anonymous phase classes, estimate errors, and outcome categories only; it contains no task title, prompt, file path, repository name, or source content.

## Version negotiation and known mismatch repair

The health response advertises companion version, current protocol, and an accepted client protocol range. Every mutating request identifies its client protocol and lifecycle generation. Before the first mutation, a current client performs authenticated compatibility negotiation and maps failures to structured categories:

- `COMPANION_NOT_INSTALLED`
- `OFFLINE`
- `VERSION_MISMATCH`
- `GENERATION_REJECTED`
- `AUTH_ERROR`
- `START_TIMEOUT`
- `REQUEST_TIMEOUT`

A valid token plus a missing/unsupported client protocol is recorded by the companion as an incompatible client attempt. The overlay displays “plugin and companion versions do not match; update both and restart Codex.” It never labels this condition as companion offline.

An already loaded old MCP client cannot be repaired in place. Installation diagnostics compare the installed plugin cachebuster/build identity with the companion build and instruct the user to update, fully quit Codex, reopen it, and begin or resume a Hook-enabled task. The release package and installer are built from one version manifest to prevent independently mismatched artifacts.

## APIs and data flow

New internal interfaces are additive and versioned:

- hook ingestion endpoint or hook adapter IPC for content-free lifecycle events;
- MCP lease acquire/renew/release endpoints;
- task list, task select, per-task visibility, and aggregate snapshot endpoints;
- protocol capability fields on authenticated health;
- revision and idempotency fields on mutating events.

All mutations remain authenticated, generation-guarded, body-bounded, deadline-bounded, and serialized through the existing lifecycle state lock where they affect process state. Task events use per-task revision checks so concurrent sessions cannot overwrite another task. SSE clients reconnect from a revision and receive a complete aggregate snapshot after gaps.

## Error handling

- Hooks fail open and never block a user prompt or tool execution because the HUD is unavailable.
- Hook commands have short deadlines and emit only bounded machine-readable status on stderr when Codex requests diagnostics.
- SessionStart tolerates MCP-not-ready ordering; the command hook may start the companion independently.
- Duplicate, stale-generation, stale-revision, and disconnected-request mutations are rejected without side effects.
- Port conflicts never cause unknown process termination.
- A companion crash is recovered once by the next eligible current-version event while a valid plugin lease exists.
- Diagnostics distinguish plugin build, Hook trust/activity, MCP connection, companion health, protocol compatibility, and task tracking state.

## Privacy and security

- Bind only to loopback addresses and authenticate all non-minimal health endpoints.
- Never read or retain transcript contents even though Hooks provide a transcript path.
- Never send prompt text, model reasoning, tool arguments, tool output, source code, file contents, credentials, repository names, or raw working directories to the companion.
- Hash or avoid externally meaningful identifiers; retain the opaque Codex session id only in local protected state when required for correlation.
- Keep renderer sandboxing, restrictive CSP, context isolation, navigation restrictions, constant-time token comparison, exact executable paths, and no-shell process launch.
- Document Hook trust review and ensure a changed Hook definition requires Codex review rather than bypassing trust.

## Packaging and migration

The Windows companion and runtime plugin package share one generated version/capability manifest. The plugin package adds `hooks/hooks.json` and a quiet Hook launcher. The packaged executable adds `--hook-event` and lease support. Source development may use Node/Electron, but end users continue to use the installed executable without Node.js.

Migration preserves valid auth tokens and task event schemas. Current task snapshots are in memory and are not migrated across companion upgrades. The old `desiredState: off` setting is retired from ordinary control semantics; migration does not let it silently suppress an enabled plugin forever. Deprecated lifecycle tools return clear compatibility text and remain for one release before removal is reconsidered.

Installation/update flow:

1. Install or update the companion and plugin from the same release.
2. Enable the plugin in the Codex plugin page.
3. Review and trust the plugin Hooks when Codex asks.
4. Fully restart Codex so tool and Hook snapshots are deterministic.
5. Start a new task, or reopen an older task and continue for best-effort late attachment.

## Verification

### Unit tests

- Multi-task store selection, pinning, visibility, retention, and eviction.
- Hook input allowlist, idempotency, concurrency, deadlines, and zero-content persistence.
- Lease acquisition, renewal, disconnection, expiry, and multi-session overlap.
- Completion/interruption precedence and Stop-versus-terminal behavior.
- ETA active-time accounting, late-attach widening, plan rewrites, and calibration privacy.
- Protocol range negotiation and exact mismatch error mapping.

### Integration tests

- Real command Hook JSON for every selected lifecycle event.
- SessionStart-before-MCP ordering followed by lease acquisition.
- Two concurrent Codex-equivalent MCP processes updating separate tasks.
- Disable-equivalent MCP disconnect followed by lease expiry and companion shutdown.
- Long-running task with MCP lease but sparse Hooks does not shut down early.
- Old client can read health but its mutation creates an incompatibility banner rather than an offline diagnosis.
- Late attachment begins at the first observed event and never fabricates prior elapsed time.
- Full stdio MCP handshake exposes the expected tools with protocol-only stdout.

### Acceptance tests

- Enable plugin, trust Hooks, open a new task, and observe automatic tracking without saying `start`.
- Hide the current task and verify its updates do not reopen the overlay.
- Start another task and verify it appears once and can be switched with the task list.
- Pause, resume, and stop tracking through natural language and UI controls.
- Disable the plugin and verify the companion exits after its final MCP lease closes and grace expires.
- Re-enable the plugin and verify the next new task restarts the companion automatically.
- Reopen an older conversation, continue, and verify either late attachment or a truthful host-snapshot limitation message.
- Install a mismatched test client/companion pair and verify explicit upgrade guidance.
- Run full tests, typecheck, production build, smoke, plugin validation, MCP diagnosis, packaged Hook tests, installer tests, and `git diff --check`.

## Release boundary

The change is ready for release planning only when the implementation plan preserves the existing lifecycle race protections, introduces no undocumented Codex cache edits, includes Hook trust onboarding, and treats old-conversation attachment and disable timing as explicitly bounded best-effort behavior rather than guaranteed hot reload.
