# Contributing

Codex Progress HUD is a local plugin and companion. Keep the Codex plugin page as the sole global enable/disable boundary: trusted Hooks plus an enabled plugin imply automatic tracking.

## Workflow

1. Describe the user-visible behavior and privacy impact.
2. Write a failing behavior test and record the RED result.
3. Implement the smallest change, then run the focused test GREEN.
4. Run typecheck, build, plugin validation, and the full suite.
5. Update README, privacy, and threat-model documentation when control, data flow, retention, or permissions change.

Never commit conversations, prompts, command output, credentials, generated tokens, raw Hook payloads, or private paths. Operational diagnostics must remain bounded to categories/codes and timestamps.

## Review requirements

Explain automatic Hook attachment, old-conversation best effort, restart requirements after updates, mismatch recovery, deprecated aliases, and the separation between plugin control, window visibility, per-task controls, and Codex execution. Include exact verification commands and privacy risks. Do not package, install, access the network, modify Codex settings/cache, merge, or push as part of a normal contribution.

Contributions are under Apache-2.0.
