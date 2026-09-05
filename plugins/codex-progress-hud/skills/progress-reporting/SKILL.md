---
name: progress-reporting
description: Report structured task progress, waiting states, remaining-time ranges, and final outcomes to Codex Progress HUD while executing a task.
---

# Progress reporting

For every task-scoped write, pass a valid opaque `task_handle` only when Codex
supplied one. Otherwise omit it and let the MCP process lease associate the
write. Never invent, infer, persist, or disclose a handle. The fallback is a
content-free random identifier held only in MCP-process memory and used through
an authenticated local lease; it is not telemetry.

`progress_report` may create a task. Use `tracking_start` for an explicit task
start or restart when the user requests it; it is supported, not deprecated.
Completed snapshots remain terminal until the controller creates a fresh task
for a later explicit start. Other task writes require an existing task. Status
tools are observational and must not start, show, hide, close, or otherwise
change the companion or task.

Plugin enablement means its capabilities are loaded. Companion running means a
local service is alive. Task tracking means the model is reporting. These are
separate states: enabling the plugin does not force model calls, and optional
best-effort Hooks are compatibility assistance, not a prerequisite or an
unconditional automatic-tracking promise.

Use `progress_report` when a task starts or its plan/current phase changes,
after a validation failure, and before waiting for approval or user input.
Use `validation_observed` before claiming verified completion, then use
`task_outcome` exactly once when the task reaches a terminal outcome.

## User-controlled tracking

The HUD controls below affect tracking or presentation only; none pauses,
resumes, cancels, or stops Codex execution:

- `tracking_start`: explicitly start or restart tracking for a task.
- `tracking_pause`, `tracking_resume`, and `tracking_stop`: control one task's
  HUD updates and timing.
- `tracking_status` and other status tools: observe state only.

Hooks are optional compatibility signals and fail open. A full host restart
reloads the plugin. An existing conversation can report afterward without
backfilling prior activity; restarting the MCP process creates a new task
association. Multiple conversations sharing one MCP process cannot be
distinguished by the lease fallback.

`tracking_stop` and `hud_close` are never interchangeable: the former stops
HUD updates for one task, while the latter is a deprecated compatibility
lifecycle request. Neither controls Codex execution.
