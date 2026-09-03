import type { HudSnapshot } from "../server/task-store.js";
import type { TaskStatus } from "../core/types.js";

export type HudTone = "idle" | "active" | "waiting" | "warning" | "danger" | "success";
export type ProgressMode = "determinate" | "indeterminate" | "paused" | "complete";

export interface HudView {
  title: string;
  statusLabel: string;
  tone: HudTone;
  progressMode: ProgressMode;
  progressPercent: number | null;
  etaLabel: string;
  stepLabel: string;
  updatedLabel: string;
}

const statusPresentation: Record<TaskStatus, { label: string; tone: HudTone }> = {
  idle: { label: "空闲", tone: "idle" },
  running: { label: "执行中", tone: "active" },
  quiescent: { label: "等待下一轮", tone: "waiting" },
  paused: { label: "跟踪已暂停", tone: "waiting" },
  stopped: { label: "跟踪已停止", tone: "idle" },
  waiting_approval: { label: "等待审批", tone: "waiting" },
  waiting_user: { label: "等待用户", tone: "waiting" },
  stalled_suspected: { label: "疑似中断", tone: "warning" },
  disconnected_suspected: { label: "疑似断开", tone: "warning" },
  ended_unknown: { label: "已结束，结果未知", tone: "warning" },
  completed_unverified: { label: "已结束，未验证", tone: "warning" },
  succeeded_verified: { label: "已完成并验证", tone: "success" },
  failed: { label: "任务失败", tone: "danger" },
  interrupted: { label: "任务已中断", tone: "danger" }
};

function minuteLabel(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

function etaLabel(snapshot: HudSnapshot): string {
  const status = snapshot.task?.status;
  if (status === "paused") return "跟踪已暂停，工作计时已暂停";
  if (status === "stopped") return "跟踪已停止，任务仍可继续执行";
  if (status === "quiescent") return "本轮已停止，等待下一轮工作";
  if (status === "waiting_approval" || status === "waiting_user") return "工作计时已暂停";
  if (status === "stalled_suspected") return "正在检查任务连接";
  if (status === "disconnected_suspected") return "任务连接疑似断开";
  if (status === "ended_unknown") return "任务已结束，结果未知";
  if (
    status === "completed_unverified" ||
    status === "succeeded_verified" ||
    status === "failed" ||
    status === "interrupted"
  ) {
    return "任务已停止计时";
  }
  if (snapshot.eta === null) return "正在估算剩余时间";
  return `预计还需 ${minuteLabel(snapshot.eta.lowSeconds)}–${minuteLabel(
    snapshot.eta.highSeconds
  )} 分钟`;
}

function progressMode(status: TaskStatus, progress: number | undefined): ProgressMode {
  if (status === "succeeded_verified" || status === "completed_unverified") return "complete";
  if (status === "paused" || status === "waiting_approval" || status === "waiting_user") {
    return "paused";
  }
  return progress === undefined ? "indeterminate" : "determinate";
}

export function buildHudView(snapshot: HudSnapshot, nowMs = Date.now()): HudView {
  if (snapshot.task === null) {
    return {
      title: "暂无活动任务",
      statusLabel: "空闲",
      tone: "idle",
      progressMode: "indeterminate",
      progressPercent: null,
      etaLabel: "等待 Codex 上报任务",
      stepLabel: "启动任务后将在这里显示进度",
      updatedLabel: ""
    };
  }

  const task = snapshot.task;
  const presentation = statusPresentation[task.status];
  const mode = progressMode(task.status, task.progress);
  const progressPercent =
    mode === "complete"
      ? 100
      : task.progress === undefined
        ? null
        : Math.round(Math.min(1, Math.max(0, task.progress)) * 100);
  const ageSeconds = Math.max(0, Math.floor((nowMs - task.lastActivityAt) / 1_000));

  return {
    title: task.title,
    statusLabel: presentation.label,
    tone: presentation.tone,
    progressMode: mode,
    progressPercent,
    etaLabel: etaLabel(snapshot),
    stepLabel: task.statusDetail ?? task.currentStep ?? task.phase ?? "任务正在进行",
    updatedLabel: `${ageSeconds} 秒前更新`
  };
}
