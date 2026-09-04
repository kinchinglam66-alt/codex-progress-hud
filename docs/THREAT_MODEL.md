# Threat model

## Assets and boundaries

Assets are local task metadata, the bearer token, lifecycle/progress integrity, and user attention. Electron, renderer, MCP server, Hook commands, Codex host, companion, and same-user processes are separate trust boundaries. Model output and MCP arguments are untrusted.

## Control boundary

Codex’s plugin page is the sole global enable/disable/uninstall switch. Trusted Hooks with an enabled plugin automatically provide runtime evidence. Window show/hide and per-task selection/timing controls are presentation controls; they neither change plugin state nor control Codex execution.

## Main threats and mitigations

Every API route requires a high-entropy token; the service is loopback-only, uses constant-time comparison, bounded bodies/responses, deadlines, and no CORS. The renderer is sandboxed and never receives the token. Port occupancy is not process ownership: authenticated live health must match PID and instance nonce before a manager-owned child can be force-terminated.

Protocol incompatibility, missing installation, Hook distrust/no activity, missing MCP lease, and an offline companion are reported as separate diagnostic dimensions. A mismatched client must be updated and restarted; it is never mislabeled as offline.

Hooks accept only `session_id`, optional `turn_id`, optional `tool_use_id`, optional `hook_event_name`, and optional `source`. Session and turn identifiers are HMAC-hashed; the event identity hashes Hook name/source/tool-use identifier. Raw fields are discarded. Prompt, transcript path, tool input/output, cwd, arbitrary fields, title, token, secret, source contents, and command output never enter diagnostics or operational history.

Operational history is an allowlist of bounded event codes/categories and canonical timestamps. Diagnostic reports additionally expose safe versions, lifecycle states, path-existence booleans, loopback host/port, runtime age, and bounded error codes. They are local and should be reviewed before sharing.

Runtime interruption evidence is authoritative only when supplied by a trusted Hook/runtime boundary (`Interrupt`, `SessionEnd`, or an explicit runtime failure). A missing heartbeat, lease expiry, or disconnected process is suspected and is labeled accordingly; it cannot be presented as confirmed interruption or completion. Model-reported success is verified only by the configured validation evidence.

An older conversation can attach on its first observed Hook after a full Codex restart, with no backfilled elapsed time; a new task is not required. A conversation frozen before installation or update cannot self-attach until the host loads the new plugin snapshot. Deprecated `hud_open` and `hud_close`, the ordinary `hud_hide` visibility alias, and `tracking_start` remain only for compatibility and do not form another global switch. `hud_close` requests immediate shutdown without persisting global off.

Residual risks include same-user malware reading the application-data token, timing/path-existence inference, and inaccurate cooperative model reports. No cloud service or telemetry is present.
