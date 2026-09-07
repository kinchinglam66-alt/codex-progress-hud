# Turn-scoped tracking design

Status: principles and written specification approved in this conversation on 2026-09-05. Baseline: 1874f9e. Runtime implementation is in progress; this design document does not claim installation or acceptance.

## Scope and evidence

This is step 1 of the approved sequence: turn tracking, installed lifecycle acceptance, mock independent estimator, consented live evaluation, then release integration. It changes identity and event routing across Hooks, MCP, the store and presentation, so it is an architectural change rather than a reducer-only fix.

Observed installed behavior: after verified completion, subsequent substantive turns and progress writes still return succeeded_verified. Source inspection shows:

- `src/core/reducer.ts` intentionally protects semantic and authoritative terminal states.
- `src/hooks/schema.ts` derives taskHandle from session identity alone.
- With turn_id absent, otherwise identical UserPromptSubmit invocations derive identical event IDs.
- `src/server/http-server.ts` deduplicates those IDs and drops turn identity from Stop/Interrupt conversion.
- MCP progress/outcome writes identify a task but carry no independently captured turn generation.

These are separate defects/constraints; relaxing terminal protection alone is not sufficient. Missing IDs in this host's actual Hook payload have not been established by inspecting private transcripts and must not be assumed as a fact.

## Alternatives and decision

1. Reopen the existing task on any activity: small patch, but destroys terminal semantics and permits old results to affect new work. Rejected.
2. Keep one mutable task and add an epoch to every writer: feasible but requires every producer to capture and transmit the epoch before work begins; looking up the latest epoch at delivery time is unsafe.
3. Keep conversation grouping stable and use a separate immutable task association for each identified turn: chosen. Existing task-handle transport and terminal protection can fence old results without silently rebinding them to the latest turn.

## Identity and routing

- Retain a session-scoped opaque grouping key. It is not a writable alias for the latest task.
- For a host-identified turn, derive a distinct opaque task handle from the session ID and turn ID using the existing local HMAC mechanism with explicit domain separation. Neither raw ID is persisted or displayed.
- A trusted UserPromptSubmit creates/selects that turn record and injects its exact task handle into the model's Hook context. Change the wording from "for this session" to "for this turn".
- The task handle, once assigned to an operation, never changes. Delayed MCP writes and future estimator callbacks retain their captured handle; they cannot query and adopt the latest turn's handle.
- SessionStart does not create a fabricated execution turn. It records attachment/availability. A turn-bearing event received during mid-turn installation may create a late-attached record with the observed start boundary, not backfill elapsed time.
- Stop, Interrupt and other turn-bearing Hook events retain the turn key through routing. An old terminal event only affects its old record. SessionEnd/lease expiry remain connection/session evidence and do not establish objective completion.
- Lease authorization is still enforced per handle. Group membership is not permission to write every turn; do not replace scoped filtering with session-wide access.

## Missing identity and duplicate handling

Strong and degraded modes must be visibly distinct:

- With a host turn ID, duplicate event identity is stable, domain-separated by event category and available tool/event identity. Replaying a UserPromptSubmit cannot create a second turn record. Events for a known older turn never take focus from a newer accepted turn.
- Without a host turn ID, do not infer one from repository, title, prompt content, wall-clock timestamps or a current-session lookup. Record session-level activity and expose `turn_identity_unavailable`; do not automatically reopen the old completed task or route an unscoped terminal event to current work.
- Transport retries reuse the same constructed envelope. A genuinely new invocation may have a locally generated event nonce so separate unkeyed observations are not globally collapsed. Such a nonce is event identity only, not proof of a new host turn or exactly-once delivery across host reinvocation.
- For two previously unseen host turn IDs delivered out of order, opaque IDs alone do not establish order. Do not claim full source-order guarantees. Use host ordering metadata only if actually available and verified; otherwise expose ordering uncertainty and avoid letting ambiguous terminal events change the selected current turn.
- If degraded mode is the only mode supported by the installed host, report that automatic cross-turn acceptance is blocked by identity availability. Do not hide that limitation behind a manual restart or a generated task identifier.

## Task state, history and UI

