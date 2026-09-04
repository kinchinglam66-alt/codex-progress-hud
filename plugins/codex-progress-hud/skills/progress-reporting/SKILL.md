---
name: progress-reporting
description: Report structured task progress, waiting states, remaining-time estimates, and final outcomes to Codex Progress HUD while executing a task.
---

# Progress reporting

Use the `progress_report` tool for a Hook-enabled task when a task starts, when a plan is created or changes, when the current phase changes, after a validation failure, and before waiting for approval or user input. Always pass the opaque `task_handle` supplied by `SessionStart` or `UserPromptSubmit`; never invent or infer a task identifier.

Report only information supported by the current task state. Do not invent a percentage when the remaining work is unknown; omit `progress` and describe the phase instead. Estimate remaining active work as a range and lower confidence when exploration or external dependencies dominate.

Use `validation_observed` to report a bounded passing or failing validation observation, then use `task_outcome` exactly once when work reaches a terminal outcome. A normal assistant turn ending is not sufficient evidence that the user's task is complete. Mark completion as verified only after a prior passing validation observation. Runtime failure and interruption are authoritative.

Do not send prompts, reasoning traces, secrets, command output, source code, or file contents to the HUD. Titles and step summaries must be concise and safe to display on screen.

## User-controlled tracking

The HUD can be controlled from any turn after this plugin has loaded in the task. Treat these as tracking controls, not controls over Codex execution:

- `tracking_start`: manually start or restart tracking for a supplied `task_handle` after an explicit user request. Automatic Hook tracking does not require this tool.
- `tracking_pause`: pause HUD updates and active-work timing for the supplied `task_handle`.
- `tracking_resume`: resume HUD updates and active-work timing for the supplied `task_handle`.
- `tracking_stop`: stop HUD tracking for the supplied `task_handle` while leaving its final snapshot visible.
- `tracking_status`: read the current snapshot without changing it or launching the companion.

Use a control tool when the user explicitly asks to start, pause, resume, stop, or inspect HUD tracking. A pause or stop must not be interpreted as pausing or cancelling the underlying Codex task. Do not invent task identifiers or report task completion solely because tracking was stopped.

## Natural-language control mapping

Map the user's intent to exactly one control. Pass the Hook-injected `task_handle` for every per-task write. Clear English examples include:

- “Start tracking this task” or “Restart progress tracking” → `tracking_start`.
- “Pause HUD updates” / “Resume HUD updates” → `tracking_pause` / `tracking_resume`.
- “Stop tracking this task” → `tracking_stop`; keep the last snapshot visible and leave the companion running.
- “Hide the HUD” → `hud_hide`; “Close/quit the HUD” → deprecated compatibility alias `hud_close`.
- “Open/show the HUD” → deprecated compatibility alias `hud_open`.
- “What is the task/tracking status?” / “Is the HUD running?” → `task_status` or `tracking_status` / `hud_status`; all status tools are observational and must not start, show, hide, close, or otherwise change the companion or task.

清晰的中文示例包括：

- “开始跟踪这个任务”或“重新开始进度跟踪” → 使用 Hook 注入的 `task_handle` 调用 `tracking_start`。
- “暂停 HUD 更新”／“恢复 HUD 更新” → 使用对应 `task_handle` 调用 `tracking_pause`／`tracking_resume`。
- “停止跟踪这个任务” → 使用对应 `task_handle` 调用 `tracking_stop`；保留最后快照且不关闭伴侣进程。
- “隐藏 HUD” → `hud_hide`；“关闭／退出 HUD” → deprecated compatibility alias `hud_close`。
- “打开／显示 HUD” → deprecated compatibility alias `hud_open`。
- “当前任务／跟踪状态是什么？”／“HUD 是否在运行？” → `task_status` 或 `tracking_status`／`hud_status`；所有状态工具都只观察，不启动、不显示、不隐藏、不关闭，也不改变任务状态。

`tracking_stop` and deprecated `hud_close` are never interchangeable: the former stops HUD updates for one supplied task handle, while the latter is a compatibility lifecycle request. Neither control pauses, resumes, or stops Codex execution. Status requests are observational and never launch the companion.
