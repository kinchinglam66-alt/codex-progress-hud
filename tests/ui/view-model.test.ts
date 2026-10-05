import { describe, expect, it } from "vitest";
import { buildConversationViews, buildHudView, createConversationViewProjector, conversationActivityLabel } from "../../src/ui/view-model.js";
import type { HudSnapshot } from "../../src/server/task-store.js";
import type { EtaEstimate, TaskSnapshot } from "../../src/core/types.js";
import type { ConversationRow } from "../../src/server/conversation-projection.js";
it('reports uncovered approval records as a diagnostic, not an observed current block',()=>{
 const row=overdueConversation('running','ready');
 Object.assign(row.goal!,{blockingUnknown:false,blockingEvidenceIncomplete:true,timingUncertain:true});
 const view=buildConversationViews([row])[0]!;
 expect(view.statusLabel).toBe('本轮执行中');expect(view.tone).toBe('active');
 expect(view.diagnosticLabel).toContain('审批阻塞记录未覆盖');
 row.goal!.blockingUnknown=true;expect(buildConversationViews([row])[0]!.statusLabel).toContain('阻塞性质未知');
});
it.each(['scheduler_aborted','scheduler_stale','worker_stale','provider_source_cancelled','critical_event_after_snapshot'] as const)(
 'does not present normal cancellation or supersession as an estimation fault: %s',reason=>{
 const row=overdueConversation('running','rejected_result');row.observer!.rejectionReason=reason;
 const view=buildConversationViews([row])[0]!;
 expect(view.diagnosticLabel).toContain('等待下一次估时');expect(view.diagnosticLabel).not.toContain('结果未采纳');
 expect(view.etaLabel).toContain('等待重新估时');expect(view.etaLabel).not.toContain('暂不可用');
 expect(view.statusLabel).toBe('本轮执行中');
 row.goal!.prediction=null;expect(buildConversationViews([row])[0]!.etaLabel).toContain('等待下一次估时');
});
it('explains expired delivery without fabricating an ETA or changing task state',()=>{
 const row=overdueConversation('running','rejected_result');row.observer!.rejectionReason='estimate_expired_on_arrival';
 const original=structuredClone(row),view=buildConversationViews([row])[0]!;
 expect(view.statusLabel).toBe('本轮执行中');expect(view.diagnosticLabel).toContain('预测返回时已过期');
 expect(view.etaLabel).toContain('等待重新估时');expect(view.etaLabel).not.toContain('暂不可用');
 expect(row).toEqual(original);
 row.goal!.prediction=null;
 expect(buildConversationViews([row])[0]!.etaLabel).toBe('预测返回时已过期，等待下一次估时');
 row.observer!.state='estimating';
 expect(buildConversationViews([row])[0]!.etaLabel).toBe('正在估时');
 row.goal!.humanBlocked=true;
 expect(buildConversationViews([row])[0]!.etaLabel).toBe('等待你操作 · 估时已暂停');
});
it('does not conceal genuine process faults or invalid responses',()=>{
 const row=overdueConversation('running','process_error');row.observer!.rejectionReason='preparation_failed';
 expect(buildConversationViews([row])[0]!.diagnosticLabel).toContain('估时进程出错');
 row.observer!.state='rejected_result';row.observer!.rejectionReason='schema_invalid';
 expect(buildConversationViews([row])[0]!.diagnosticLabel).toContain('估时结果未采纳');
});
it('keeps independently waiting and interrupted rows out of the pending-user count',()=>{
 const waiting=overdueConversation('waiting'),running=overdueConversation('running'),interrupted=overdueConversation('interrupted');
 waiting.conversationKey='waiting';running.conversationKey='running';interrupted.conversationKey='interrupted';
 expect(conversationActivityLabel(buildConversationViews([waiting,running,interrupted]))).toBe('1 个执行中 · 1 个状态待确认 · 1 个已中断');
 waiting.goal!.humanBlocked=true;
 expect(conversationActivityLabel(buildConversationViews([waiting,running]))).toBe('1 个执行中 · 1 个待处理');
});
it('collapses repeated rows only within the same conversation identity',()=>{
 const row=overdueConversation('running');expect(buildConversationViews([row,structuredClone(row)])).toHaveLength(1);
 const other=structuredClone(row);other.conversationKey='other';
 expect(buildConversationViews([row,other])).toHaveLength(2);
});
it('counts a completely user-blocked task as pending, but keeps concurrent approval and work running',()=>{
 const row=overdueConversation('running');row.goal!.humanBlocked=true;
 expect(conversationActivityLabel(buildConversationViews([row]))).toBe('暂无执行中任务 · 1 个待处理');
 row.goal!.humanBlocked=false;row.goal!.attentionRequired=true;row.goal!.attentionWorkContinuing=true;
 expect(conversationActivityLabel(buildConversationViews([row]))).toBe('1 个执行中');
 expect(buildConversationViews([row])[0]?.statusLabel).toContain('相关工作仍在继续');
});
it('uses no fixed timeout duration when the actual request limit is configurable',()=>{
 const row=overdueConversation('running','process_error');row.observer!.contextState='estimate_timeout';
 expect(buildConversationViews([row])[0]!.diagnosticLabel).toContain('估时超时');
 expect(buildConversationViews([row])[0]!.diagnosticLabel).not.toContain('30秒');
});
it.each(['report_blocker','continue_work','unknown'] as const)('labels %s conditions, including overdue forecasts, without completing the turn',path=>{
 const row=overdueConversation('running','ready');row.goal!.prediction={remainingSeconds:10,errorPercent:100,observedActiveSeconds:row.goal!.activeSeconds};
 row.goal!.estimateCondition={selectedPath:path,displayPath:path,issue:path==='unknown'?'unknown_path':'conditional'};
 const text=path==='report_blocker'?'若报告阻塞结束':path==='continue_work'?'若继续实施至本轮结束':'适用条件未明';
 expect(buildConversationViews([row])[0]!.etaLabel).toContain(text);
 const overdue=buildConversationViews([row],20)[0]!;expect(overdue.etaLabel).toContain(text);expect(overdue.statusLabel).toContain('执行中');
 row.goal!.runtime='interrupted';expect(buildConversationViews([row])[0]!.etaLabel).toBe('工作计时已停止');
});
it('marks contradictory numeric estimates rather than changing or hiding the number',()=>{
 const row=overdueConversation('running','ready');row.goal!.prediction={remainingSeconds:300,errorPercent:50,observedActiveSeconds:row.goal!.activeSeconds};
 row.goal!.estimateCondition={selectedPath:'report_blocker',displayPath:'unknown',issue:'estimate_mismatch'};
 const view=buildConversationViews([row])[0]!;expect(view.etaLabel).toContain('条件不一致');expect(view.etaLabel).toContain('00:05:00');
});
it('labels an uncertain numeric ETA without changing task state or countdown',()=>{
 const row=overdueConversation('running','ready');row.goal!.prediction={remainingSeconds:300,errorPercent:50,observedActiveSeconds:row.goal!.activeSeconds};
 const before=buildConversationViews([row])[0]!;row.goal!.estimateUncertain=true;const after=buildConversationViews([row])[0]!;
 expect(after.etaLabel).toContain('粗略估时／结束方式未明');expect(after.etaLabel).toContain('00:05:00');expect(after.statusLabel).toBe(before.statusLabel);
});
it('shows a separate milestone countdown, freezes on pause and never completes at zero',()=>{
 const row=overdueConversation('running','ready');
 row.goal!.activeSeconds=10;row.goal!.progressState={scope:'scope',observedEventSequence:0,milestone:{id:'ms',definition:'测试结束',judgment:'in_progress',prediction:{remainingSeconds:100,errorPercent:50,observedActiveSeconds:10}}};
 expect(buildConversationViews([row],20)[0]?.milestoneLabel).toContain('00:01:20');
 row.goal!.runtime='paused';expect(buildConversationViews([row],20)[0]?.milestoneLabel).toContain('00:01:40');
 row.goal!.runtime='running';expect(buildConversationViews([row],100)[0]?.milestoneLabel).toContain('超出估时');
 row.goal!.progressState.milestone=null;expect(buildConversationViews([row])[0]?.milestoneLabel).toBe('');
});
it.each([
 ['account_refresh_failed','账户定期检查失败'],
 ['worker_closing','旧估时进程正在关闭'],
 ['worker_cleanup_pending','旧估时进程清理尚未确认'],
 ['provider_unavailable','估时提供方未就绪'],
 ['runtime_not_ready','估时运行时未就绪'],
] as const)('explains %s before model dispatch',(reason,label)=>{
 const row=overdueConversation('running','pending');row.observer!.schedulingReason=reason;
 expect(buildConversationViews([row])[0]!.diagnosticLabel).toContain(label);
});
it('explains unavailable worker admission without claiming a model failure',()=>{
 const row=overdueConversation('running','pending');
 row.observer!.schedulingReason='worker_unavailable';
 const view=buildConversationViews([row])[0]!;
 expect(view.diagnosticLabel).toContain('估时提供方暂不可用');
 expect(view.diagnosticLabel).not.toContain('估时调用失败');
});
it('shows missing-image warning beside ETA and in diagnostics',()=>{
  const row=overdueConversation('running','ready');
  row.observer!.contextState='context_images_missing';
  const view=buildConversationViews([row])[0]!;
  expect(view.etaLabel).toContain('部分历史图片缺失');
  expect(view.diagnosticLabel).toContain('部分历史图片缺失');
});
it('retains the image warning while preparing a replacement estimate',()=>{
 const row=overdueConversation('running','estimating');
 row.observer={...row.observer!,contextState:'context_preparing',missingImages:2};
 const view=buildConversationViews([row])[0]!;
 expect(view.etaLabel).toContain('部分历史图片缺失');
 expect(view.diagnosticLabel).toContain('部分历史图片缺失');
});
it('shows the current scheduler failure separately from historical unknown usage',()=>{
  const row=overdueConversation('running','disabled');
  row.observer!.stopReason='scheduler_exception';row.observer!.stoppedAt=1234;
  const views=buildConversationViews([row]);
  expect(JSON.stringify(views)).toContain('调度检查异常');
  expect(JSON.stringify(views)).toContain('不等同于历史未知用量');
});

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task-1",
    title: "修复登录流程",
    status: "running",
    statusDetail: undefined,
    phase: "testing",
    currentStep: "运行集成测试",
    progress: 0.68,
    plan: [],
    createdAt: 0,
    startedAt: 0,
    lastActivityAt: 92_000,
    completedAt: undefined,
    activeElapsedMs: 90_000,
    activeSince: 92_000,
    modelEstimateSeconds: undefined,
    modelConfidence: undefined,
    ...overrides
  };
}

