# Known side effects and limitations

Codex Progress HUD is an observational companion. It does not pause, resume, cancel, or otherwise control Codex execution. This document records costs, behavior changes, and failure modes that users and contributors should understand before enabling it.

## Runtime and user-interface effects

- The Windows companion creates an Electron process and a floating window. This consumes memory, some CPU/GPU time, and desktop space. Always-on-top presentation can distract from or cover other applications.
- The companion listens on loopback port `17837` by default. Another service on that port can prevent startup; an authenticated service-identity mismatch is reported as a port conflict.
- The companion may start when a trusted Hook observes activity or when an MCP task write needs it. It normally exits after the last MCP lease disappears and its grace period expires, so process presence is not identical to plugin enablement.
- Show, hide, pause, resume, and stop are presentation or tracking controls. They do not disable the plugin and do not affect the underlying Codex task.

## Codex workflow overhead

- Optional command Hooks can run on session, prompt, tool, stop, interrupt, and session-end events. They are bounded to short deadlines and fail open, but still add local process and loopback-request overhead.
- The progress-reporting skill and MCP tool calls add a small amount of context and execution work to a task. Excessively frequent reports can create noise and consume more time than they save.
- Hook-provided context can influence the executing model to report progress. Reports remain cooperative model output and can be late, incomplete, inconsistent, or omitted.
- If a Hook is unavailable or no opaque task handle is supplied, the agent must not invent an identifier; omit it and use the MCP-process lease fallback. Multiple conversations sharing one MCP process cannot be distinguished by that fallback.

## ETA and progress accuracy

- Progress is not a direct measurement of hidden model reasoning. It is inferred from observed runtime events, explicit plan steps, active-work timing, calibration data, and optional estimates reported by the executing model.
- The current companion does not independently call an external estimation model. A `model` signal means an estimate supplied through the reporting tools by the model already executing the Codex task.
- Model estimates can anchor the combined ETA incorrectly. Confidence and volatility widen the displayed range, but they cannot guarantee low error.
- Tool latency, permission prompts, network waits, test duration, user decisions, scope changes, retries, and previously unseen failures can invalidate an estimate abruptly.
- Percentage completion is meaningful only when the plan is sufficiently stable and step weights are representative. A changed plan can move the percentage or ETA backward without indicating a product failure.
- Calibration improves only when comparable, trustworthy samples exist. Sparse or shifted workloads can make historical calibration misleading.

## Completion and interruption semantics

- A model saying that work is complete is not proof that the result is correct. Verified completion requires separate passing validation evidence reported for that task.
- `Interrupt`, `SessionEnd`, and explicit runtime failures are stronger evidence than silence. Lease expiry, a missing heartbeat, process exit, or loss of connection alone cannot prove whether a task completed or was interrupted.
- A stopped tracking snapshot means only that HUD updates stopped. It must not be interpreted as a stopped or completed Codex task.
- Crashes, forced shutdowns, host restarts, and missed Hooks can leave the final status unknown or stale. The UI should preserve that uncertainty instead of guessing a terminal outcome.

## Installation and compatibility effects

- Version 0.2.1 supports Windows 10/11 x64. Other desktop platforms are not release-supported yet.
- The installer is currently unsigned and can trigger Windows SmartScreen warnings. Users should verify release checksums before installation.
- Installing or updating the plugin requires a full Codex Desktop restart to reload its manifest, MCP definitions, skill, and optional Hooks.
- An existing conversation can report after restart without backfilling activity before installation. Restarting the MCP process creates a new task association, and a conversation retaining a pre-install plugin snapshot may require a continuation task.
- Plugin and companion protocol versions must match. A stale cache or partial update can expose tools while leaving lifecycle operations incompatible.

## Privacy and security residual risks

- The running product has no project-operated telemetry or cloud synchronization. It stores bounded local operational state and uses a local bearer token.
- Session and turn identifiers are transformed into opaque HMAC-derived values, but timing, state transitions, process presence, and path-existence booleans remain metadata.
- Other processes running as the same operating-system user may be able to read local application data, including the bearer token. The loopback boundary does not protect against a compromised user account.
- Diagnostic reports are designed to exclude prompts, source code, raw identifiers, secrets, and tool output, but users should still review a report before sharing it.
- Any future telemetry, cloud sync, persisted task history, or separate model call would change the cost and privacy boundary and requires explicit user control plus updated documentation.

## Responsible interpretation

Treat the HUD as a situational-awareness aid, not a scheduler, billing meter, correctness oracle, or safety control. Important decisions should rely on Codex output, test evidence, repository state, and human review rather than a single status label or ETA.
