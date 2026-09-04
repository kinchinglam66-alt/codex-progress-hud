# SDD ledger — plan: docs/superpowers/plans/2026-09-03-unified-plugin-auto-tracking.md

Baseline: branch `feat/unified-plugin-auto-tracking`, base `73efd2a`; `npm test -- --run` passed 18 files / 354 tests.

Environment ruling: the SDD helper scripts require `/bin/bash`, but this host exposes WSL without `/bin/bash`. Reproduce `sdd-workspace`, `task-brief`, and `review-package` outputs with PowerShell/apply_patch using the same paths and content contracts — this preserves review isolation; cost if wrong: helper output naming may drift and must be checked before dispatch.

## Pre-flight conflict and dependency scan

| Tasks | Producer → consumer / self-check | Finding or ruling |
|---|---|---|
| 1 | capability source/generator/tests | Self-consistent. Ruling: do not bump release version here; generate from the current package version, then let the Node-free packaging phase update every canonical version together. Cost if wrong: an intermediate commit remains version 0.1.0 but internally coherent. |
| 2 | negotiation tests → server/client/tool mapping | Ruling: retain `INTERNAL_ERROR` in the public error union for genuinely unknown failures although the plan snippet omits it; the task text explicitly says unknown failures remain `INTERNAL_ERROR`. Cost if wrong: one additive error enum member persists. |
| 3 | reducer/ETA/calibration tests → pure state implementation | Self-consistent; compatibility parsing of old events is explicitly required. |
| 4 | store tests → bounded multi-task/calibration stores | Self-consistent; live snapshots remain memory-only. |
| 5 | API tests → HTTP/client/Hook schemas | Conflict: lease routes are listed before Task 8 creates lease state. Ruling: Task 5 implements task/Hook/revision APIs only; Task 8 owns lease routes and their tests atomically. Cost if wrong: Task 5 review must recognize the documented dependency ruling. |
| 6 | Hook tests → adapter/entry/config/launcher | Self-consistent after plan correction to Node-free PowerShell launcher. |
| 7 | MCP tests → handle-bound semantic/control tools | Self-consistent; status remains observational. |
| 8 | lease/lifecycle tests → lease-driven process lifetime | Self-consistent once lease routes move here from Task 5. |
| 9 | view/controller tests → multi-task HUD/tray | Self-consistent; no plugin switch is added to UI. |
| 10 | diagnostics tests → diagnostics and human docs | Self-consistent; prose itself is not tested by source-text assertions except obsolete-language scan. |
| 11 | integration/package tests → Node-free release artifacts | Conflict with 2026-09-01 packaging plan's old desired-state/login semantics. Ruling: reuse only packaging mechanics; omit automatic-login and persistent HUD on/off behavior, and make both launchers resolve one installed executable. Cost if wrong: the older plan is no longer executable verbatim. |
| 1 → 2 | generated protocol/version capability → health negotiation | Clean; Task 2 consumes the generated module. |
| 1 → 6 | plugin manifest/validator → Hook declaration and validation | Clean; Task 6 extends canonical validation. |
| 1 → 7 | plugin manifest → default prompts/tool exposure | Clean; Task 7 edits descriptions after identity exists. |
| 1 → 11 | version identity → package contract | Clean; packaging must consume, never rederive, capabilities. |
| 2 → 4 | incompatibility state → aggregate compatibility field | Clean; Task 4 carries the server signal into snapshots. |
| 2 → 5 | HTTP/client contracts → revisioned APIs | Clean; Task 5 preserves structured errors. |
| 2 → 7 | tool error mapping → semantic/control errors | Clean; Task 7 adds task-association codes without collapsing compatibility. |
| 2 → 8 | lifecycle types/protocol → lease mutations | Clean; Task 8 applies protocol and generation guards to lease routes. |
| 2 → 9 | incompatibility flag → HUD banner | Clean. |
| 2 → 10 | compatibility categories → diagnostics | Clean. |
| 2 → 11 | mismatch behavior → end-to-end mismatch test | Clean. |
| 3 → 4 | task/ETA/calibration interfaces → multi-task store | Clean. |
| 3 → 5 | runtime event schema → Hook ingestion | Clean. |
| 3 → 7 | progress/outcome reducer events → MCP reports | Clean. |
| 3 → 8 | lease-loss evidence → disconnected classification | Clean. |
| 3 → 9 | statuses/ETA confidence → presentation | Clean. |
| 3 → 10 | statuses/origin → diagnostics | Clean. |
| 3 → 11 | state precedence → acceptance tests | Clean. |
| 4 → 5 | aggregate store → HTTP/SSE API | Clean. |
| 4 → 7 | task handles/store identity → MCP writes | Clean. |
| 4 → 8 | task/session association → lease loss | Clean. |
| 4 → 9 | aggregate snapshot → renderer/view model | Clean. |
| 4 → 10 | task counts/selection → diagnostics | Clean. |
| 4 → 11 | multi-task behavior → concurrent-session tests | Clean. |
| 5 → 6 | Hook schema/endpoint → command Hook client | Clean. |
| 5 → 7 | aggregate client → per-task MCP tools | Clean. |
| 5 → 8 | authenticated mutation framework → lease endpoints | Clean under the Task 5/8 ruling above. |
| 5 → 9 | selection/visibility/SSE API → UI actions | Clean. |
| 5 → 11 | revisioned APIs → integration tests | Clean. |
| 6 → 7 | injected opaque handle → MCP schema | Clean. |
| 6 → 8 | Hook/MCP entry modes → lifecycle lease behavior | Clean. |
| 6 → 10 | Hook activity/categories → diagnostics/privacy docs | Clean. |
| 6 → 11 | Hooks/launcher → plugin package | Clean. |
| 7 → 8 | MCP lifecycle → lease acquire/renew/release | Clean. |
| 7 → 9 | per-task controls → HUD selected task | Clean. |
| 7 → 10 | reporting skill/tool semantics → usage docs | Clean. |
| 7 → 11 | MCP schema/inventory → package diagnostics | Clean. |
| 8 → 9 | process/task visibility lifecycle → desktop behavior | Clean. |
| 8 → 10 | lease/lifecycle observations → diagnostics | Clean. |
| 8 → 11 | shutdown/restart semantics → packaged acceptance | Clean. |
| 9 → 10 | user-visible states → documented terminology | Clean. |
| 9 → 11 | UI behavior → acceptance tests | Clean. |
| 10 → 11 | install/privacy/recovery guidance → release package | Clean. |

