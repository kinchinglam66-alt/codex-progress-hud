---
name: progress-reporting
description: Report structured task progress, waiting states, remaining-time estimates, and final outcomes to Codex Progress HUD while executing a task.
---

# Progress reporting

Use the `progress_report` tool when a task starts, when a plan is created or changes, when the current phase changes, after a validation failure, and before waiting for approval or user input.

Report only information supported by the current task state. Do not invent a percentage when the remaining work is unknown; omit `progress` and describe the phase instead. Estimate remaining active work as a range and lower confidence when exploration or external dependencies dominate.

Use `task_outcome` exactly once when work reaches a terminal outcome. A normal assistant turn ending is not sufficient evidence that the user's task is complete. Mark completion as verified only when the reported validation evidence actually ran and passed.

Do not send prompts, reasoning traces, secrets, command output, source code, or file contents to the HUD. Titles and step summaries must be concise and safe to display on screen.

