# Native checkpoint recovery

Completed-turn native inheritance remains the first choice. If local source
acquisition cannot supply that branch, the subscription observer may use the
latest existing native checkpoint and every subsequent source record instead.
It does not generate a summary or copy the entire lifetime rollout.

## Boundaries

- Recovery applies only to allowlisted local acquisition failures, before the
  native worker starts. A provider or model failure does not trigger a second
  attempt through this path.
- A supported checkpoint is required. A raw history without one is rejected.
  A malformed newest checkpoint cannot be replaced by an older one.
- The checkpoint and suffix must form a complete effective window within the
  local 8 MiB source bound. Opaque compaction items are preserved; source-role
  messages remain quoted data, not observer instructions.
- The checkpoint is located backwards from a fixed file watermark. Its entire
  raw line is digest-checked before and after suffix reads, including a window
  with no suffix. Replay, pre-dispatch and delivery validation retain this check.
- Ticket, turn, account, cancellation and source-record validation still apply.
  Missing or changed data cannot be silently treated as complete history.
- This route does not request new compression. Runtime-managed context uses the
  pinned provider's capacity checks. The optional end-to-end scheduler deadline
  is disabled by default; when configured, it includes preparation and prevents
  dispatch or delivery after that deadline. See [ETA timeout](ETA-TIMEOUT.md).
  Source-turn cancellation and stale-result rejection remain independent.

## Local startup projection

For rollouts larger than the existing 8 MiB native-file limit, the local status
reader can start at the authenticated attachment's exact `task_started` record.
It searches backwards, including across a checkpoint created inside that turn,
and reads the turn's lifecycle and subsequent records. It does not choose an
unrelated newer turn. Histories within the native-file limit retain the original
full-file acquisition path.

This optimization affects the bounded local projection only. A skipped prefix
is marked as truncated for historical timing provenance, never as a valid
full-file native digest. Model inputs still require the separately verified
checkpoint and complete suffix described above. Missing boundaries, changed
sources, or interrupted reads must not publish a partially initialized cursor.

Startup-to-first-ETA measurements include projection acquisition before the
scheduler begins its request. The scheduler's request duration alone does not
measure the user's full initial wait.

## Verification scope

Local preparation timings do not include account setup, RPC import, inference
or result delivery. Unit tests use synthetic model responses. Neither local
timings nor passing unit tests alone establish a real end-to-end ETA result,
an account-switch success, or ETA accuracy. Validate these on the candidate
before treating the installed version as recovered.
