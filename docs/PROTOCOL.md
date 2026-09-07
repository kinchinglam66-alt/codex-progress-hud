# Local companion protocol 3 (development candidate)

Protocol 3 is a breaking local transport revision. It is not a release or
installation announcement. The plugin package version and release artifacts must
be coordinated separately before distribution.

## Client compatibility

The candidate accepts protocol 3 only. Protocol 2 clients must be upgraded together
with the companion; they cannot reuse their old write or snapshot assumptions.
Authenticated mutations and MCP snapshot requests carry
`x-codex-progress-hud-protocol: 3`. Unsupported versions receive HTTP 426 with
`VERSION_MISMATCH`, before event schema processing or conditional snapshot handling.
The unauthenticated identity endpoint remains minimal; it is not a task-data API.

## Public writes

`POST /api/events` accepts only `tracking_started`, `tracking_paused`,
`tracking_resumed`, and `tracking_stopped`. The envelope contains `taskId`, optional
`title`, and `event: {type}`. Additional fields are rejected. Control titles do not
override Codex conversation names in the HUD.

Model progress, ETA, plan, validation, completion and runtime observations are not
accepted on this route. In particular, `progress_report`, `validation_observed`
and `task_outcome` are no longer MCP tools. Runtime Hook traffic uses the separate
authenticated Hook route; its schema version is independent of the transport
protocol. Hooks acknowledge delivery without injecting model-facing instructions
or task handles. Acknowledgement alone does not prove successful delivery.

## MCP view and revisions

MCP snapshots contain only handles bound to the requesting lease, with a local
selection and revision. They omit aggregate Hook and turn-tracking diagnostics.
Other conversations' activity must not change this revision. Desktop snapshots
and their revisions remain aggregate and must never be used for an MCP write.

For conditional reads, pass a revision obtained from the same lease. Revisioned
writes and their stale/missing-revision errors use that same view. Reacquiring a
lease requires reading its view again; cached revision numbers are not transferable.
MCP clients cannot subscribe to the aggregate desktop event stream.

## Release work still required

This transport boundary does not by itself establish provider authorization,
long-duration ETA accuracy, installed lifecycle acceptance, or release readiness.
Historical reducer and evaluation types may retain older outcome categories;
they are not an alternate public write API.
