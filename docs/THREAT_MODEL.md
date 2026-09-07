# Threat model

## Assets and boundaries

Assets are local task metadata, the bearer token, lifecycle/progress integrity, and user attention. Electron, renderer, MCP server, Hook commands, Codex host, companion, and same-user processes are separate trust boundaries. Model output and MCP arguments are untrusted.

## Control boundary

Codex’s plugin page is the sole global enable/disable/uninstall switch. Enablement loads capabilities but does not force model calls. Hooks are optional best-effort compatibility signals, not a prerequisite or unconditional automatic-tracking path. Window show/hide and per-task selection/timing controls are presentation controls; they neither change plugin state nor control Codex execution.

## Main threats and mitigations

Passive-development delta: the new local Hook runtime can retain bounded filtered
prompt/final-message/selected tool-response text in private companion memory.
The legacy content-discard description below applies to identity-only normalization,
not to this candidate runtime. Filtering precedes truncation and is best-effort,
not complete DLP. The passive owner accepts model status/goal/ETA interpretation
through strict schemas and one-use local tickets; model output cannot supply
identity. Per-conversation runtime clocks, explicit interruption/failure precedence
and stale-response rejection protect state integrity. No separate validation-evidence
gate exists in this new contract; inferred completion is not a quality guarantee.
Live independent dispatch and the production display migration remain gated.

Every API route requires a high-entropy token; the service is loopback-only, uses constant-time comparison, bounded bodies/responses, deadlines, and no CORS. The renderer is sandboxed and never receives the token. Port occupancy is not process ownership: authenticated live health must match PID and instance nonce before a manager-owned child can be force-terminated.

Protocol incompatibility, missing installation, Hook distrust/no activity, missing MCP lease, and an offline companion are reported as separate diagnostic dimensions. A mismatched client must be updated and restarted; it is never mislabeled as offline.

Hooks validate session/turn/tool-use identifiers, Hook name and source. The adapter returns opaque HMAC identities. For turn-identified prompt/tool events, the runtime additionally passes a raw host session ID over authenticated loopback for metadata lookup; the server requires its HMAC to match the conversation key before mutation. This mapping never enters model snapshots, diagnostics or operational history. Prompt, transcript path, tool input/output, cwd, arbitrary fields and secrets are discarded.

Host chat names are untrusted display text, never HTML or executable instructions. The bounded in-memory cache serializes metadata reads, coalesces refreshes, rate-limits each conversation, aborts removed entries, and discards late results. Model snapshots filter rows by lease; MCP requests cannot use the aggregate SSE route. A same-user process holding the shared bearer token can impersonate a desktop client; lease filtering is not protection against same-user token compromise.

The title reader launches only an exact SHA-256-pinned Windows CLI build with task/tool/plugin features disabled. It requests metadata only, caps child output and read time, and fails closed after failed child cleanup. Hash verification before a cached launch is not atomic executable ownership: replacement after verification and descendant/parent-crash cleanup are residual risks. It is not an OS process-tree sandbox. Coordinated plugin/companion updates and real host acceptance are required before release.

Operational history is an allowlist of bounded event codes/categories and canonical timestamps. Diagnostic reports additionally expose safe versions, lifecycle states, path-existence booleans, loopback host/port, runtime age, and bounded error codes. They are local and should be reviewed before sharing.

Runtime interruption evidence is authoritative only when supplied by a trusted Hook/runtime boundary (`Interrupt`, `SessionEnd`, or an explicit runtime failure). A missing heartbeat, lease expiry, or disconnected process is suspected and is labeled accordingly; it cannot be presented as confirmed interruption or completion. Model-reported success is verified only by the configured validation evidence.

An existing conversation can report after a full Codex restart, with no backfilled elapsed time; a new task is not required. A conversation frozen before installation or update cannot report until the host loads the new plugin snapshot. Restarting the MCP process creates a new task association, and multiple conversations sharing one MCP process cannot be distinguished by the fallback. Deprecated `hud_open` and `hud_close`, the ordinary `hud_hide` visibility alias, and supported explicit `tracking_start` do not form another global switch. `hud_close` requests immediate shutdown without persisting global off.

Residual risks include same-user malware reading the application-data token, timing/path-existence inference, indistinguishable conversations sharing one MCP process, and inaccurate cooperative model reports. The fallback identifier is content-free, process-memory-only, locally authenticated, and not telemetry. No cloud service or telemetry is present.
