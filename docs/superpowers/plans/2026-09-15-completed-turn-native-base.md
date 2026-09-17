# Completed-turn Native Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 原生继承已结束轮次，完整补齐当前轮固定前缀，减少同轮重复全历史准备，并用不降低的内容、隔离及性能门槛验证。

**Architecture:** 来源读取器建立可信轮次索引并返回基底边界＋固定补充视图。每代次只建立一个不执行模型的原生历史基底，每次 ETA 从该基底新建自有分支，再导入完整本轮前缀。账户和账本仍按每次模型操作验证。

**Tech Stack:** TypeScript ESM、Node >=22.13.0、Vitest、Windows PowerShell、固定 Codex app-server 0.153.4；不增加依赖。

**Spec:** `docs/superpowers/specs/2026-09-15-completed-turn-native-base-design.md`（用户已确认）。

## Global Constraints

- ETA 只预测当前主任务轮次从采样点到该轮结束所需的剩余实际工作时间；用户等待、暂停不计入。
- 基底不执行 ETA、探测或工具，不接收当前轮补充，也不接收任何估时回答。
- 每个新估时分支追加该次完整本轮前缀，而不是仅追加自上次估时以来的差量。
- 不增加全局模型并发限制。现有每代次最多 3 个估时请求、64 MiB 已知资源回收阈值、空闲 60—1860 秒规则保持不变。
- 继续沿用原生源 8 MiB 已验证上限；本切片不扩大来源权限、删除账本或更改账户哈希/ACL 校验。
- 未知用量不是零；所有真实 ETA 和压缩单独准入记账。模型 gpt-5.6-luna / medium / 标准速度。
- 内容与隔离全部通过；3 个有效配对的完整准备中位数至少改善 30%，首次有效 ETA 中位送达时间不增加，无未解释的 token 增长或续估退化。
- 不改安装版、不推送、不合并、不发真实私有历史。小样本内容与性能验证不等同于 ETA 准确度。
- 保留工作树内此前全部已修改/未跟踪文件；只提交本切片确实拥有的变更，不使用 git add -A。
- 按用户全局策略：实现 gpt-5.6-luna medium/high；最终架构/账户/账本复审 gpt-5.6-sol medium。一轮实现、一轮复审、最多一轮修复复审；完整套件在集成里程碑运行，开发时运行覆盖改动的聚焦测试。

## 执行环境与基线

工作树为 `.worktrees/persistent-eta-session`，分支 `feat/persistent-eta-session`，规格提交 `aca1d45`。Node/npm 已有，无须安装依赖。

```powershell
$env:PATH='D:/;'+$env:PATH
& D:/npm.ps1 test -- --run tests/observer/local-native-source.test.ts tests/observer/source-history.test.ts tests/estimation/observer-native-fork.test.ts tests/estimation/observer-persistent-worker.test.ts --maxWorkers=1 --no-file-parallelism
```

文档自审：任务 1→2 输出轮次索引，2→3/4 输出固定上下文合同，3→4 输出基底生命周期；5 验证集成完整目标。不把独立 helper 的通过当作已接入生产。若固定运行时不支持某终态边界，以已确认规格的诊断/完整历史回退处理，不猜测完整性。

### Task 1: 可信轮次边界索引（纯逻辑）

**Files:** Create `src/observer/native-turn-boundary.ts`; test `tests/observer/native-turn-boundary.test.ts`.

**Interfaces:** Consumes normalized raw JSONL envelope and exact complete-record byte offsets from trusted parser, not UI projections. Produces:

```ts
export interface NativeTurnBoundary {
  currentTurnId: string;
  currentStartOffset: number;
  watermark: number;
  completed: {turnId: string; endOffset: number} | null;
}
export interface NativeTurnIndex {
  observe(envelope: unknown, startOffset: number, endOffset: number): void;
  snapshot(): NativeTurnBoundary | null;
  copy(): NativeTurnIndex; // stage a read before committing its cursor
}
export function createNativeTurnIndex(): NativeTurnIndex;
```

- [ ] Write failing tests before the export exists. A tiny real reducer test fixture uses literal offsets; its expected values do not call the reducer to compute the answer.