function snapshot(taskValue: TaskSnapshot | null, eta: EtaEstimate | null, tasks?: HudSnapshot["tasks"]): HudSnapshot {
  return {
    revision: 0,
    selectedTaskId: taskValue?.id ?? null,
    selectionMode: "follow_activity",
    tasks: tasks ?? (taskValue === null ? [] : [{
      id: taskValue.id,
      title: taskValue.title,
      status: taskValue.status,
      lastActivityAt: taskValue.lastActivityAt,
      hiddenForTask: false
    }]),
    selected: taskValue === null ? null : { task: taskValue, eta },
    compatibility: { incompatibleClientSeen: false }
  };
}

function overdueConversation(runtime: "running" | "waiting" | "paused" | "interrupted" = "running", observerState?: NonNullable<ConversationRow['observer']>['state']): ConversationRow {
  return {
    conversationKey: "conversation-1",
    task: task(),
    eta: null,
    name: { value: "任务", freshness: "fresh" },
    goal: {
      generation: 1,
      estimateRevision: 1,
      status: runtime,
      runtime,
      activeSeconds: 101,
      prediction: { remainingSeconds: 100, observedActiveSeconds: 0, errorPercent: 20 },
      sampledAtMs: 0
    },
    ...(observerState === undefined ? {} : {
      observer: { state: observerState, estimateAgeSeconds: null, callsLastHour: 1, retryPending: false }
    })
  };
}