Task 1: minor (deferred): `scripts/validate-plugin.mjs` uses text matching to compare generated TypeScript protocol literals; final review should decide whether parsing the authored JSON plus deterministic regeneration is sufficient.

Task 1: reviewer ⚠️ resolved — the review package was not visible in the reviewer's isolated fork, so it fetched the exact `73efd2a..b3d458e` commit range as permitted by the reviewer template. The implementer report records the expected missing-module RED followed by focused/full GREEN, and the one task commit contains the complete six-file change.

Task 1: complete (commits 73efd2a..b3d458e, review clean; one deferred minor).

Task 2: fix round 1/5 (4 addressed, 0 open — unknown 500 mapping; lifecycle mismatch guidance; peer range negotiation; duplicate error allowlist; commits 5836e38..80959d9).

Task 2: complete (commits b3d458e..80959d9, review clean).

Task 3: pending.

Task 3: Ruling: a `model_outcome.verified` boolean may request verified classification but cannot create validation evidence. Add a separate bounded `validation_observed` core event; only prior observed pass plus a verified completion claim may yield `succeeded_verified` — this prevents self-certification; cost if wrong: Task 7 must emit one additional semantic evidence event and legacy verified-only reports downgrade to unverified.

Task 3: fix round 1/5 (4 addressed, 1 open — quiescent/disconnected/ended ETA text regressed; commits 351bf52..b308e38).

Task 3: Ruling: minimal status-specific ETA text for the three newly added statuses is exhaustive-enum compatibility because the generic “estimating” fallback is factually false. Restore only those branches with tests; defer task switching/banner/layout to Task 9 — cost if wrong: Task 9 may refactor these labels, but current releases remain truthful.

Task 3: fix round 2/5 (1 addressed, 0 open — truthful ETA labels for runtime states; commits b308e38..e9e8e13).

Task 3: complete (commits 80959d9..e9e8e13, review clean).

Task 4: pending.

Task 4: fix round 1/5 (3 addressed, 0 open — aggregate compatibility; follow selection; prune reconciliation; commits 0a92963..f33e890).