```ts
const index = createNativeTurnIndex();
index.observe({type:'session_meta',payload:{id:'source'}},0,10);
index.observe({type:'event_msg',payload:{type:'task_started',turn_id:'six'}},10,20);
index.observe({type:'event_msg',payload:{type:'task_complete',turn_id:'six'}},20,30);
index.observe({type:'event_msg',payload:{type:'task_started',turn_id:'seven'}},30,40);
index.observe({type:'response_item',payload:{type:'message',role:'user',content:[]}},40,70);
expect(index.snapshot()).toEqual({currentTurnId:'seven',currentStartOffset:30,
  watermark:70,completed:{turnId:'six',endOffset:30}});
```

- [ ] Run `D:/npm.ps1 test -- --run tests/observer/native-turn-boundary.test.ts`; capture expected RED. Implement a reducer that remembers only the latest terminal boundary, active start/id, latest watermark, and invalid flag; never retain history text.
- [ ] Recognize only parser-supported authoritative `event_msg` task_started/task_complete/task_failed/turn_aborted. Validate contiguous safe integer byte offsets (start may be zero, end must increase), nonempty source turn IDs, no conflicting aliases, matching terminal ID; unknown/malformed lifecycle signals fail closed. Ordinary user/assistant text, synthetic fork markers and unsupported wrappers never create a terminal boundary. Explicit turn attribution that conflicts with the active turn invalidates the index.
- [ ] Add RED/GREEN cases for first turn (completed null), all three terminal outcomes, no active turn after terminal, repeated start same ID while active (keep original start), unmatched/duplicate terminal, a new start before old terminal, gaps/backward offsets, invalid numbers, nested ambiguous IDs, ordinary assistant final text, and defensive snapshot copies. An invalid index remains unavailable until recreated by its source owner after reset.
- [ ] Run focused tests plus typecheck. Commit only the new module and test with `feat: index verified source turn boundaries`. Report RED/GREEN evidence and state that reader integration is still Task 2.

### Task 2: 固定基底边界与当前轮补充的来源合同

**Files:** Modify `src/observer/local-session-reader.ts`, `native-source-request.ts`, `native-source-snapshot.ts`, `history-snapshot.ts`, `context-owner.ts`, `conversation-source.ts`; create `tests/observer/native-turn-source.test.ts`; extend `tests/observer/local-native-source.test.ts`, `tests/observer/context-owner.test.ts`, `tests/observer/source-history.test.ts`.

**Interfaces:** Consumes `NativeTurnIndex` from Task 1. Keep existing `OpenNativeSourceResult` legacy trial compatibility; add a separate paired contract rather than pretending an empty first-turn snapshot is a native full-history snapshot:

```ts
export interface NativeTurnSource {
  identity: string; sourceEpoch: number; revision: number;
  currentTurnId: string; boundary: NativeTurnBoundary;
  baseKey: string;
  supplement: HistorySnapshot;
  openBase(destination: NativeSourceDestination, signal: AbortSignal): Promise<NativeSourceSnapshot | null>;
  validate(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
// LocalSessionReader.openNativeTurn(threadId, signal): Promise<NativeTurnSource>
// contextOwner/conversationSource.openNativeTurn(key, turnKey, signal): Promise<NativeTurnSource|null>
```

All identities are local-only. `baseKey` binds stable source epoch, terminal boundary and checkpoint identity, not per-request revision. `close` closes supplement readers but not a base already handed to the worker's durable custody.

- [ ] Write an integration test with a real temporary JSONL containing terminal round6 and running round7. After `read`, acquire `openNativeTurn`, append a future tool result, then iterate `supplement.records`: only round7 start and pre-acquisition input appear; `boundary.completed.turnId` is six. The base snapshot excludes round7, has the same inherited terminal boundary and is read with existing protected copy checks.
- [ ] Run `D:/npm.ps1 test -- --run tests/observer/native-turn-source.test.ts`; capture RED. Integrate the reducer at complete-envelope parsing, not at truncated `ConversationRecord` projection. Track a stable source epoch independently from snapshotRevision; reset index/epoch on file replacement, validated prefix change, truncation, discarded oversized source or incompatible checkpoint.
- [ ] Extend the fixed-watermark reader to open at `completed.endOffset` (zero for verified first turn) with the same captured source identity and byte watermark. This preserves conversation-scoped configuration between previous terminal and currentStartOffset. Use full-text parsing and validated lifecycle-based attribution within that fixed slice, not unrestricted timestamp inference. Do not call full-history snapshot scanning on each warm acquisition.
- [ ] Capture full prefix identity when establishing a base; on reuse require the source append-consistency evidence promised by the reader. Never treat a matching mtime/size alone as proof. If the existing reader's rolling validation cannot prove a same-size earlier rewrite, use complete prefix verification and measure that cost rather than weakening the invariant.
- [ ] First turn returns null from openBase and a complete supplement. Missing terminal boundary in a truncated/noninitial source is NOT first turn. Unsupported checkpoint boundary, ambiguous attribution, partial/oversized records, changed source while copying or reading: reject with a bounded diagnostic. Do not quietly omit source records.
- [ ] Test 2 same-turn captures preserve baseKey but increase revision and supplement coverage; next turn changes baseKey; source rewrite invalidates prior validate(); images and tool call/result IDs preserved; cancellation closes opened resources; observer binding recheck rejects turn switching during preparation. Run source-history/context-owner/local-native suites. Commit only owned changes after checking preexisting hunks; if safe split staging is not possible, leave touched mixed files uncommitted and report that explicitly.

