import { describe, expect, it } from "vitest";
import { buildHudView } from "../../src/ui/view-model.js";
import type { HudSnapshot } from "../../src/server/task-store.js";
import type { EtaEstimate, TaskSnapshot } from "../../src/core/types.js";

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

describe("HUD view model", () => {
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
