# Native Fork Context Implementation Plan

## Current checkpoint — r10 role-qualified diagnostic

See `../reports/2026-09-15-native-role-qualified-evidence.md` (report filename in this reports directory for audit readers). Role-qualified prompts passed two matched checkpoints; the third history call could not retrieve the tool identifier after opaque native compression. r10 stopped at 5 ETA + 1 compression, 72,623 known tokens + one completed unknown-usage compression, all cleanup confirmed. The two native preparation samples were 18% and 43% slower than history. No native promotion, installation or further trial is justified by this result. Focused 29 tests, typecheck, build and whitespace check passed; previous full 2,718-test milestone remains historical, not rerun here. A direction decision is being proposed: deliver the verified common account cache on the existing route first, or separately redesign native lifecycle/compacted-history handling. This is the first turn of that new decision, not an accumulated blocker from earlier approvals. Preserve r10 and all prior audits; do not open r11 on automatic continuation without an evidence-based approved next design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce context preparation and first-valid-ETA latency without interfering with the source task.

**Architecture:** The trusted reader supplies an immutable native rollout snapshot. An independently authenticated, tool-disabled runtime forks it, clears inherited goals, and answers a small current-turn timing request. Local state/timing remains authoritative; existing import/API paths remain compatible.

**Tech Stack:** TypeScript, Node 24, Vitest, Codex app-server 0.153.4, Windows/Electron.

**Spec:** `docs/superpowers/specs/2026-09-14-native-fork-context-design.md`

## Global Constraints

- 已确认设计；每次配对实验最多 6 次 ETA 调用与 6 次必要压缩，只发送合成历史，模型 `gpt-5.6-luna / medium / 标准速度`。2026-09-15 用户随后授权本工作必要的模型调用，无须逐次询问；每次实验仍使用独立且不可重开的审计，不盲目重试。
- 真正失败、退出不明或隔离失败立即停止真实调用，不追加付费重试。
- 完成且用量未知保留记录，不把未知用量等同调用失败。
- 不读取主账户凭据做认证、不修改主配置、不训练、不推送、不在验收前替换安装版。
- 受支持二进制 SHA256：`CCDC9EB9DD71FBCFB03AD42C4ECA2B0D6FF6FBD32EBE9416550E6244561E559B`。
- 三个有效配对中准备时间中位数至少降低 30%；首次有效 ETA 中位送达时间不增加，无未解释的用量增长或续估退化，才切换默认。
- 当前隔离分支 `feat/persistent-eta-session`；实现基线 `8504c47`，设计提交 `1fb0e74`。
- Test first; focused tests during work, one full serial regression at milestone. One final security/accounting review, at most one fix review, per user policy.

## File responsibilities

- `src/estimation/observer-native-fork.ts`: fork request, goal-clear verification, source/fork identity fencing. No authentication ownership or inference outside caller.
- `src/observer/native-source-snapshot.ts`: trusted fixed-watermark opaque copy and disposal; no semantic repacking.
- `src/observer/local-session-reader.ts`, `src/server/passive-goals.ts`: resolve native source through existing trusted thread/ticket identity only.
- `src/estimation/observer-persistent-session.ts`, `observer-persistent-worker.ts`: reuse existing terminal/usage handling; native session initialization replaces import only for verified native input.
- `src/estimation/observer-scheduler.ts`: choose native input without scanning parsed history; maintain turn/generation and active-clock fences.
- `src/desktop/observer-pilot.ts`: capability-bound worker composition, compatible fallback before dispatch only.
- `src/estimation/native-context-metrics.ts`: bounded public stage metrics and paired gate calculation.
- Tests mirror each module; synthetic runtime harness under `scripts/diagnostics/native-fork-preflight.mjs`.

### Task 1: Establish a fail-closed native protocol boundary

**Files:** Create `src/estimation/observer-native-fork.ts`, `tests/estimation/observer-native-fork.test.ts`, `scripts/diagnostics/native-fork-preflight.mjs`.