### Task 3: 不可变原生基底与每请求新分支

**Files:** Modify `src/estimation/observer-native-fork.ts`, `observer-persistent-session.ts`, `observer-persistent-worker.ts`, `native-worker-resources.ts`; create `src/estimation/native-turn-base.ts`; test `tests/estimation/native-turn-base.test.ts`; extend existing native fork/session/resources/worker tests.

**Interfaces:** Native fork gains a trusted discriminated source:

```ts
type NativeForkOrigin =
  | {kind?:'snapshot'; sourceThreadId:string; path:string; lastTurnId?:string}
  | {kind:'owned-base'; sourceThreadId:string; rootSourceThreadId:string; lastTurnId:string};
// Shared cwd/baseInstructions/developerInstructions/custodyTag remain mandatory.
// Unspecified kind without lastTurnId is legacy trial only; explicit kinds require cutoff.
// Owned-base replies must differ from BOTH the immediate base and the root source.
export interface NativeTurnBase {
  key: string;
  threadId: string | null; // null only for a verified first turn
  lastTurnId: string | null;
}
```

`native-turn-base.ts` manages only the immutable per-generation base identity and creation state; resource custody remains in native-worker-resources. Worker adds `prepareNativeTurnContext(input, source:NativeTurnSource, signal, key, generation, at, sample)` with the same output/one-use proof contract as prepareNativeContext. No fabricated path for first turn.

- [ ] First write fork tests asserting emitted RPC contains snapshot lastTurnId and that owned-base fork omits path. Return a new thread ID, validate not equal to any source ID, persist custody before honoring cancellation, then clear/get goal only on new ID. Missing or current-running boundary must be rejected upstream before RPC. RED/GREEN via existing fork test file.
- [ ] Extend resources with one shared base lease plus up to 3 request-fork leases without mandatory per-request copied snapshot. Persist each intent before fork. Keep old manifest recovery valid; separately measure all base/request manifests, fork logs and snapshot bytes. `usage().requests` counts request forks, not the non-model base. Bind every lease to the actual owner PID/creation identity.
- [ ] Add lifecycle tests with fake external RPC and real worker/resources: first ETA creates base plus child; second same-round ETA reuses base and creates another child; base never receives model turn/start/history append; only one source copy is made. Assert actual RPC sequence, unique child IDs, payload destinations and ledger admission counts, not just mock existence.
- [ ] Implement base creation once per healthy bound generation with the source's terminal lastTurnId. For first turn create a clean per-request session. Before every child fork validate source/base/account/process binding; every child uses a new PersistentObserverSession and fresh usage baseline/listeners. Preserve worker cancellation/releasing fences.
- [ ] For the current-turn supplement, reuse the existing full-source role/attachment serializer and journalled compaction path, extracted into a focused reusable function if required; do not paste a second serializer. Import all supplement records into the new child from ordinal zero. Existing prepared-input attachment revalidation and source-turn scope remain authoritative.
- [ ] Cover pause/end/newturn/account change/disable, 3-request threshold, 64 MiB accounting, idle permit, cancellation after base creation, lost fork reply, failed cleanup and late ETA. The third request retires base and children after owner exit. Preserve recovered orphan evidence; don't mark operation completion as process exit.
- [ ] Run native fork/session/resource/worker suites and typecheck. Record exact changes and risks for the final sol/medium review; do not weaken tests or commit preexisting unrelated hunks.

