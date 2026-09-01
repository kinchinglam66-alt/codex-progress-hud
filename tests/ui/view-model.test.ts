import { describe, expect, it } from "vitest";
import { buildHudView } from "../../src/ui/view-model.js";
import type { HudSnapshot } from "../../src/server/task-store.js";
import type { TaskSnapshot } from "../../src/core/types.js";

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

describe("HUD view model", () => {
  it("formats determinate progress and an ETA range without false precision", () => {
    const snapshot: HudSnapshot = {
      task: task(),
      eta: { lowSeconds: 360, highSeconds: 600, confidence: 0.72 }
    };

    expect(buildHudView(snapshot, 100_000)).toMatchObject({
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
    const view = buildHudView({ task: task({ progress: undefined }), eta: null }, 100_000);

    expect(view.progressMode).toBe("indeterminate");
    expect(view.progressPercent).toBeNull();
    expect(view.etaLabel).toBe("正在估算剩余时间");
  });

  it("pauses active ETA while waiting for approval", () => {
    const view = buildHudView(
      {
        task: task({ status: "waiting_approval", statusDetail: "允许安装依赖" }),
        eta: null
      },
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
    const paused = buildHudView({ task: task({ status: "paused" }), eta: null });
    const stopped = buildHudView({ task: task({ status: "stopped" }), eta: null });

    expect(paused.statusLabel).toBe("跟踪已暂停");
    expect(paused.progressMode).toBe("paused");
    expect(paused.etaLabel).toContain("跟踪已暂停");
    expect(stopped.statusLabel).toBe("跟踪已停止");
    expect(stopped.etaLabel).toContain("跟踪已停止");
  });

  it("shows suspected interruption as a warning rather than a failure", () => {
    const view = buildHudView(
      { task: task({ status: "stalled_suspected" }), eta: null },
      100_000
    );

    expect(view.statusLabel).toBe("疑似中断");
    expect(view.tone).toBe("warning");
  });

  it("distinguishes failure from verified completion", () => {
    const failed = buildHudView({ task: task({ status: "failed" }), eta: null }, 100_000);
    const completed = buildHudView(
      { task: task({ status: "succeeded_verified", progress: 1 }), eta: null },
      100_000
    );

    expect(failed).toMatchObject({ statusLabel: "任务失败", tone: "danger" });
    expect(completed).toMatchObject({
      statusLabel: "已完成并验证",
      tone: "success",
      progressMode: "complete",
      progressPercent: 100
    });
  });

  it("shows a quiet idle state when no task exists", () => {
    expect(buildHudView({ task: null, eta: null }, 100_000)).toMatchObject({
      title: "暂无活动任务",
      statusLabel: "空闲",
      tone: "idle",
      progressMode: "indeterminate"
    });
  });
});
