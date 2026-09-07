# Privacy policy

Codex Progress HUD is local-first. It has no project-operated cloud service or telemetry.

## Control and processing

Codex’s plugin page is the sole global enable/disable/uninstall control. Enablement loads capabilities; it does not force model calls. Tracking is cooperative model reporting. Hooks are optional best-effort compatibility signals, not a prerequisite or unconditional automatic-tracking mechanism. Window visibility and per-task controls are presentation/timing controls only; they do not change plugin state or Codex execution.

The Hook adapter accepts `session_id`, `turn_id`, `tool_use_id`, `hook_event_name`, and `source` after schema validation. Session and turn values become HMAC-hashed identifiers. In the multi-conversation candidate, a turn-identified UserPromptSubmit or PostToolUse additionally carries the raw host session ID over authenticated loopback to the companion solely to look up the actual chat name. The companion verifies its HMAC binding. This raw mapping is memory-only and is absent from model responses, logs, diagnostics and research data. Prompt text, transcript path, tool input/output, cwd, arbitrary fields and secrets are discarded.

Chat names are read by a local metadata-only Codex app-server client and held in a bounded memory cache. Desktop rows show these names; MCP snapshots expose only rows bound to that client's lease. The aggregate event stream is desktop-only. Names are not sent to an estimator, diagnostic export or research dataset. Failed refreshes retain a visibly stale name; no available name displays an explicit placeholder. Disabling the service clears the cache.

The candidate name reader supports a pinned Windows Codex CLI build, uses an empty temporary working directory, disables plugin/hook/tool features and issues only initialization and metadata read requests, never task start/resume or inference. CLI startup can read its existing local configuration and authentication; the HUD does not parse authentication files. Exact-build compatibility and local executable replacement remain limitations. This does not establish that CLI startup itself is completely network-free.

## Development candidate: passive task content

The passive-development candidate changes the content boundary described above:
identified prompt, final assistant message and selected tool-response text fields
are filtered locally and sent over authenticated loopback to private companion
memory. Transcript files are not read; arbitrary nested tool input, environment
objects and unrelated fields are not serialized. Obvious credentials are filtered
before truncation, but this is not a guarantee that all sensitive information is removed.

Each content item is limited to 4,096 UTF-16 characters. Default conversation
retention is 32 entries and 16,384 characters, with at most 32 active context
records. Content and observer goal summaries are excluded from public HUD/MCP
snapshots, SSE and default diagnostics. Session end deletes retained content;
companion close clears private memory. No raw task history is written to disk by
this collection path.

The new independent-observer contract and local goal owner are under development,
not an installed passive release. They do not currently launch model requests.
Future activation requires disclosure of the additional requests, quota use and
selected task content sent through the user's configured route. A shared provider
name alone does not establish identical retention or account handling.

## Storage and retention

Live task snapshots, the MCP-process fallback identifier, and lease state are in memory. The fallback identifier is random, content-free, authenticated by the local lease, and never persisted or sent as telemetry. Operational logs and diagnostic reports are local, bounded, and contain only allowlisted versions/states, bounded codes/categories, and canonical timestamps. They never contain token, raw session ID/handle, title, prompt, path, Hook payload, or secret. Review reports before sharing. Removing the application-data directory after stopping removes the local token and files; the next start creates a new token.

## Lifecycle and migration

After plugin or companion updates, fully restart Codex Desktop to reload the plugin. An existing conversation can report afterward without backfilling prior activity. Restarting the MCP process creates a new task association; multiple conversations sharing one MCP process cannot be distinguished by the fallback. A protocol mismatch is distinct from an offline companion; update the mismatched side and restart host and companion. `hud_hide` is an ordinary window-visibility alias. `hud_open` and `hud_close` remain deprecated compatibility aliases; `tracking_start` is supported explicit start/restart, not deprecated. None is global consent or a second enable switch; `hud_close` requests immediate shutdown without persisting a global off preference.

## Network

The companion binds only to loopback and sends no HUD data to remote services. Package-manager activity is outside the running HUD.

Future telemetry, cloud synchronization, persisted task history, or external model calls require an updated policy and explicit control.

## Development-only shadow estimator

The source tree contains a disconnected optional estimation adapter and offline evaluation tools. The installed application does not instantiate this adapter or automatically send task metrics to it. An explicit future pilot requires a model, credentials, positive spend budget, and consent for the exact data fields. The current adapter accepts only active seconds, numeric progress, tool count and validation-failure count; it rejects text, paths, task identifiers and extra fields. Its request disables response storage, but that is not a promise of zero provider retention.

A separately opened local pilot budget journal stores only a limit and numeric reservations, not task history or credentials. It conservatively retains reservations after uncertain cancellation, and does not reset on restart. Tests use synthetic responses and temporary journals. No production telemetry or display replacement is enabled by these development modules.