### Task 4: 调度、生产候选接线及诊断

**Files:** Modify `src/estimation/observer-scheduler.ts`, `src/desktop/observer-runtime.ts`, `src/desktop/native-observer-trial.ts`, `src/server/passive-goals.ts`, `src/core/observer-diagnostics.ts`; extend `tests/estimation/full-context-scheduler.test.ts`, `tests/desktop/observer-runtime.test.ts`, `tests/server/passive-goals-native-source.test.ts`.

**Interfaces:** ThreadSource and ObserverWorker expose the Task 2/3 openNativeTurn/prepareNativeTurnContext pair. Scheduler prefers the new pair only when both sides advertise it; legacy native trial and verified history route remain explicitly labelled, not silently confused with the optimized path.

- [ ] Write a scheduler test: preparation resolves after source runtime becomes completed; `observe` must never be called and late prepared input must be closed. Another test changes source turn7→turn8 mid-preparation and rejects result publication. Run scheduler tests to observe missing-route RED.
- [ ] Add new pair branch before existing legacy native branch. Fix one trigger watermark, retain final source/account validity checks, pass refreshed active clock separately, and bind result to current turn/generation. The new source supplement takes precedence over UI message summaries; local countdown scalar does not become historical work evidence.
- [ ] No native compatible boundary: enter already-verified full-history route only before a model operation and with existing authorization; otherwise return bounded context-unavailable reason. Do not perform a hidden second model call on inference failure. Close unhanded source in scheduler finally; worker owns resources after handoff.
- [ ] Wire native trial construction and production candidate source/worker pair; keep installed version untouched and do not promote default before gates. Track baseCold/baseReused, base creation, supplement read/import, account check, queue/cleanup/total preparation and active-clock age without logging private text or account paths.
- [ ] Add two-conversation independence, failed preparation recovery, complete-history fallback and no-call-on-wait tests. Run scheduler/runtime/passive-goal and native suites, then one full-suite milestone, typecheck and build:

```powershell
& D:/npm.ps1 test -- --run --maxWorkers=1 --no-file-parallelism
& D:/npm.ps1 run typecheck
& D:/npm.ps1 run build
git diff --check
```

### Task 5: 固定运行时预检、真实合成对照与交付审计

**Files:** Create `scripts/diagnostics/completed-turn-native-base.mjs`; test `tests/evaluation/completed-turn-native-base-script.test.ts`; reuse `src/evaluation/native-trial-authority.ts`, `native-comparison-consent.ts`, `native-comparison-input.ts`, `native-comparison-preparation.ts`, `native-comparison-transition.ts`; report `docs/superpowers/reports/2026-09-15-completed-turn-native-base.md`.

**Interfaces:** Diagnostic CLI exposes `--preflight` (no inference) and `--run-approved-comparison` (synthetic, durable new audit). Both require explicit config and out directory as existing native diagnostics do; outputs contain implementation hashes and phase timings but no credentials. Keep `evaluateNativeContextComparison` gates from the existing comparison evaluator, not a new weaker scoring function.

- [ ] Write a real script contract test using controlled synthetic fixtures and injected child transport at the process boundary: --preflight must never emit turn/start, and failure must not fall through into comparison. Require incomplete baseline/content mismatch to produce nonpassing report and nonzero exit.
- [ ] Build 6 completed synthetic turns and a seventh active turn; save previous terminal ID and fixed tool start/result positions. No-model runtime test forks with lastTurnId through turn6 while turn7 exists, then forks owned base. Check the second fork's returned/stored history remains the same, not a fabricated local summary. Test successful/failed/aborted previous terminals independently; record unsupported shapes and stop that case.
- [ ] Pre-register two size strata (about 85 KiB and 1 MiB synthetic source, within existing 8 MiB cap). Per stratum use initial cold, actual ordinary-cadence same-turn warm, then new-turn cold; alternating history/new-native route order. Total initial planned series: 12 ETA (6 per stratum), up to 2 seed compactions; use separate durable authorized audit records following existing trial caps, not a bypass of production budgets. Unexpected model work or failure stops the sequence. Continuing user R&D authorization covers these synthetic calls.
- [ ] Verify old-history markers, current-turn request/tool results/image facts and absence of future markers without placing expected answers into the model prompt. Source and model fixtures are separate from scoring keys. Include first-turn/no-history case in no-model coverage; if native multimodal inheritance needs a live extra check, pre-register a separate labelled diagnostic and its accounting before dispatch.
- [ ] Record all successes/failures, source hashes, cold/prewarm preparation cost, real wait interval, individual and total delivery, token totals/cached tokens/unknown operations, cleanup time and peak known resources. Reuse same account-cache policy for both routes; don't claim exact subscription dollars. Apply gates per stratum and report aggregate without dropping bad pairs.
- [ ] One final gpt-5.6-sol / medium review of the new architecture diff, source integrity, auth, ledger and release readiness; at most one fix review. A negative performance gate means continue diagnosis with evidence, not mark goal complete or install. A passing gate plus full verification produces a candidate and an installation handoff; merge/push/install require the user's appropriate request. Keep source/account data and previous failures intact.

