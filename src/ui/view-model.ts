import type { HudSnapshot } from "../server/task-store.js";
import type { TaskStatus } from "../core/types.js";
import type { ConversationRow } from "../server/conversation-projection.js";
import {projectCountdown} from './countdown.js';
import type {ObserverDiagnostics} from '../core/observer-diagnostics.js';

const observerLabels:Record<ObserverDiagnostics['state'],string>={pending:'等待首次估时',history_loading:'正在加载任务历史',
  estimating:'正在估时',insufficient_context:'依据不足，暂无法估时',call_failed:'估时调用失败',
  setup_failed:'估时启动失败，请检查运行环境或授权',
  rate_limited:'估时受限，等待可用额度',disabled:'估时已停用，请查看诊断',ready:'估值可用'};
function observerPresentation(observer:ObserverDiagnostics,elapsedSeconds:number){
  const age=observer.estimateAgeSeconds===null?null:observer.estimateAgeSeconds+(Number.isFinite(elapsedSeconds)?Math.max(0,elapsedSeconds):0);
  return {freshnessLabel:age===null?'':age<60?'估值刚刚更新':age<3600?`估值更新于 ${Math.floor(age/60)} 分钟前`:`估值更新于 ${Math.floor(age/3600)} 小时前`,
    diagnosticLabel:`${observerLabels[observer.state]} · 小时内尝试 ${observer.callsLastHour} 次${observer.retryPending?' · 冷却后重试一次':''}`};
}

export function buildConversationViews(rows: readonly ConversationRow[], elapsedSeconds = 0, updatedKeys: readonly string[] = []) {
  return rows.filter(row => row.goal === undefined ||
    (row.goal.status !== 'completed' && row.goal.runtime !== 'stopped')).map(row => {
    const view = row.goal === undefined ? buildHudView({
      revision: 0, selectedTaskId: row.task.id, selectionMode: "follow_activity",
      tasks: [], selected: { task: row.task, eta: row.eta },
      compatibility: { incompatibleClientSeen: false }
    }) : passivePresentation(row.goal, elapsedSeconds, row.observer);
    return {
      key: row.conversationKey, taskId: row.task.id,
      title: row.name.value ?? "聊天名称暂不可用",
      statusLabel: view.statusLabel, tone: view.tone,
      progressMode: view.progressMode, progressPercent: view.progressPercent,
      progressLabel: row.goal === undefined ? '任务进度' : '预估进度',
      etaLabel: view.etaLabel + (row.goal?.prediction != null && updatedKeys.includes(row.conversationKey) ? ' · 已更新' : ''),
      nameFreshness: row.name.freshness,
      ...(row.observer?observerPresentation(row.observer,elapsedSeconds):{})
    };
  });
}

/** Display-only history, scoped to this HUD and goal identity. No inference or work-state writes. */
export function createConversationViewProjector() {
  const peaks=new Map<string,{taskId:string;generation:number;percent:number|null}>();
  return (rows:readonly ConversationRow[],elapsedSeconds=0,updatedKeys:readonly string[]=[]) => {
    const views=buildConversationViews(rows,elapsedSeconds,updatedKeys);
    const present=new Set(views.map(view=>view.key));
    for(const key of peaks.keys())if(!present.has(key))peaks.delete(key);
    const byKey=new Map(rows.map(row=>[row.conversationKey,row]));
    return views.map(view=>{
      const goal=byKey.get(view.key)?.goal;
      if(!goal){peaks.delete(view.key);return view;}
      let peak=peaks.get(view.key);
      if(!peak || peak.generation!==goal.generation || peak.taskId!==view.taskId){
        peak={taskId:view.taskId,generation:goal.generation,percent:null};peaks.set(view.key,peak);
      }
      const running=goal.runtime==='running';
      const delta=running&&Number.isFinite(elapsedSeconds)?Math.max(0,elapsedSeconds):0;
      const active=goal.activeSeconds+delta;
      // An existing paused/waiting/terminal display cannot jump due to a late estimate.
      if(running || peak.percent===null){
        const countdown=projectCountdown({prediction:goal.prediction,activeSeconds:active,
          state:running?'running':goal.runtime==='paused'?'paused':'waiting'});
        if(goal.prediction && countdown.status!=='unknown'){
          const remaining=Math.max(0,goal.prediction.remainingSeconds-(active-goal.prediction.observedActiveSeconds));
          const total=active+remaining;
          const percent=total>0?Math.min(99,Math.floor(active/total*100)):0;
          peak.percent=Math.max(peak.percent??0,percent);
        }
      }
      return {...view,progressPercent:peak.percent,
        progressMode:peak.percent===null?view.progressMode:running?'determinate' as const:'paused' as const};
    });
  };
}

