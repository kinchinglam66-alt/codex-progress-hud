# Privacy policy

Codex Progress HUD is local-first and has no project-operated cloud service or telemetry in the MVP.

## Data processed

The companion processes a task identifier, short display title, phase, current step, optional progress and confidence, optional ETA bounds, waiting reason, and terminal outcome. It also processes local lifecycle events when an explicitly configured bridge supplies them.

The reporting skill forbids sending prompts, hidden reasoning, source code, command output, file contents, credentials, or access tokens to the HUD.

## Storage and retention

The MVP keeps task snapshots in memory. It writes one randomly generated authentication token to the user's application-data directory. It does not persist task content or timing history.

Deleting the application-data directory after the HUD is stopped removes the local token. A new token is generated on the next start.

## Network behavior

The companion binds only to the loopback interface. It does not send HUD data to a remote service. Dependency installation and future update checks are separate package-manager activities and are not performed by the running HUD.

## Logs

The application avoids logging task payloads and tokens. Contributors must redact personal information and secrets from bug reports, screenshots, fixtures, and diagnostics.

## Changes

Any release that adds telemetry, cloud synchronization, persisted history, or external model calls must update this policy before enabling that behavior and must provide explicit user control.

