# Privacy policy

Codex Progress HUD is local-first. It has no project-operated cloud service or telemetry.

## Control and processing

Codex’s plugin page is the sole global enable/disable/uninstall control. Enablement loads capabilities; it does not force model calls. Tracking is cooperative model reporting. Hooks are optional best-effort compatibility signals, not a prerequisite or unconditional automatic-tracking mechanism. Window visibility and per-task controls are presentation/timing controls only; they do not change plugin state or Codex execution.

The Hook adapter accepts `session_id`, `turn_id`, `tool_use_id`, `hook_event_name`, and `source` after schema validation. It discards raw values immediately: session and turn values are HMAC-hashed into opaque identifiers, and the event hash includes Hook name, source, and tool-use identifier. Prompt text, transcript path, tool input/output, cwd, arbitrary fields, titles, tokens, and secrets are rejected or discarded and never cross the Hook boundary.

## Storage and retention

Live task snapshots, the MCP-process fallback identifier, and lease state are in memory. The fallback identifier is random, content-free, authenticated by the local lease, and never persisted or sent as telemetry. Operational logs and diagnostic reports are local, bounded, and contain only allowlisted versions/states, bounded codes/categories, and canonical timestamps. They never contain token, raw session ID/handle, title, prompt, path, Hook payload, or secret. Review reports before sharing. Removing the application-data directory after stopping removes the local token and files; the next start creates a new token.

## Lifecycle and migration

After plugin or companion updates, fully restart Codex Desktop to reload the plugin. An existing conversation can report afterward without backfilling prior activity. Restarting the MCP process creates a new task association; multiple conversations sharing one MCP process cannot be distinguished by the fallback. A protocol mismatch is distinct from an offline companion; update the mismatched side and restart host and companion. `hud_hide` is an ordinary window-visibility alias. `hud_open` and `hud_close` remain deprecated compatibility aliases; `tracking_start` is supported explicit start/restart, not deprecated. None is global consent or a second enable switch; `hud_close` requests immediate shutdown without persisting a global off preference.

## Network

The companion binds only to loopback and sends no HUD data to remote services. Package-manager activity is outside the running HUD.

Future telemetry, cloud synchronization, persisted task history, or external model calls require an updated policy and explicit control.
