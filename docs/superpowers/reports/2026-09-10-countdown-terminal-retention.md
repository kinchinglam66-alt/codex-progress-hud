# Countdown lifecycle retention regression

## Symptom and cause

The countdown could continue after a turn ended and through later user turns.
Local session logs contained the explicit `task_complete` event; lack of an
upstream end signal was not the cause reproduced here.

The bounded context owner preserved the authenticated turn's user message,
but could evict its later runtime/end record when subsequent output exceeded
the 256 KiB context budget. The execution selector then treated the remaining
user message as evidence of ongoing execution. A delayed next-turn Hook also
left that old attachment running despite a later persisted start.

## Fix

- Preserve the latest execution evidence within the bound turn and its first
  foreign-turn boundary alongside protected user messages during eviction.
- A later explicit user/start record freezes a still-running old attachment as
  unknown. It neither starts the new attachment nor supplies its body to the old
  inference context.
- Preserve the existing memory ceiling and fail-closed behavior.
- Do not infer completion from silence, elapsed time, or a missing tool result.
- Do not change semantic goal completion/interruption classification, provider
  authorization, or model-call policy.

## Verification

- Final frozen-code full regression: 158 files, 1,881 tests passed; typecheck
  and build passed. The final package's 284 dist files match the build.
- One independent review and one bounded follow-up review passed after adding
  compact metadata retention for maximum-size protected message bodies.
- Regression tests reproduced both failures before the production changes.
- Tests cover retained waiting/interrupted/failed events, repeated reads,
  bounded memory, and delayed next-turn attachment without context mixing.
- The real source-to-goal integration test freezes active work at 3 seconds
  after a persisted end, even when the display clock advances to one hour.
- Read-only replay of a large local session changed from `running` before the
  fix to `waiting` afterward. No raw conversation content or identifiers are
  included in this report; no inference was required for the replay.

## Deployment boundary

The running installed process is not modified by source changes. Installing
and restarting the companion is required to rebuild its in-memory source
cursor and recover lifecycle records already evicted by the previous version.
This fix does not establish why a particular new-turn Hook was delayed or
absent; that is a separate host-to-plugin delivery check.