- Terminal protection remains within each turn, including verified success, failure and interruption.
- A new identified turn starts a fresh timer, plan, progress, ETA and validation record. It does not inherit prior verification evidence or mark the user's broader project complete.
- Preserve bounded previous-turn summaries grouped under the conversation, using existing 32-record/15-minute retention limits initially. Retention is local in-memory history, not a transcript archive.
- Show the active turn in follow mode; retain intentional pin/hide behavior. Display a concise degraded-source message when identity is unavailable, rather than presenting an old completion badge as evidence about the current turn.
- Pause/stop remain task-scoped and are not silently reversed on that same record. A distinct newly identified turn is a new tracked task; the plugin's explicit global off state still suppresses all automatic startup/tracking.
- Updates to an immutable terminal record must return an explicit not-applied disposition. A no-op is not a successful progress update. Status calls remain observational.

## Compatibility and privacy

- Update root/nested plugin descriptions, Hook context wording, schemas, tests and generated capability metadata together. Existing protocol-v1 artifacts must not be allowed to treat a conversation-scoped handle as a new turn-scoped one.
- Advance the protocol for the new routing contract and require matching companion/MCP/Hook artifacts before installed acceptance. Retain old diagnostics/read-only mismatch guidance, not ambiguous cross-version writes.
- Legacy supplied session handles do not auto-forward to the newest turn. Explain stale/missing association and require freshly supplied Hook context.
- Handle-free MCP fallback remains explicitly connection-scoped degraded tracking; it cannot claim isolation between conversations or turns shared by that process.
- Keep connection-owned lifetime, explicit off, authenticated loopback, bounded deadlines and generation checks unchanged.
- No transcript polling, prompt storage, credential changes, Hook trust bypass, telemetry or paid model requests. Hook definition changes require normal user review; never edit trust state.

## Implementation boundaries

- `src/hooks/schema.ts`: domain-separated turn association and event identity; bounded context output.
- New `src/server/turn-router.ts`: bounded conversation/turn routing and provenance decisions, separate from HTTP parsing and lifecycle ownership.
- `src/server/task-store.ts`, `src/core/types.ts`, `src/core/schema.ts`: turn metadata, bounded history and explicit mutation disposition; preserve per-turn reducer semantics.
- `src/server/http-server.ts`: apply routing before state mutation; maintain authentication, lease scopes, stale revision checks and fail-open Hook behavior.
- `src/mcp/tools.ts`, `src/mcp/report-client.ts`: expose not-applied/stale association errors and never retarget delayed writes.
- UI/tray: conversation grouping and identity-unavailable indication, without a new global switch.
- Plugin manifests/capabilities and skills: synchronized compatibility contract and accurate usage wording.

## Acceptance requirements

Write failing tests before implementation for each behavioral slice:

1. Complete turn A; trusted distinct turn B starts running with fresh progress, timing and validation while A stays complete.
2. Duplicate B prompt is idempotent. Delayed A Stop/Interrupt/progress/outcome cannot change B or steal follow selection.
3. Unknown/unkeyed terminal events cannot finalize B; missing identity produces an explicit degraded signal.
4. Separate unkeyed observations do not share one session-lifetime dedup key; retrying one envelope remains idempotent.
5. Manual pause/stop, global off, generation changes, lease expiry and cross-session authorization remain enforced.
6. Prior validation cannot verify a new turn. ETA callbacks captured for A cannot update B.
7. Mid-turn attachment reports only observed time; retention, pin/follow and hidden-state behavior remain bounded and predictable.
8. Old/new protocol combinations fail safely rather than silently misrouting a write.
9. Packaged real-MCP/Hook tests exercise two turns with distinct injected associations and assert no-op responses are visible.
10. Installed host test: consecutive real turns, visible active state, matching progress readback and retained prior completion. If the host supplies insufficient identity, mark degraded/not passed instead of manufacturing evidence.

Focused tests run during implementation; full suite, type check, build and one bounded review at the milestone. Installed binaries are replaced only after packaged acceptance and a safe Codex exit/install/reopen cycle. This step does not claim low ETA error, total objective completion, or release readiness.
