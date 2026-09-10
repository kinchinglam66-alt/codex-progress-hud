# Current-turn ETA and lifecycle repair

## Scope

ETA now targets the authenticated current execution turn, not a project spanning future user turns. Earlier context is marked as background. Each new turn resets active time, prediction, summary, and per-turn measurement identity; session-level accounting and authorization remain unchanged.

Persisted completion, interruption, and failure remain distinct from generic waiting. Explicit terminal events control the current-turn outcome and fence late observer results. A terminal event for an older turn must not clear the reader's newer active-turn attribution.

For an already-bound verified local conversation, a persisted new start after a terminal turn can recover a missing prompt Hook. Router ownership is synchronized independently of trimmed source context. Manual pause/stop and identity-cap degradation remain in effect. Terminal source retention is bounded to fifteen minutes; this is not unrestricted historical conversation discovery.

HUD lifecycle labels refer to the current turn. The observer instruction asset and its integrity pin are updated together.

## Verification

Initial full regression exposed an obsolete cross-turn summary expectation and a Windows ACL test timeout. The expectation was replaced with a fresh-turn summary and active-time assertion. The ACL group passed unchanged when rerun separately. Another intermediate run encountered a ledger test timeout; that group also passed unchanged separately. These failures are retained as test evidence, not counted as passing runs.

Focused verification includes lifecycle/source/router regressions, the scheduler's fresh-turn contract, and current-turn UI labels.

- Full regression after the main review fixes: 158 files, 1,892 tests passed, exit 0. Command: `npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000`. The timeout flag changes only the test harness allowance, not product timeouts or assertions.
- The single follow-up review identified one remaining manual pause/stop ordering race. Two new regression cases failed before correction. The guard was moved before source takeover, while failure/interruption still allow a verified next turn.
- After that final guard change: four lifecycle/source/router test files, 68 tests passed. This is focused post-change evidence; the 1,892-test full run predates this last narrow correction and is not represented as a full run of the final revision.
- Current-turn UI coverage: nine files, 103 tests passed. Scheduler fresh-turn coverage: 76 tests passed. Final typecheck, build, and whitespace checks passed.

One implementation review and one follow-up review were used. The final follow-up finding was corrected locally and regression-tested; no additional independent review approval is claimed.

Final integration milestone (2026-09-10): the complete final code, including the manual pause/stop correction, passed 158 files / 1,894 tests in 319.66 seconds, exit 0, using the same 15-second test-harness allowance. Typecheck, build, plugin configuration validation, and release package-contract validation also passed. All implementation-plan checkboxes are complete. This supersedes the earlier partial verification boundary, not the installed end-to-end or ETA-accuracy boundary.

## Deployment boundary

Implementation validation did not require real observer inference or credential changes. The user authorized main integration, push, and subsequent local installation after the final checks. Local tests do not establish ETA accuracy or installed end-to-end recovery. Installation must update the external observer instruction resource together with the application archive, preserving user authentication and configuration. Machine-specific installation records and backups remain private.
