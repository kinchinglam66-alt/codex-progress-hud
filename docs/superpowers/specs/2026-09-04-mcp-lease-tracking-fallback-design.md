# MCP Lease Tracking Fallback Design

## Status

Approved in conversation on 2026-09-04. This design is a prerequisite correction for the ETA v2 work: the project cannot evaluate its own progress reporting until a supported Codex path can create and address a task without relying on command Hooks.

## Acceptance amendment (2026-09-05)

Installed acceptance showed that a process-lifetime fixed fallback prevents subsequent work after terminal completion. Continuous use requires one current fallback per MCP process: an explicit handle-free `tracking_start` that observes its own terminal task creates a new random fallback and preserves the old terminal record. Concurrent starts serialize; retries retain the same candidate and write deadline; failed or suppressed starts do not replace the current association. Other calls do not rotate it, and already-in-flight calls retain their captured association. Explicit handles and terminal reducer protections stay unchanged. This amendment supersedes fixed-lifetime statements in the original design and plan below.

## Problem

The installed plugin exposes all MCP tools, but repeated `UserPromptSubmit` turns produce no Hook activity and no task association. The current Codex plugin validator rejects a top-level `hooks` manifest field, and observed runtime behavior does not discover the packaged `hooks/hooks.json`. Consequently, `tracking_start` without a Hook-injected handle returns `NO_SESSION_ASSOCIATION` and the HUD remains empty.