function passivePresentation(goal: NonNullable<ConversationRow['goal']>, elapsedSeconds: number,observer?:ObserverDiagnostics):
  Pick<HudView, 'statusLabel'|'tone'|'progressMode'|'progressPercent'|'etaLabel'> {
  const running = goal.runtime === 'running';
  const terminal = goal.runtime === 'interrupted' || goal.runtime === 'failed';
  const statusLabel = goal.runtime === 'interrupted' ? '任务已中断'
    : goal.runtime === 'failed' ? '任务失败'
    : goal.runtime === 'paused' ? '跟踪已暂停'
    : running ? (goal.status === 'unknown' ? '执行中 · 目标状态待判断' : '执行中')
    : goal.status === 'waiting' ? '等待用户' : '等待中 · 目标状态待判断';
  const delta = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const countdown = projectCountdown({prediction: goal.prediction,
    activeSeconds: goal.activeSeconds + (running ? delta : 0),
    state: running ? 'running' : goal.runtime === 'paused' ? 'paused' : 'waiting'});
  const etaLabel = terminal ? '工作计时已停止'
    : countdown.status === 'unknown' ? goal.runtime==='paused'?'工作计时已暂停':observer?observerLabels[observer.state]:'剩余时间未知'
    : countdown.status === 'overdue' ? '00:00:00 · 已超出估时，等待更新'
    : `${countdown.timeText} ${countdown.uncertaintyText}`;
  return {statusLabel, tone: terminal ? 'danger' : running ? 'active' : 'waiting',
    progressMode: running ? 'indeterminate' : 'paused', progressPercent: null, etaLabel};
}

export type ConversationView = ReturnType<typeof buildConversationViews>[number];

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
  taskItems: readonly { id: string; title: string; statusLabel: string; selected: boolean }[];
  selectedTaskId: string | null;
  compatibilityBanner: string | null;
  trackingOriginLabel: string | null;
  confidenceLabel: string | null;
  canFollowActivity: boolean;
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
  // Legacy storage names do not represent separate user-facing quality claims.
  completed_unverified: { label: "已完成", tone: "success" },
  succeeded_verified: { label: "已完成", tone: "success" },
  failed: { label: "任务失败", tone: "danger" },
  interrupted: { label: "任务已中断", tone: "danger" }
};

function minuteLabel(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

function etaLabel(snapshot: HudSnapshot): string {
  const status = snapshot.selected?.task.status;
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
  if (snapshot.selected?.eta === null || snapshot.selected === null) return "剩余时间未知";
  return `预计还需 ${minuteLabel(snapshot.selected.eta.lowSeconds)}–${minuteLabel(
    snapshot.selected.eta.highSeconds
  )} 分钟`;
}

function progressMode(status: TaskStatus, progress: number | undefined): ProgressMode {
  if (status === "succeeded_verified" || status === "completed_unverified") return "complete";
  if (status === "paused" || status === "waiting_approval" || status === "waiting_user") {
    return "paused";
  }
  return progress === undefined ? "indeterminate" : "determinate";
}

function confidenceLabel(snapshot: HudSnapshot): string | null {
  const confidence = snapshot.selected?.eta?.confidenceClass;
  return confidence === undefined ? null : `置信度：${confidence === "low" ? "低" : confidence === "medium" ? "中" : "高"}`;
}

function trackingOriginLabel(snapshot: HudSnapshot): string | null {
  return snapshot.selected?.task.trackingOrigin === "late_attach"
    ? "跟踪从任务中途开始"
    : null;
}

function taskItems(snapshot: HudSnapshot): HudView["taskItems"] {
  const groups = new Map([...new Set(snapshot.tasks.flatMap(task =>
    task.conversationKey === undefined ? [] : [task.conversationKey]))].sort().map((key, index) => [key, index + 1]));
  return snapshot.tasks.map((summary) => ({
    id: summary.id,
    title: summary.title,
    statusLabel: (summary.conversationKey === undefined ? "" :
      `对话 ${groups.get(summary.conversationKey)} · ${summary.isCurrentTurn ? "当前轮" : "历史轮"} · `) + (summary.hiddenForTask
      ? `${statusPresentation[summary.status].label}（已隐藏）`
      : statusPresentation[summary.status].label),
    selected: summary.id === snapshot.selectedTaskId
  }));
}

function trackingBanner(snapshot: HudSnapshot): string | null {
  const warnings: string[] = [];
  if (snapshot.compatibility.incompatibleClientSeen) warnings.push("插件与伴侣版本不匹配；请同时更新两者并重启 Codex");
  if (snapshot.turnTracking?.identityUnavailable) warnings.push("曾收到缺少可靠轮次身份的事件；这些事件未用于自动追踪");
  if (snapshot.turnTracking?.orderingUncertain) warnings.push("轮次先后顺序未经宿主确认；当前轮按已接收提示选择");
  if (snapshot.turnTracking?.capacityReached) warnings.push("自动追踪达到安全容量限制；需重新启动伴侣程序");
  return warnings.length === 0 ? null : warnings.join("；");
}

export function buildHudView(snapshot: HudSnapshot, nowMs = Date.now()): HudView {
  if (snapshot.selected === null) {
    return {
      title: "暂无活动任务",
      statusLabel: "空闲",
      tone: "idle",
      progressMode: "indeterminate",
      progressPercent: null,
      etaLabel: "等待 Codex 上报任务",
      stepLabel: "启动任务后将在这里显示进度",
      updatedLabel: "",
      taskItems: taskItems(snapshot),
      selectedTaskId: null,
      compatibilityBanner: trackingBanner(snapshot),
      trackingOriginLabel: null,
      confidenceLabel: null,
      canFollowActivity: snapshot.selectionMode !== "follow_activity"
    };
  }

  const task = snapshot.selected.task;
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
    updatedLabel: `${ageSeconds} 秒前更新`,
    taskItems: taskItems(snapshot),
    selectedTaskId: snapshot.selectedTaskId,
    compatibilityBanner: trackingBanner(snapshot),
    trackingOriginLabel: trackingOriginLabel(snapshot),
    confidenceLabel: confidenceLabel(snapshot),
    canFollowActivity: snapshot.selectionMode !== "follow_activity"
  };
}