Task 4: complete (commits e9e8e13..f33e890, review clean).

Task 5: pending.

Task 5: Ruling: an authenticated missing/unsupported protocol rejection may set only the aggregate `incompatibleClientSeen` diagnostic flag and increment its revision so SSE can display the required banner. This is the explicit spec exception to generic rejection zero-side-effect behavior; task data remains unchanged — cost if wrong: one rejected request produces a local diagnostic revision, but avoids silently losing the required mismatch signal.

Task 5: fix round 1/5 (4 addressed, 0 open; one finding conformed to recorded ruling — duplicate atomicity/revision; raw route traversal; event ID uniqueness; unchanged response; commits 43b76f1..a0978aa).

Task 5: complete (commits f33e890..a0978aa, review clean).

Task 6: Ruling: current official Codex Hooks documentation does not list an `Interrupt` Hook event. Do not register or claim support for it in `hooks.json`; retain core interruption evidence for future supported runtime/manual evidence, and classify present-day unobserved interruption only as suspected/unknown — cost if wrong: direct Interrupt detection is unavailable in this release, but the plugin remains loadable and truthful.

Task 6: Ruling: command Hook context output uses `hookSpecificOutput: { hookEventName, additionalContext }`, not top-level `additionalContext`; plugin commands resolve assets from official `PLUGIN_ROOT`. SessionStart/UserPromptSubmit remain synchronous to return context; SessionEnd is always synchronous and capped at 3 seconds; background mode is used only for output-free events where ordering is safe — cost if wrong: slightly more foreground Hook latency, bounded by short timeouts.

Task 6: fix round 1/1 addressed 2 P1s plus the insecure HMAC fallback (`abb345b..3eb1f31`): launcher fail-open JSON/exit behavior; end-to-end Hook deadline cancellation; explicit secure HMAC keys. Focused 151/151, full 464/464, typecheck/build/plugin validation/diff-check passed; independent fix re-review approved. Packaged dist validation and the full installed-executable launcher smoke matrix remain deferred to Task 11.

Task 6: complete (commits `a0978aa..3eb1f31`, review clean).

Task 7: implementation committed at `d743bdc` (`feat: bind reports to hook task handles`); focused MCP 40/40, lifecycle integration 12/12, full 471/471, typecheck/build/plugin validation/diff-check passed. Independent review found 2 open P1s: unknown controls create orphan tasks, and omitted-title events overwrite established titles. Fix round 1 is in progress.

Task 7: Ruling: opaque task handles are correlation keys in Task 7, not yet a strong authorization boundary. Task 8 must bind permitted handles to the current MCP lease/owner capability and reject cross-session writes with zero task/revision/selection mutation — cost if wrong: aggregate status would let a confused or hostile local MCP caller target another visible task.

Task 7: fix round 1/1 addressed both P1s (`d743bdc..171caad`): unknown controls now return `TASK_NOT_FOUND` with zero mutation; omitted titles preserve established titles. Focused 79/79, full 475/475, typecheck/build/plugin validation/diff-check passed; independent fix re-review approved. One unrelated 90 ms timing test flaked once under combined load and passed 3/3 isolated reruns; track during final full-suite stability checks.

Task 7: complete (commits `3eb1f31..171caad`, review clean).

Task 8: implementation committed at `a6ac24a`. Focused 153/153, full 489/489, typecheck/build/plugin validation/diff-check passed. Independent adversarial review found 5 P1 and 4 P2 gaps: mutation response redaction leak; post-stop reacquire; eager MCP startup; pre-404 handle claim; automatic-login acceptance gap; expired-release transition; wall-clock rollback; concurrent reacquire leak; stale explicit lease retry. Single fix round is in progress; no Task 9 UI, Task 10 docs/diagnostics, or Task 11 packaging changes.

Task 8: fix round 1/1 committed at `29bba65` (`fix: harden mcp lease isolation`); focused 87/87, relevant 368/368, full 497/497, typecheck/build/plugin validation/diff-check passed. The single fix re-review was resumed after one infrastructure 404 and remains BLOCKED: 2 P1s (MCP-marked Hook route lacks per-handle lease authorization; legacy `desiredState: off` suppresses the first ordinary write before migration) and 2 P2s (unknown-control protocol check ordering; wall-clock clamp is not a true elapsed monotonic clock). Per the global one-fix-review discipline, no second repair cycle or Task 9+ work begins without explicit user authorization.