## Self-review / Completion Audit

### 已批准的后续切片：本轮补充随 ETA 请求提交（2026-09-16）

用户已确认上一条发送/记账边界调整。直接在当前隔离工作树实施，不改安装版，不降低原性能门槛。

- [ ] Session TDD：完整短文本暂存不触发注入、不推进 imported cursor；按源顺序随 turn/start.input 提交。暂存、已导入、请求已接受状态分开；输入冻结、取消、重复调用、错误确认不虚报覆盖。
- [ ] Worker TDD：仅新原生当前轮路线尝试暂存；图片、长记录、容量/请求超限完整冲刷回既有注入/压缩路径。最终完整请求在 ETA 准入前校验；不把确定性本地错误计为未知模型用量。保留最终来源、账户、附件、取消与晚到结果检查。
- [ ] 诊断适配：暂存记录不伪称已落盘；真实调用后核对来源内容，测试中区分注入确认与随请求提交。合成上下文、独立账本、新批次；不重用失败批次。
- [ ] 聚焦回归、类型检查、构建及集成里程碑完整回归；再运行原两层匹配性能验证，保留所有失败及耗时。仍不达标就保留候选关闭，不合并/推送/安装。

### 已批准的后续切片：跨轮保留运行时

按规格第 5 节新增修订执行，不重新询问已确认方向，当前任务直接实现。所有步骤保持候选关闭，真实试验另用新批次，不重写 series03。

- [x] 保留策略 TDD：新增进程级许可验证，与旧轮次级许可分开；只接受同对话、单调代次、健康/授权检查之外的有效时间边界。显式区分正常轮间空闲与来源不可用/暂停/失败；不能延长截止时间或授权等待中推理。
- [ ] Worker 外部进程集成 RED/GREEN：首轮估时→结算保留→正常轮末→下一轮；同一个 PID/创建身份和 owner UUID，两个新基底、两个独立 ETA 子分支；旧凭证/旧源改写/账户变化拒绝。资源计数按进程累计，最终退出后清理全部资源。
- [ ] 调度/worker 工厂/比较器接线：正常轮末不误删除保留进程；不复用给其他对话。不能用无参数 release 绕过正在发生的失败清理；准备/估时活动中换轮仍取消并安全退出。历史和旧原生路线不受候选策略影响。
- [x] 聚焦回归、类型检查、构建；检查相邻生命周期、账户、账本及资源上限用例。完整套件在集成里程碑运行。23:31:11 完整回归 243 文件 / 2,976 项通过，类型检查与构建成功；不替代性能门槛。
- [ ] 新无模型实际 worker 预检后，用新合成审计比较同轮/跨轮耗时及全部用量。未达原门槛继续报告失败，不安装。

- Spec 1–3: Tasks 1–4 preserve current-turn ETA and native completed-history plus whole-current-turn supplementation, including first-turn and native-unavailable cases.
- Spec 4: Tasks 1–2 fixed byte boundary, epoch, complete records and stale-source rejection; Tasks 3–4 serialize complete records and fence late output.
- Spec 5–6: Tasks 3–4 enforce one shared base with independently owned children, existing account/admission/ledger/retention, independent conversations and diagnostic wiring.
- Spec 7: Task 5 verifies real pinned compatibility, all content cases and unchanged performance gates; Task 4 full milestone and Task 5 final review.
- Spec 8: No installed changes, private history transfer, deletion, merge or push within this plan execution. Each task remains incomplete until its integration and evidence requirements, not only helper tests, are satisfied.
