---
name: progress-reporting
description: Report structured task progress, waiting states, remaining-time estimates, and final outcomes to Codex Progress HUD while executing a task.
---

# Progress reporting

Use the `progress_report` tool when tracking is active: when a task starts, when a plan is created or changes, when the current phase changes, after a validation failure, and before waiting for approval or user input.

Report only information supported by the current task state. Do not invent a percentage when the remaining work is unknown; omit `progress` and describe the phase instead. Estimate remaining active work as a range and lower confidence when exploration or external dependencies dominate.

Use `task_outcome` exactly once when work reaches a terminal outcome. A normal assistant turn ending is not sufficient evidence that the user's task is complete. Mark completion as verified only when the reported validation evidence actually ran and passed.

Do not send prompts, reasoning traces, secrets, command output, source code, or file contents to the HUD. Titles and step summaries must be concise and safe to display on screen.

## User-controlled tracking

The HUD can be controlled from any turn after this plugin has loaded in the task. Treat these as tracking controls, not controls over Codex execution:

- `tracking_start`: start tracking. Pass `task_id` and `title` when creating a new current task; both are optional when the current snapshot already identifies the task.
- `tracking_pause`: pause HUD updates and active-work timing.
- `tracking_resume`: resume HUD updates and active-work timing.
- `tracking_stop`: stop HUD tracking while leaving the final snapshot visible.
- `tracking_status`: read the current snapshot without changing it.

Use a control tool when the user explicitly asks to start, pause, resume, stop, or inspect HUD tracking. A pause or stop must not be interpreted as pausing or cancelling the underlying Codex task. Do not invent task identifiers or report task completion solely because tracking was stopped.