A second defect prevents the MCP process from recovering an offline companion. The native launcher runs the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`. `createProcessLauncher()` inherits that environment when it spawns `--hud`, so the intended desktop child remains in Node mode and never publishes authenticated health. The manager then returns `START_TIMEOUT`. Starting the same executable from a normal desktop environment succeeds, which isolates the inherited environment variable as the failing boundary.

## Goals

- Make progress reporting usable from any turn in an already loaded Codex conversation without a Hook-provided task handle.
- Keep one opaque fallback task association per MCP server process and bind it to that process's existing authenticated lease.
- Preserve explicit Hook task handles for hosts that provide them now or in the future.
- Start the desktop companion successfully from a packaged MCP process.
- Keep the fallback local, content-free, and free of transcript, prompt, path, account, or source-code identifiers.
- Update product language so supported behavior is not described as unconditional automatic Hook tracking.

## Non-goals

- Inferring a Codex conversation identifier from process inspection, window titles, transcript paths, or private host files.
- Claiming that plugin enablement alone guarantees progress reports. The executing model still needs to invoke the plugin's reporting skill or tools.
- Making the HUD control, pause, resume, or cancel Codex execution.
- Adding telemetry, cloud synchronization, persisted task history, or a separate estimation-model call.
- Implementing ETA v2 in this correction. ETA v2 begins after this release baseline is installed and verified.

## Supported tracking model

### Association precedence

Each MCP server process creates one cryptographically random fallback handle with the existing `hud_` prefix and schema-compatible base64url payload. It exists only in that MCP process's memory.

For every task-scoped tool call:

1. A valid explicit `task_handle` wins. This retains compatibility with Hook-aware hosts and explicit callers.
2. If no handle is supplied, the handler uses the process-local fallback handle.
3. The companion binds whichever handle is first written to the existing MCP lease. Existing lease authorization continues to reject access from another lease.

The fallback handle is not derived from a prompt, title, repository path, raw session ID, machine identity, or account identity. Restarting the MCP process creates a new handle. Therefore a host restart may create a new HUD task instead of reconnecting to an old in-memory task; the UI must not imply historical continuity.

### Tool behavior

- `tracking_start` without `task_handle` starts or restarts the fallback task. A supplied title is used; otherwise the bounded default `Codex task` remains.
- `progress_report` without `task_handle` writes to the fallback task and can create it on first report. This is the normal skill-driven path.
- `validation_observed` and `task_outcome` without `task_handle` apply to the fallback task. If no prior task exists, the server returns a task-not-found error rather than manufacturing validation history or a terminal result.
- `tracking_pause`, `tracking_resume`, and `tracking_stop` without `task_handle` target the fallback task. If it has never been created, they return task-not-found.
- Explicit handles remain schema-validated and lease-scoped. Omitting a handle never grants access to the selected task of another MCP lease.
- Status tools remain observational and do not create a fallback task or launch the companion.

Tool results should identify whether the effective association source was `explicit` or `mcp_lease` in bounded structured content. They must not return bearer credentials or the process-local owner nonce.

## Lifecycle correction

`createProcessLauncher()` receives an environment source for testability, clones it for the child, removes `ELECTRON_RUN_AS_NODE`, and passes the sanitized object as the explicit `env` spawn option. It preserves all other environment variables, including the companion data directory, port, token path, and platform runtime variables.

The correction belongs at the desktop-child spawn boundary rather than in the native MCP launcher. MCP itself requires `ELECTRON_RUN_AS_NODE=1`; clearing it globally would break the stdio server. Only the `--hud` child must return to Electron desktop mode.

## Hooks compatibility

The Hook adapter and packaged Hook files may remain as a best-effort compatibility path, but they are no longer required for baseline operation. Documentation and skill instructions must distinguish:

- supported MCP-lease fallback, available whenever this plugin's MCP server is loaded;
- optional Hook association, available only when the host actually executes packaged Hooks;
- plugin enablement, which makes capabilities available but does not force the model to call them.

No manifest field rejected by the current plugin validator will be added to make Hooks appear enabled.

## Data flow

1. Codex starts one plugin MCP process and establishes stdio.
2. The MCP process creates `ownerNonce` for lease authentication and an independent random fallback task handle.
3. A reporting tool resolves its explicit or fallback handle.
4. `CompanionManager.executeWrite()` ensures the desktop companion is healthy. If it must spawn `--hud`, the process launcher removes `ELECTRON_RUN_AS_NODE` from only that child.
5. Lease lifecycle acquires or renews the authenticated lease.
6. The report client submits the task event. The companion binds the task handle to that lease and applies the existing reducer.
7. The HUD renders the selected task. Lease loss and the existing grace period retain their current semantics.

## Failure handling

- Failure to start the companion remains a lifecycle error with its existing bounded code; the tool must not create a success result.
- An explicit malformed handle remains an invalid tool input and does not fall back silently.
- A lease rejection remains authoritative; handlers do not retry with another task or selected global task.
- Missing fallback task state for validation, outcome, pause, resume, or stop returns a bounded task-not-found result.
- Multiple MCP processes receive different random handles and leases. Their tasks can coexist in the same companion without cross-control.
- If the host multiplexes multiple conversations through one MCP process, this fallback cannot distinguish them. This limitation must be documented until Codex exposes a supported conversation-scoped identifier or lifecycle callback.

## Public API and type changes

- `progressReportSchema.task_handle`, `taskOutcomeSchema.task_handle`, and `validationObservedSchema.task_handle` become optional while retaining the same validation when present.
- `createToolHandlers()` receives a `fallbackTaskHandle` dependency generated by `runMcpServer()`.
- A focused resolver returns `{ taskHandle: string; source: "explicit" | "mcp_lease" }` and never reads global selected-task state.
- `createProcessLauncher()` accepts an injectable environment source and always supplies a sanitized child `env`.
- Tool descriptions and `skills/progress-reporting/SKILL.md` stop requiring Hook injection for every write.
- Privacy, installation, known-side-effects, troubleshooting, and release-checklist text reflect supported fallback semantics and the process-multiplexing limitation.

## Testing strategy

### RED tests before implementation

- Process-launcher unit test sets `ELECTRON_RUN_AS_NODE=1` in the injected parent environment and expects the `--hud` spawn environment not to contain it while preserving an unrelated sentinel.
- Handler tests call each task-scoped tool without a handle and assert fallback resolution, task-not-found behavior, and no selected-global-task fallback.
- Handler tests prove malformed explicit handles are rejected and valid explicit handles take precedence.
- Two handler instances with different fallback handles cannot control each other's lease-bound tasks.
- Stdio MCP integration starts without Hook input, calls `tracking_start`, `progress_report`, `validation_observed`, and `task_outcome` without handles, and observes one task.
- Packaged Windows smoke starts MCP through the native launcher with `ELECTRON_RUN_AS_NODE=1`, invokes `hud_open`, and observes `running` instead of `START_TIMEOUT`.

### Verification gates

- Focused lifecycle, MCP tool, stdio, lease, Hook-compatibility, and packaging tests.
- Full test suite, typecheck, build, service smoke, MCP diagnostic, plugin synchronization, plugin validation, and package-contract validation.
- Rebuild companion installer and plugin ZIP from reviewed source.
- Reinstall both artifacts with a new cachebuster, fully restart Codex, and verify from an existing conversation that a handle-free `tracking_start` creates a visible task.
- Verify a second MCP process creates a separate task and cannot mutate the first process's task.

## Release and migration

This behavior changes the user-facing tracking contract and should ship as a new patch release rather than replacing an already published artifact with different bits. Existing explicit-handle clients remain compatible. The plugin and companion must be updated together because the packaged MCP runtime and desktop executable are one versioned application bundle.

Release notes must state that current Codex operation uses an MCP-process fallback, not unconditional Hook tracking. Users update both artifacts, fully restart Codex, and may continue an existing conversation; its first handle-free report creates a new local task without backfilling previous elapsed time.