Task 8: user explicitly authorized an exceptional second fix round on 2026-09-04. Scope is limited to the remaining 2 P1 and 2 P2 findings above, with fresh adversarial RED tests and one bounded security re-review; Task 9+ remains paused until approval.

Task 8: exceptional second fix committed at `19966b8`; focused 84/84, relevant 314/314, serialized full 503/503, typecheck/build/plugin validation/diff-check passed. Final `gpt-5.6-sol medium` review verified 3/4 findings closed but found one P1: the legacy migration attempt flag is committed before migration succeeds, so timeout/cancellation makes later writes permanently skip migration.

Task 8: user explicitly authorized a third pinpoint fix on 2026-09-04. Scope is only retryable legacy-off migration after transient failure while preserving close/generation authority, followed by one bounded `gpt-5.6-sol medium` re-review. Task 9+ remains paused until approval.

Task 8: third pinpoint fix committed at `b8363fb` (`fix: retry interrupted legacy migration`); lifecycle 65/65, related serialized 315/315, serialized full 504/504, typecheck/build/plugin validation/diff-check passed. An initial final-review agent failed due backend 403 before producing work; an equivalent replacement `gpt-5.6-sol medium` review found no important issues and independently passed focused 4/4, lifecycle 65/65, related serialized 334/334, typecheck and diff-check. One Windows `ENOTEMPTY` fixture cleanup flake passed immediately unchanged; no product assertion failed.

Task 8: complete (commits `171caad..b8363fb`, final security review approved).

Task 9: implementation committed at `0bb5e25` (`feat: show multi task progress in hud`); focused 35/35, full 509/509, typecheck/build/plugin validation/diff-check passed. Independent review found 5 P1s (missing renderer protocol/generation headers; production auto-show not wired; X-hide not persisted through visibility API; concurrent mutation response/revision corruption; tray selection always unchecked) and 1 P2 accessibility gap. Single fix round is in progress with `gpt-5.6-luna high` because it crosses UI/HTTP concurrency boundaries.

Task 9: fix round 1/1 committed at `bad8418` (`fix: close task 9 progress hud review findings`); focused 124/124, full 517/517, typecheck/build/plugin validation/diff-check passed. Fix re-review verified bootstrap/header logic, normal auto-show/terminal behavior, renderer intent serialization, tray projection, and accessibility, but remains BLOCKED on 2 P1s (static HTTP allowlist cannot serve the new renderer-imported modules; tray/X-hide desktop mutations are not globally ordered) and 1 P2 (window recreation may ignore server-hidden selected task). Per the global one-fix-review discipline, Task 10+ does not start without explicit authorization for a second bounded Task 9 correction.

Execution-policy ruling on 2026-09-04: the user's newer instruction is to avoid interrupting the overall task. There is no repository-level `AGENTS.md`. Interpret the global “prefer/at most one fix review” as the routine default; when a review produces concrete blockers, continue automatically with another strictly bounded TDD correction rather than requesting permission each round. The 30-minute no-material-progress rule stops/replaces only the stalled subagent and does not stop the project when safe progress remains.

Task 9: second bounded fix round in progress, limited to static serving of imported UI modules, global ordering of desktop tray/X-hide mutations, and honoring server-hidden state on window recreation.

Task 9: second bounded fix committed at `00cd9eb` (`fix: close task 9 remaining review findings`); focused 103/103, related 272/272, serialized full 522/522, typecheck/build/plugin validation/live built-module graph/diff-check passed. Independent re-review approved all three remaining findings and found no Task 8 or one-switch regression.

Task 9: complete (commits `b8363fb..00cd9eb`, review approved).

Task 10: in progress.

Task 10: implementation committed at `45ba6e0`; independent review found missing production wiring, incompatible/offline misclassification, ignored historical mismatch, ignored Hook expectation, and documentation inconsistencies. First bounded fix committed at `f859a66`; fix re-review verified the main wiring and compatibility fixes but found production Hook trust/activity still derived from selected-task generic evidence plus one stale `PRIVACY.md` paragraph. Per the user's continuity ruling, a final local TDD correction is in progress: Hook receipt becomes global content-free HTTP-boundary state, no-activity trust remains unknown, and all lifecycle wording is aligned.