**Interfaces:** Consume existing `SessionRpc`; produce `forkObserverThread(rpc, {sourceThreadId, path, cwd, baseInstructions, developerInstructions}, signal): Promise<{threadId:string}>`. Caller owns trusted paths, invocation, admission and process closure.

- [ ] Write failing contract tests: fork never starts a turn; requires a new ID; goal clear/get succeeds before returning; malformed/retained goal rejects; aborted operation never returns ready.

```ts
const result = await forkObserverThread(rpc, source, signal);
expect(result.threadId).toBe('fork-id');
expect(sent.map(x => x.method)).toEqual(['thread/fork','thread/goal/clear','thread/goal/get']);
// Fake RPC is the external boundary; reject every unexpected method.
```

- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run tests/estimation/observer-native-fork.test.ts --maxWorkers=1 --no-file-parallelism`; confirm missing behavior fails.
- [ ] Implement fork parameters with `ephemeral:false` (user-approved protected disk-backed amendment), `excludeTurns:true`, `deferGoalContinuation:true`, no `lastTurnId`, explicit read-only cwd/model/provider/standard tier/trusted instructions. Reject source-equal returned ID before clear. Require explicit `{goal:null}` after clear. Retain owned-path/confirmed-exit cleanup and crash-recovery evidence.
- [ ] Run focused tests and an auth-free no-inference real-runtime harness: create only synthetic source, include in-progress current turn/tool/image/checkpoint records and active goal; inspect fork history and goals without `turn/start`; compare source before/after; close owned process.
- [ ] Stop native rollout integration if inherited capabilities/current-turn coverage cannot be verified; record evidence and remaining decision. Do not treat schema support alone as passing.
- [ ] Commit only task files after verified tests: `git commit -m "feat: fence native observer fork initialization"`.

### Task 2: Trusted fixed-watermark native source lifecycle

**Files:** Create `src/observer/native-source-snapshot.ts`, `tests/observer/native-source-snapshot.test.ts`; modify local reader and PassiveGoals plus their tests.

**Interfaces:** `NativeSourceSnapshot` carries `kind:'native'`, `sourceThreadId`, `sourceEpoch`, `revision`, `byteLength`, `path`, `close():Promise<void>`; path stays internal. Reader exposes `nativeSnapshot(threadId,signal)`. Goals exposes `openNativeSource(ticket,signal)` with current turn ID and unchanged before/after ticket fences.

- [ ] Write temp-file tests proving late append is excluded, partial final line excluded, replacement/truncate/reparse/out-of-root rejected, cancellation removes only owned copy, dispose idempotent.

```ts
const snapshot = await reader.nativeSnapshot('known-thread', signal);
await appendFile(sourcePath, lateRecord);
expect(await readFile(snapshot.path,'utf8')).toBe(frozenCompleteRecords);
await snapshot.close();
expect(await exists(snapshot.path)).toBe(false);
```

- [ ] Run focused tests and observe expected missing-interface failure.
- [ ] Resolve from trusted reader discovery, attest path chain and file identity, record fixed byte size, copy through last complete newline in bounded chunks into user-protected exclusive directory, recheck source identity/size. Never parse/re-emit all messages. Enforce supported size or explicit unsupported result, not truncation.
- [ ] Fence ticket before and after copy; close discarded copies; run focused tests. Commit task slice.

### Task 3: Native worker and accounting ownership

**Files:** Modify persistent session/worker and their test files; modify desktop composition and runtime capability tests.

**Interfaces:** Worker exposes `contextKind:'native'|'history'`; native preparation takes `{snapshot:NativeSourceSnapshot,currentTurnId:string}`. Existing history input retains its existing contract. Session adopts only a verified fork ID and resets token baselines/cursors before reuse.

- [ ] Add failing tests for native worker avoiding `records()`/inject, owner admission before possible model work, inherited-goal rejection, unknown usage after confirmed compaction, account switch, cancellation and failed cleanup.

```ts
await worker.prepareNativeContext(input, {snapshot,currentTurnId:'turn-2'}, signal,key,generation,at);
expect(importedRecordCount).toBe(0);
expect(readyOwner.sourceTurn).toBe('turn-2');
```

- [ ] Run focused session/worker tests; verify new assertions fail for missing path.
- [ ] Reuse existing process identity/receipt/accounting facilities. Call task-1 initializer only after validated task-2 snapshot. Explicit ETA remains the existing structured response parser. Dispose fork and copy; healthy process reuse allowed. Re-estimates take new snapshots, not an assumed live-sync fork.
- [ ] Pre-dispatch unsupported source/runtime can select compatibility with a reason. Once model work may have begun, fail without a second hidden compatibility inference. Exercise both branches and existing owner/concurrency tests; commit slice.

### Task 4: Scheduler fast path and genuine time boundaries

**Files:** Modify `observer-scheduler.ts`, `passive-goals.ts` and scheduler/goals tests; adjust research recorder adapters only where necessary.

**Interfaces:** Task-3 worker selects task-2 native source; history-only workers retain `openHistory`. Preserve existing forecast generation/turn/active-clock identity.

- [ ] Add failing integration tests: native scheduling succeeds with `openHistory` throwing if called; paused/new-turn results rejected; research missing fields cannot block ETA; a prediction expired before arrival is recorded but not accepted/displayed as numeric ETA or forced to 99%.

```ts
clock.advanceActiveSeconds(70);
finishModel({remainingSeconds:60,errorPercent:50});
expect(display.numericEta).toBeNull();
expect(record.rawSeconds).toBe(60);
expect(display.progress).not.toBe(99);
```

- [ ] Run focused scheduler/goals suites; confirm intended red tests.
- [ ] Branch before unconditional history scan. Capture bounded fresh state after preparation without moving the original time anchor to arrival. Keep local pause/end/generation authoritative. Record unavailable research fields explicitly, no forced scan. Preserve bounded recovery/monotonic progress and per-task concurrency.
- [ ] Verify native and compatibility integration, then commit slice.

### Task 5: Phase metrics and bounded paired validation

**Files:** Create `src/estimation/native-context-metrics.ts`, matching tests; add synthetic comparison harness and sanitized report under `docs/superpowers/reports/2026-09-14-native-context-comparison.md`.

**Interfaces:** Phase record includes queue, account/process, snapshot, fork/import, compaction, inference, delivery durations; strategy/version, age, known/cache tokens, unknown count. `evaluateNativeContextPairs(pairs)` requires three valid matched pairs and returns pass/reasons.

- [ ] Tests reject incomplete pairs, missing stages, unmatched histories, slower delivery, less-than-30% preparation improvement; hand-calculated passing example preparation `[100,100,100]` vs `[60,60,60]`, delivery `[150,150,150]` vs `[110,110,110]`.
- [ ] Implement metrics without paths/text/accounts in public outputs. Include snapshot copy and all preparation costs; distinguish cold and warm process state.
- [ ] Run paired synthetic long-history checks in alternating order, only after task-1 isolation passes. Track cumulative count before every ETA/compaction; stop at 6/6 cap or real failure. Preserve unknown completed usage; never fabricate zero tokens.
- [ ] Record pass/fail and evidence limits. Enable native default for pinned supported runtime only if every gate passes. Commit sanitized report and tested code, not private snapshots.

### Task 6: Final regression, risk review and candidate

**Files:** Build outputs and final sanitized verification report; update spec/plan status accurately.

- [ ] Run `D:/node.exe node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism` once at milestone, plus `D:/npm.ps1 run typecheck` and `D:/npm.ps1 run build`.
- [ ] One `gpt-5.6-sol / medium` review of new source/auth/tool/ledger/freshness boundaries; at most one fix review. Keep all personal outputs out of Git.
- [ ] Build candidate using existing packaging process only after tests and performance gate; verify candidate identity and metadata. Do not replace installed app yet.
- [ ] Report actual measured latency, test counts, known and unknown usage, default route decision and remaining blockers. Only then request installation disable confirmation if candidate passed.

## Execution record

**Current checkpoint, superseding chronological entries below (2026-09-15):** written cross-request design approved and 30-second account-result reuse implemented, with independent one-use handles and unchanged local guards. Current full regression started 14:01:49 local: **224 files / 2718 tests passed**, exit 0, 371.93 seconds; final typecheck/build and bounded review/fix review passed. Final no-model preflight: 3 prepares/2 full reads/1 hit; cold5278ms vs warm1053ms, all proofs and cleanup confirmed. This common account-preparation gain is not native structural gain; comparison explicitly bypasses cache on both strategies. R9 still has only one validated pair then early-marker mismatch; three-pair/warm/new-turn/performance gates remain unpassed. Native stays diagnostic-only; no candidate, default promotion, merge, push or installation. No approval blocker remains for this cache subtask. See `docs/superpowers/reports/2026-09-15-native-acceptance-audit.md`; old chronological entries below are not current.

**Current verified checkpoint:** full serial regression completed **219 files / 2,657 tests**, exit 0, 378.15 seconds (2026-09-15 09:28:53 local start); current typecheck/build/syntax/diff checks passed. Native instruction propagation and correct synthetic source-goal scope are implemented. R8 live reliability/performance gates below remain failed/incomplete; no default promotion, candidate, merge, push or installation. Next required design decision: reduce repeated account-preparation cost without weakening account/route invalidation, per-operation authorization or accounting. Do not reopen any spent model audit or mark the goal achieved from local regression alone.

**Latest outcome — r8:** one completed compaction + two completed ETA operations, then early-marker retention failed on native. Zero validated pairs; no warm/new-turn result, promotion or candidate. Raw complete preparation: history 10.61 s, native 12.11 s; do not claim median speedup from an invalid pair. Accounting: 25,670 known tokens + one unknown compaction, no unresolved/in-flight records, cleanup confirmed. R4–r8 total: six ETA calls, one compaction, 67,088 known tokens plus unknown compaction usage. All original evidence preserved. Both routes repeat full account inspection before preparation and observe (four rate-limit reads per ordinary ETA); optimizing that attestation boundary requires a separate design/risk decision, not removal of authorization/ledger checks. Full regression of current fixes is running; no more live calls planned in this checkpoint.

**r7 validated / r8 comparison:** full native policy restored schema validity in r6, but an expired one-second prediction exposed a separate harness goal-scope mistake. A TDD fixture correction supplies the actual source CSV goal instead of the observer evidence request; v5 r7 then returned a valid 600-second ETA with all markers/image verified (11,015 known tokens, no unknowns/compaction, cleanup confirmed). This is synthetic context functionality, not accuracy or speedup. R8 runs three matched pairs under continuing authorization, with strict performance/default gates retained. See report for r6 rejection and complete usage; no prior records erased or installed route changed.

**Latest status — 2026-09-15 continuing grant:** user authorized necessary further model calls; earlier per-run permission blockers below are historical, not active. r4/r5 native-only calls isolated completed-status/non-null-estimate consistency failure (19,383 known tokens total, no unknown usage, confirmed cleanup). Native fork had overwritten the complete pinned observer policy with a short supplement. The TDD correction explicitly propagates the verified full policy and refuses a missing native policy before fork; source trust and strict validation remain intact. 104 focused tests plus typecheck/build/syntax/diff checks passed. r6 is a single-call synthetic verification, not a matched performance run. Full suite must be rerun at the next milestone; native effective-context, three paired measurements, default promotion and candidate gates are still open. Existing audits and installed application remain unchanged.

**2026-09-15 third grant/run:** user renewed the v3 synthetic 6/6 grant; fixed r3 authority preserves r1/r2. Preflight and 45 focused tests/build passed. Actual run: 1 compaction + 2 ETA admissions; history ETA retained all markers/red image, native result had known usage but null interpretation (`process_error`). Stopped without retry; 0 valid pairs; 24,193 known tokens plus 1 compaction usage gap; no new unresolved admission and cleanup confirmed. Local diagnostic-only output/terminal categories added and verified by 39 focused tests/typecheck/build. No raw response survives to distinguish JSON/schema/runtime terminal causes. Native validity, paired performance, promotion and candidate gates remain incomplete; r3 cannot be reopened. See the report's third-run section; no install or default change.

**2026-09-15 latest verification:** complete elevated serial regression passed **219 files / 2,647 tests**, exit 0, 384.20 seconds (start 07:40:39 local). Before that run, two no-model identity preparations measured 4,583 / 4,030 ms, primarily account-reader work, with confirmed cleanup. The current stopped-audit authorization blocker has recurred across the authorized run and two subsequent goal continuations. Safe local fixture, transport, metadata timing and full-regression follow-ups are complete; the next required paired model validation needs a new explicit bounded grant. The goal is not achieved, no default/candidate/install is eligible, and original audit evidence remains intact.

**2026-09-15 local follow-up:** verified exact image bytes through the real local reader/worker/session import boundary, without inference; replaced the one-pixel synthetic visual probe with 256x256 opaque red under a new v3 comparison version, keeping the red gate and both spent authorities unchanged. Focused 84 tests plus typecheck/build/script syntax passed. Static call-graph inspection found two independent metadata preparations per prepare-plus-observe and four rate-limit reads; native inheritance does not eliminate this common cost. No account/authorization fence was weakened. Further real paired measurements and any account-preparation architecture change remain open; no default promotion or candidate.

**2026-09-15 renewed authority:** user authorized another separate fixed 6-ETA/6-compaction synthetic audit. The prior audit/ledger were preserved. Focused 42 tests, typecheck/build/script syntax and no-model preflight passed. The new audit completed 1 compaction (unknown usage) + 1 history ETA (14,789 known tokens), then stopped without retry because the 1x1 red image was described as pale orange; all three text markers were retrieved. Zero matched pairs, no native ETA dispatched, cleanup confirmed, no unresolved new admission. Local source bytes verify opaque red, not a unique explanation of the model answer. Tasks 1/5 performance and effective visual-context gates remain incomplete; Task 6 remains unpromoted. See the report's second-attempt section for timings and next diagnostic direction. This is not a release or installation authorization.

**Subsequent local verification:** after the diagnostic event-classification correction, a fresh complete elevated serial run passed **219 files / 2,644 tests** (362.56 seconds), with typecheck/build/script syntax passing. No new real model operation was authorized or dispatched. The fixed spent trial authority and original unknown/unresolved evidence remain intact. Paired performance validation still requires renewed user authorization; local verification does not fulfill that gate or authorize installation.

**Current status (latest 2026-09-14 continuation):** Tasks 2–4 and diagnostic composition are implemented; Task 1 effective model-context proof and Task 5 paired performance gate remain incomplete. Stable full regression passed 218 files / 2,625 tests, and the one consolidated sol/medium fix review approved a single controlled synthetic run. That audit completed one synthetic compaction and made one unconfirmed ETA attempt, then stopped with no valid pair and no retry. The diagnostic event classifier had a definite passive-message false-positive defect; its local correction plus bounded event logging passed 24 focused tests, typecheck and build. The original failed trace does not identify its exact item type, so this is not proof of the failure's unique cause. Original diagnostic usage/receipt/audit records are retained (one compaction unknown plus one unresolved ETA); actual process cleanup confirmed. Installed routing/configuration/account/ledger remain unchanged. Another paid trial needs renewed user authorization; do not reset the original trial by choosing another directory or silently retry. See `docs/superpowers/reports/2026-09-14-native-context-comparison.md`. No performance improvement or overall completion is claimed; Task 6 has no promoted default or installable candidate.

- User approved design and controlled tests on 2026-09-14.
- Focused baseline: 3 files / 140 tests passed; full baseline session 71737 running at plan creation.
- Start with task 1 locally because it gates all integration. Tasks 2–4 are tightly coupled; bounded sidecar implementation is permitted only with disjoint files and explicit interfaces. User model/review limits override skill defaults.
- Baseline completed: 201 files / 2,488 tests passed. New fork contract 9 tests passed after RED; build passed.
- Task 1 remains incomplete: runtime rejects `deferGoalContinuation + ephemeral` with RPC -32600. Synthetic disk-backed control creates a fork and clears its goal; production persistence amendment requires user decision. No live-model budget spent. See `docs/superpowers/reports/2026-09-14-native-fork-preflight.md`.
- Tasks 2–6 have not been dispatched or implemented. Installed routing remains unchanged. Do not mark the architecture objective complete from these prerequisites.
- User subsequently confirmed the protected disk-backed amendment. Resume implementation; the prior approval blocker is resolved. Source snapshot/fork storage must be ownership-fenced and cleaned only after confirmed closure; uncertain exits defer cleanup to recovery. No extra model budget authorized.
- Subsequent progress: source primitive, trusted reader/goal routing, native session startup, fork custody primitive and phase metrics implemented. Latest combined focused run: 12 files / 171 tests passed; typecheck/build passed. No model calls, commit, merge, push or install performed. See updated preflight report for evidence boundaries.
- Task 1 protocol/storage-level checks now pass on the pinned runtime, including active goal suppression and fork-only cleanup; effective model instructions/tools/checkpoint completeness still gate live calls. Task 2 reader uses the already-observed complete byte watermark and verifies native/source turn agreement; protected production storage and crash snapshot ownership still need integration. Task 3 has session startup and custody primitives only; production worker/scheduler routing is not implemented. Task 5 metrics are implemented, no real paired measurements yet.
- Next critical path: complete native worker resource composition (existing independent authentication, real PID/birth identity, receipts, durable ownership of both copy and fork); then scheduler fast path and freshness. Do not fake source record counts/completeness, import native history twice, or release resources on an unconfirmed owner exit. Read report before interpreting old blocker notes as current.
- Later continuation supersedes the preceding worker/scheduler status: native worker route, scheduler bypass, one-shot post-preparation scalar clock supplement, expired-on-arrival rejection and bounded recovery are implemented and focused-tested. Full milestone: 2,544 pass plus 4 sandbox-only custody EPERM failures; custody's full 5-test file passed with elevated parent-path access. See report for exact scope. Desktop composition, durable raw snapshot recovery, effective context/isolation validation, phase instrumentation, paired calls and final gates remain incomplete. Installed route is unchanged; 0/6 ETA and 0/6 compactions consumed.
- Native storage ACL helper has 3 passing Windows filesystem tests; snapshot custody slice assigned to Kant (`01a0a03b-b974-76f3-a904-f59e96207325`, luna/high), brief/report under this plan's `.superpowers/sdd/2026-09-14-native-fork-context` directory. Do not redispatch this work while the agent is active. User's one final sol/medium review and at-most-one fix review limit remains controlling; no final review has run.
- Later resource milestone: Kant completed the one fix pass plus the `copySettled` hook (30 focused tests passed) and was closed. Concrete native resources now own protected raw snapshots, process identity and fork cleanup, with a copy-completion barrier and worker release serialization. Storage 4/resource factory 4/identity runtime 24 tests passed. A desktop in-process trial option composes real resources without changing normal startup. Auth-free real-resource preflight on 194,470 synthetic bytes passed with ~5.06 s preparation and ~3.52 s subsequent cleanup; source unchanged and custody empty. See report for a prior diagnostic-only goal-configuration failure and retained synthetic artifacts.
- Metrics now count native cold restarts against the warm baseline and require warm evidence; 10 tests passed. The strict phase clock has 3 passing tests but still needs live-harness integration. No actual native/history paired model measurement, final risk review or candidate yet. Native source-format/capacity and effective-context/isolation gates remain open. Budget remains 0/6 ETA and 0/6 compactions; do not install or declare the latency objective complete.
- Focused resource integration regression: 13 files / 168 tests passed. Later source-envelope pin tests passed in a 28-test source/resource subset; native destination requires the tested 0.153.4 legacy envelope (metadata pin only, not full semantic proof). Worker phase hooks plus phase clock passed 54 tests and cannot make diagnostic exceptions interrupt work. A durable fixed-run six-ETA/six-compaction diagnostic budget guard passed 3 tests; it remains to be wired alongside the real ledger in the synthetic paired harness. No real calls have been made. Immediate next work is that harness and its effective-context/isolation checks, not another resource helper or broad refactor. Existing final review and installation gates remain unchanged.
