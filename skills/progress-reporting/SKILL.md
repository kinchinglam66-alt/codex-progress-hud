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

## Natural-language control mapping

Map the user's intent to exactly one control. Clear English examples include:

- “Start tracking this task” or “Restart progress tracking” → `tracking_start`.
- “Pause HUD updates” / “Resume HUD updates” → `tracking_pause` / `tracking_resume`.
- “Stop tracking this task” → `tracking_stop`; keep the last snapshot visible and leave the companion running.
- “Hide the HUD” → `hud_hide`; “Close/quit the HUD” → `hud_close`.
- “Open/show the HUD” → `hud_open`.
- “What is the task/tracking status?” / “Is the HUD running?” → `task_status` or `tracking_status` / `hud_status`; all status tools are observational and must not start, show, hide, close, or otherwise change the companion or task.

清晰的中文示例包括：

- “开始跟踪这个任务”或“重新开始进度跟踪” → `tracking_start`。
- “暂停 HUD 更新”／“恢复 HUD 更新” → `tracking_pause`／`tracking_resume`。
- “停止跟踪这个任务” → `tracking_stop`；保留最后快照且不关闭伴侣进程。
- “隐藏 HUD” → `hud_hide`；“关闭／退出 HUD” → `hud_close`。
- “打开／显示 HUD” → `hud_open`。
- “当前任务／跟踪状态是什么？”／“HUD 是否在运行？” → `task_status` 或 `tracking_status`／`hud_status`；所有状态工具都只观察，不启动、不显示、不隐藏、不关闭，也不改变任务状态。

`tracking_stop` and `hud_close` are never interchangeable: the former stops updates for the tracked task, while the latter closes the desktop companion and records an explicit off preference. After explicit off, background `progress_report`, `task_outcome`, pause, resume, and stop writes are suppressed and must not reopen the companion. Only an explicit `hud_open`, or a `tracking_start` that is allowed because the user explicitly asked to start or restart tracking, may clear explicit off and reopen it. Status requests never clear explicit off.
