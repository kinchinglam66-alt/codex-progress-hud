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
  pinned provider's capacity checks; the existing 30-second scheduler deadline
  includes preparation and prevents late model dispatch or ETA delivery.

## Verification scope

Local preparation timings do not include account setup, RPC import, inference
or result delivery. Unit tests use synthetic model responses. Neither local
timings nor passing unit tests alone establish a real end-to-end ETA result,
an account-switch success, or ETA accuracy. Validate these on the candidate
before treating the installed version as recovered.