Task 10: final local correction verified with focused 208/208, serialized full 529/529, typecheck, build, plugin validation, and diff-check. Hook activity now comes from the authenticated HTTP Hook boundary rather than selected-task evidence; absent activity does not fabricate an untrusted verdict; privacy/control wording is aligned. Task 10 is complete after the final correction commit.

Task 10: complete (commits `00cd9eb..4a8b674`; final correction verified locally).

Task 11: complete locally (implementation commits `f5c0184`, `d3c108b`; final report commit follows). Windows x64 installer and deterministic 13-file plugin ZIP were generated without installing or publishing. Final release gate passed 36 files / 545 tests plus typecheck/build/source smoke/plugin sync/plugin validation/package contract; real packaged HUD and native Node-free MCP bridge passed with all 14 tools; production dependency audit reported 0 vulnerabilities. PowerShell's long-lived redirected-stdin EOF behavior required the release `.mcp.json` to use the source-backed native C# bridge while both planned PowerShell launchers remain staged and validated. Artifacts and limitations are recorded in `task-11-report.md` and `docs/superpowers/reports/2026-09-04-unified-plugin-auto-tracking-release.md`.

Task 11: final release/security review rejected the initial range with 2 release blockers, 3 important risks, and 2 minor findings. A bounded TDD fix round is in progress for direct-map MCP discovery, Hook-started zero-lease shutdown, `Interrupt`, source-built native release bridging, pinned Actions/official npm registry, Hook version synchronization, and dynamic release artifact names. No install, merge, push, tag, or publication occurs during this round.

Task 11: final-review fix round is implemented locally. The new regression set passed 38/38 before expansion; the serialized release gate then passed 36 files / 548 tests, typecheck, build, source smoke, native-launcher integrity, plugin sync/validation, and package contract. Fresh Windows artifacts passed packaged HUD + all 14 tools and packaged MCP initialize/tools-list. A single bounded fix re-review remains before Task 11 can be marked approved.

Task 11: bounded re-review identified one additional official-contract issue before concluding: `Interrupt` cannot emit the generic `continue` field. TDD coverage now requires `{}` on both success and fail-open paths across the TypeScript runtime, PowerShell launcher, and native launcher. Focused 37/37 and serialized full 551/551 passed; final Windows artifacts and packaged MCP/HUD smokes were regenerated and passed. The same re-review is continuing over the updated endpoint.

Task 11: complete and approved. The single bounded `gpt-5.6-sol medium` fix re-review approved `4856141..9e75e07` with no remaining material release, security, architecture, lifecycle, concurrency, trust-boundary, packaging, or documentation findings. Remaining publication checks are intentionally external/manual: real Codex install/enable/restart and tool discovery, both NSIS uninstall data-retention paths, and trusted Authenticode signing. No install, merge, push, tag, or publication was performed.

Task 8: exceptional second fix committed at `19966b8` (`fix: close task 8 lease re-review findings`); focused 84/84, relevant 314/314, serialized full 503/503, typecheck/build/plugin validation/diff-check passed. Final security re-review (`gpt-5.6-sol medium`) verified Hook lease authorization, protocol ordering, and monotonic TTL fixed, but found 1 remaining P1: `legacyMigrationAttempted` is set before migration succeeds, so a transient timeout/cancellation leaves later writes permanently suppressed by legacy `desiredState: off`. Task 8 remains BLOCKED; Task 9+ does not start without explicit authorization for a third bounded correction.

Task 8: fix round 1/1 implemented at `29bba65`: all 5 P1 and 4 P2 findings addressed, plus self-review tightened unknown-control 404 to precede every lease expiry transition. Focused adversarial 87/87, relevant lifecycle/server/MCP/desktop/integration/Hook 368/368, full 497/497, typecheck/build/plugin validation/diff-check passed. No unverified PID termination or Task 9–11 implementation changes.

HUD observation before Task 1: legacy `task_status` reached the companion and returned `{task:null,eta:null}`; legacy `tracking_start` then returned the known generic “not reachable” message. Tracking is not active. This is the protocol/generation misclassification reproduced for Task 2, not evidence that the companion is absent.