describe("HUD view model", () => {
  it('counts actual running rows separately from waiting or uncertain goals',()=>{
    const waiting=overdueConversation('waiting'),running=overdueConversation('running');
    const uncertain=overdueConversation('waiting');uncertain.goal!.runtimeUncertain=true;
    uncertain.conversationKey='uncertain';running.conversationKey='running';
    expect(conversationActivityLabel(buildConversationViews([waiting,uncertain]))).toBe('暂无执行中任务 · 2 个状态待确认');
    expect(conversationActivityLabel(buildConversationViews([waiting,running]))).toBe('1 个执行中 · 1 个状态待确认');
    expect(conversationActivityLabel([])).toBe('暂无进行中任务');
    expect(buildConversationViews([uncertain])[0]?.statusLabel).toBe('本轮状态待确认');
  });
  it.each([
    ["estimating", "已超出预计时间 · 正在重新估时"],
    ["call_failed", "已超出预计时间 · 估时暂不可用"],
    ["setup_failed", "已超出预计时间 · 估时暂不可用"],
    ["disabled", "已超出预计时间 · 估时暂不可用"],
    ["rate_limited", "已超出预计时间 · 重估受限，等待额度"],
    ["ready", "已超出预计时间 · 等待重新估时"],
    ["pending", "已超出预计时间 · 等待重新估时"]
  ] as const)("uses an honest overdue label for observer state %s", (state, label) => {
    const view = buildConversationViews([overdueConversation("running", state)])[0];

    expect(view?.etaLabel).toBe(label);
  });

  it.each(["waiting", "paused"] as const)("marks overdue %s work as paused while awaiting re-estimation", runtime => {
    const view = buildConversationViews([overdueConversation(runtime, "estimating")])[0];

    expect(view?.etaLabel).toBe("已超出预计时间 · 工作计时已暂停");
    expect(view?.progressMode).toBe("paused");
  });

  it("keeps overdue progress monotonic below completion", () => {
    const project = createConversationViewProjector();
    const row = overdueConversation();

    expect(project([row])[0]).toMatchObject({ progressPercent: 99, progressMode: "determinate" });
    expect(project([row], 10)[0]?.progressPercent).toBe(99);
    expect(project([row])[0]?.progressMode).not.toBe("complete");
  });

  it("keeps completed conversations complete instead of relabeling them overdue", () => {
    const row = overdueConversation();
    row.goal!.status = "completed";
    row.goal!.runtime = "waiting";

    expect(buildConversationViews([row])).toEqual([]);
  });

  it("labels grouped current and prior turns without displaying opaque identities", () => {
    const value = snapshot(task(), null);
    value.tasks = [
      { ...value.tasks[0]!, conversationKey: "secret-group", turnKey: "secret-turn", isCurrentTurn: true },
      { ...value.tasks[0]!, id: "old", conversationKey: "secret-group", turnKey: "old-turn", isCurrentTurn: false }
    ];
    const view = buildHudView(value);
    expect(view.taskItems[0]?.statusLabel).toContain("对话 1 · 当前轮");
    expect(view.taskItems[1]?.statusLabel).toContain("对话 1 · 历史轮");
    expect(JSON.stringify(view)).not.toContain("secret-");
  });

  it.each([null, task()])("shows degraded tracking even without a selected task", (selected) => {
    const value = snapshot(selected, null);
    value.turnTracking = { identityUnavailable: true, orderingUncertain: true, capacityReached: true };
    const view = buildHudView(value);
    expect(view.compatibilityBanner).toContain("轮次身份");
    expect(view.compatibilityBanner).toContain("顺序");
    expect(view.compatibilityBanner).toContain("容量");
    expect(view.progressPercent).not.toBe(100);
  });

  it("formats determinate progress and an ETA range without false precision", () => {
    const hudSnapshot = snapshot(task(), {
        lowSeconds: 360,
        highSeconds: 600,
        confidence: 0.72,
        confidenceClass: "medium",
        signals: ["plan"]
      });

    expect(buildHudView(hudSnapshot, 100_000)).toMatchObject({
      title: "修复登录流程",
      statusLabel: "执行中",
      tone: "active",
      progressMode: "determinate",
      progressPercent: 68,
      etaLabel: "预计还需 6–10 分钟",
      stepLabel: "运行集成测试",
      updatedLabel: "8 秒前更新"
    });
  });

  it("uses an indeterminate presentation when progress is unknown", () => {
    const view = buildHudView(snapshot(task({ progress: undefined }), null), 100_000);

    expect(view.progressMode).toBe("indeterminate");
    expect(view.progressPercent).toBeNull();
    expect(view.etaLabel).toBe("剩余时间未知");
  });

  it("pauses active ETA while waiting for approval", () => {
    const view = buildHudView(
      snapshot(task({ status: "waiting_approval", statusDetail: "允许安装依赖" }), null),
      100_000
    );

    expect(view).toMatchObject({
      statusLabel: "等待审批",
      tone: "waiting",
      progressMode: "paused",
      etaLabel: "工作计时已暂停",
      stepLabel: "允许安装依赖"
    });
  });

  it("shows explicit tracking pause and stop states distinctly", () => {
    const paused = buildHudView(snapshot(task({ status: "paused" }), null));
    const stopped = buildHudView(snapshot(task({ status: "stopped" }), null));

    expect(paused.statusLabel).toBe("跟踪已暂停");
    expect(paused.progressMode).toBe("paused");
    expect(paused.etaLabel).toContain("跟踪已暂停");
    expect(stopped.statusLabel).toBe("跟踪已停止");
    expect(stopped.etaLabel).toContain("跟踪已停止");
  });

  it("shows suspected interruption as a warning rather than a failure", () => {
    const view = buildHudView(snapshot(task({ status: "stalled_suspected" }), null), 100_000);

    expect(view.statusLabel).toBe("疑似中断");
    expect(view.tone).toBe("warning");
  });

  it.each([
    ["quiescent", "本轮已停止，等待下一轮工作"],
    ["disconnected_suspected", "任务连接疑似断开"],
    ["ended_unknown", "任务已结束，结果未知"]
  ] as const)("uses a truthful ETA label for %s", (status, label) => {
    const view = buildHudView(snapshot(task({ status }), null), 100_000);

    expect(view.etaLabel).toBe(label);
  });

  it.each(['succeeded_verified', 'completed_unverified'] as const)("presents legacy %s as completion without a quality-verification category", status => {
    const failed = buildHudView(snapshot(task({ status: "failed" }), null), 100_000);
    const completed = buildHudView(
      snapshot(task({ status, progress: 1 }), null),
      100_000
    );

    expect(failed).toMatchObject({ statusLabel: "任务失败", tone: "danger" });
    expect(completed).toMatchObject({
      statusLabel: "已完成",
      tone: "success",
      progressMode: "complete",
      progressPercent: 100
    });
  });

  it("shows a quiet idle state when no task exists", () => {
    expect(buildHudView(snapshot(null, null), 100_000)).toMatchObject({
      title: "暂无活动任务",
      statusLabel: "空闲",
      tone: "idle",
      progressMode: "indeterminate"
    });
  });

  it("exposes a compact truthful task switcher and follow control", () => {
    const view = buildHudView(snapshot(task({ trackingOrigin: "late_attach" }), {
      lowSeconds: 60,
      highSeconds: 180,
      confidence: 0.3,
      confidenceClass: "low",
      signals: ["model"]
    }, [
      { id: "task-1", title: "修复登录流程", status: "running", lastActivityAt: 92_000, hiddenForTask: false },
      { id: "task-2", title: "更新依赖", status: "quiescent", lastActivityAt: 91_000, hiddenForTask: true }
    ]), 100_000);

    expect(view.taskItems).toEqual([
      { id: "task-1", title: "修复登录流程", statusLabel: "执行中", selected: true },
      { id: "task-2", title: "更新依赖", statusLabel: "等待下一轮（已隐藏）", selected: false }
    ]);
    expect(view).toMatchObject({
      selectedTaskId: "task-1",
      trackingOriginLabel: "跟踪从任务中途开始",
      etaLabel: "预计还需 1–3 分钟",
      confidenceLabel: "置信度：低",
      canFollowActivity: false
    });
  });

  it("shows pinned selection, hidden current task, compatibility, and terminal truth", () => {
    const selected = task({ id: "task-2", title: "发布", status: "ended_unknown", trackingOrigin: "session_start" });
    const view = buildHudView({
      ...snapshot(selected, null, [
        { id: "task-1", title: "测试", status: "succeeded_verified", lastActivityAt: 200, hiddenForTask: false },
        { id: "task-2", title: "发布", status: "ended_unknown", lastActivityAt: 300, hiddenForTask: true }
      ]),
      selectedTaskId: "task-2",
      selectionMode: "pinned",
      compatibility: { incompatibleClientSeen: true }
    });

    expect(view).toMatchObject({
      selectedTaskId: "task-2",
      compatibilityBanner: "插件与伴侣版本不匹配；请同时更新两者并重启 Codex",
      canFollowActivity: true,
      etaLabel: "任务已结束，结果未知"
    });
    expect(view.taskItems[1]).toEqual({ id: "task-2", title: "发布", statusLabel: "已结束，结果未知（已隐藏）", selected: true });
  });
});
