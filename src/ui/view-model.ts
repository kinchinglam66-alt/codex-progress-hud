import type { HudSnapshot } from "../server/task-store.js";
import type { TaskStatus } from "../core/types.js";
import type { ConversationRow } from "../server/conversation-projection.js";
import {projectCountdown} from './countdown.js';
import {normalizeAdmissionReason, type AdmissionReason, type ObserverDiagnostics,type ObserverContextState} from '../core/observer-diagnostics.js';

const contextLabels:Record<ObserverContextState,string>={history_loading:'正在读取完整对话',context_preparing:'正在准备完整上下文',
  context_native:'已继承原生上下文',native_context_failed:'原生上下文准备失败',estimate_timeout:'估时超时（30秒），等待后续更新',
  context_images_missing:'部分历史图片缺失',
  image_context_unsupported:'当前估时路径不支持图片上下文',
  context_full:'已使用完整可读上下文',context_compressed:'早期历史已压缩',history_incomplete:'部分历史不可读，估时依据不完整',
  capacity_unknown:'模型容量未知，请在设置中填写',context_too_large:'上下文超出模型容量，无法完整发送',compression_failed:'历史压缩失败，等待后续重试'};

const observerLabels:Record<ObserverDiagnostics['state'],string>={pending:'等待首次估时',history_loading:'正在加载任务历史',
  history_unavailable:'任务历史暂不可用，正在重试读取',
  estimating:'正在估时',insufficient_context:'依据不足，暂无法估时',call_failed:'估时调用失败',
  unknown_response:'估时返回不确定结果',process_error:'估时进程出错',rejected_result:'估时结果未采纳',
  setup_failed:'估时启动失败，请检查运行环境或授权',
  rate_limited:'估时受限，等待可用额度',admission_blocked:'本地估时暂受限，请查看诊断',disabled:'估时已停用，请查看诊断',ready:'估值可用'};
const admissionLabels:Record<AdmissionReason,string>={
  unresolved_previous_call:'旧估时调用尚未确认结束，请在设置中恢复',
  cooldown:'估时正在本地冷却，稍后重试',retry_backoff:'估时正在退避等待，稍后重试',
  no_eligible_task:'暂无可估时的任务',half_open_busy:'正在进行恢复试探，请稍候',
  unsafe_unknown:'上次估时未安全结算，请在设置中恢复',local_policy:'本地估时暂受限，请查看设置中的恢复状态',
};
function observerLabel(observer:ObserverDiagnostics):string{
  if((observer.pendingCriticalEvents??0)>0&&['ready','estimating','rejected_result'].includes(observer.state))return '新进展已到达，等待更新估时';
  if(observer.state==='pending'){
    switch(observer.schedulingReason){
      case 'account_refresh_failed':return '账户定期检查失败，等待自动重验（不代表已退出登录）';
      case 'worker_closing':return '旧估时进程正在关闭，等待释放';
      case 'worker_cleanup_pending':return '旧估时进程清理尚未确认';
      case 'provider_unavailable':return '估时提供方未就绪，请查看设置';
      case 'runtime_not_ready':return '估时运行时未就绪，请查看账户检查状态';
    }
  }
  if(observer.state==='pending'&&observer.schedulingReason==='worker_unavailable')
    return '估时提供方暂不可用，请查看设置中的账户与启用状态';
  if(observer.state==='pending'&&observer.schedulingReason==='recovery_cooldown')
    return '估时正在恢复冷却，稍后重试';
  if(observer.state==='disabled'&&observer.stopReason){
    const reasons={invalid_clock:'调度时钟异常',scheduler_exception:'调度检查异常',accounting_error:'本次记账异常'};
    return `估时已停用：${reasons[observer.stopReason]}（不等同于历史未知用量）`;
  }
  if(observer.contextState&&['pending','estimating','process_error','call_failed'].includes(observer.state)&&
    !['context_full','context_compressed','context_native'].includes(observer.contextState))return contextLabels[observer.contextState];
  return observer.state==='admission_blocked'?admissionLabels[normalizeAdmissionReason(observer.admissionReason)]:observerLabels[observer.state];
}
function observerPresentation(observer:ObserverDiagnostics,elapsedSeconds:number){
  const age=observer.estimateAgeSeconds===null?null:observer.estimateAgeSeconds+(Number.isFinite(elapsedSeconds)?Math.max(0,elapsedSeconds):0);
  return {freshnessLabel:age===null?'':age<60?'估值刚刚更新':age<3600?`估值更新于 ${Math.floor(age/60)} 分钟前`:`估值更新于 ${Math.floor(age/3600)} 小时前`,
    diagnosticLabel:`${observerLabel(observer)}${observer.contextState&&observerLabel(observer)!==contextLabels[observer.contextState]?` · ${contextLabels[observer.contextState]}`:''}${(observer.missingImages??0)>0&&observer.contextState!=='context_images_missing'?' · 部分历史图片缺失':''} · 小时内尝试 ${observer.callsLastHour} 次${observer.retryPending?' · 冷却后重试一次':''}`};
}

export function buildConversationViews(rows: readonly ConversationRow[], elapsedSeconds = 0, updatedKeys: readonly string[] = [],displayedSeconds:ReadonlyMap<string,number>=new Map()) {
  return rows.filter(row => row.goal === undefined ||
    (row.goal.status !== 'completed' && row.goal.runtime !== 'stopped')).map(row => {
    const view = row.goal === undefined ? buildHudView({
      revision: 0, selectedTaskId: row.task.id, selectionMode: "follow_activity",
      tasks: [], selected: { task: row.task, eta: row.eta },
      compatibility: { incompatibleClientSeen: false }
    }) : passivePresentation(row.goal, elapsedSeconds, row.observer,displayedSeconds.get(row.conversationKey));
    return {
      key: row.conversationKey, taskId: row.task.id,
      executing:row.goal===undefined?row.task.status==='running':row.goal.runtime==='running'&&!row.goal.runtimeUncertain,
      title: row.name.value ?? "聊天名称暂不可用",
      statusLabel: view.statusLabel, tone: view.tone,
      progressMode: view.progressMode, progressPercent: view.progressPercent,
      progressLabel: row.goal === undefined ? '任务进度' : '预估进度',
      etaLabel: view.etaLabel + (row.goal?.prediction != null && updatedKeys.includes(row.conversationKey) ? ' · 已更新' : '')+
        (row.observer?.contextState==='context_images_missing'||(row.observer?.missingImages??0)>0?' · 部分历史图片缺失':''),
      nameFreshness: row.name.freshness,
      milestoneLabel:row.goal?milestoneLabel(row.goal,elapsedSeconds):'',
      ...(row.observer?observerPresentation(row.observer,elapsedSeconds):{})
    };
  });
}

function milestoneLabel(goal:NonNullable<ConversationRow['goal']>,elapsedSeconds:number):string {
  const milestone=goal.progressState?.milestone;
  if(!milestone||['stopped','failed','interrupted'].includes(goal.runtime)||goal.status==='completed')return '';
  if(milestone.judgment==='observed_complete')return `下一里程碑：${milestone.definition} · 已观察到结束，等待重估`;
  if(milestone.judgment==='inferred_complete')return `下一里程碑：${milestone.definition} · 推断完成，待核实`;
  const active=goal.activeSeconds+(goal.runtime==='running'&&!goal.runtimeUncertain&&Number.isFinite(elapsedSeconds)?Math.max(0,elapsedSeconds):0);
  const countdown=projectCountdown({prediction:milestone.prediction,activeSeconds:active,state:goal.runtime==='running'?'running':goal.runtime==='paused'?'paused':'waiting'});
  return `下一里程碑：${milestone.definition} · ${countdown.status==='unknown'?'时间未知':countdown.status==='overdue'?'超出估时，等待重估':countdown.timeText}`;
}

/** Display-only history, scoped to this HUD and goal identity. No inference or work-state writes. */
export function createConversationViewProjector() {
  const peaks=new Map<string,{taskId:string;generation:number;percent:number|null}>();
  return (rows:readonly ConversationRow[],elapsedSeconds=0,updatedKeys:readonly string[]=[],displayedSeconds:ReadonlyMap<string,number>=new Map()) => {
    const views=buildConversationViews(rows,elapsedSeconds,updatedKeys,displayedSeconds);
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
      if(Number.isFinite(goal.progressFloor)&&goal.progressFloor!>0&&goal.progressFloor!<=99)
        peak.percent=Math.max(peak.percent??0,Math.floor(goal.progressFloor!));
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

function passivePresentation(goal: NonNullable<ConversationRow['goal']>, elapsedSeconds: number,observer?:ObserverDiagnostics,displayedSeconds?:number):
  Pick<HudView, 'statusLabel'|'tone'|'progressMode'|'progressPercent'|'etaLabel'> {
  const running = goal.runtime === 'running';
  const terminal = goal.runtime === 'interrupted' || goal.runtime === 'failed';
  const statusLabel = goal.runtimeUncertain ? '本轮状态待确认'
    : goal.runtime === 'interrupted' ? '本轮已中断'
    : goal.runtime === 'failed' ? '本轮失败'
    : goal.runtime === 'paused' ? '本轮跟踪已暂停'
    : running ? (goal.status === 'unknown' ? '本轮执行中 · 状态待判断' : '本轮执行中')
    : goal.status === 'waiting' ? '本轮等待用户' : '本轮等待中 · 状态待判断';
  const delta = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const countdown = projectCountdown({prediction: goal.prediction,
    activeSeconds: goal.activeSeconds + (running ? delta : 0),
    state: running ? 'running' : goal.runtime === 'paused' ? 'paused' : 'waiting'});
  const display=goal.prediction&&countdown.status!=='unknown'&&countdown.status!=='overdue'&&
    displayedSeconds!==undefined&&Number.isFinite(displayedSeconds)&&displayedSeconds>=0
    ?projectCountdown({prediction:{...goal.prediction,remainingSeconds:displayedSeconds,observedActiveSeconds:0},
      activeSeconds:0,state:running?'running':'waiting'}):countdown;
  const overdueLabel = (): string => {
    if (!running) return '已超出预计时间 · 工作计时已暂停';
    const action = observer?.state === 'estimating' ? '正在重新估时'
      : observer?.state === 'call_failed' || observer?.state === 'process_error' || observer?.state === 'unknown_response' || observer?.state === 'rejected_result' || observer?.state === 'setup_failed' || observer?.state === 'disabled'
        ? '估时暂不可用'
        : observer?.state === 'admission_blocked' ? observerLabel(observer)
        : observer?.state === 'rate_limited' ? '重估受限，等待额度' : '等待重新估时';
    return `已超出预计时间 · ${action}`;
  };
  const condition=goal.estimateCondition;
  const conditionLabel=condition?.displayPath==='report_blocker'?' · 条件估时：若报告阻塞结束'
    :condition?.displayPath==='continue_work'?' · 条件估时：若继续实施至本轮结束'
    :condition&&['missing_conditions','unknown_path'].includes(condition.issue)?' · 粗略估时／适用条件未明'
    :condition?' · 粗略估时／条件不一致':'';
  const etaLabel = terminal ? '工作计时已停止'
    : countdown.status === 'unknown' ? goal.runtime==='paused'?'工作计时已暂停':observer?observerLabel(observer):'剩余时间未知'
    : countdown.status === 'overdue' ? overdueLabel()+conditionLabel
    : `${display.timeText} · 上次估时误差 ${countdown.uncertaintyText}${conditionLabel}${goal.estimateUncertain?' · 粗略估时／结束方式未明':''}`;
  return {statusLabel, tone: terminal ? 'danger' : running ? 'active' : 'waiting',
    progressMode: running ? 'indeterminate' : 'paused', progressPercent: null, etaLabel};
}

export type ConversationView = ReturnType<typeof buildConversationViews>[number];

export function conversationActivityLabel(views:readonly ConversationView[]):string {
  if(views.length===0)return '暂无进行中任务';
  const running=views.filter(view=>view.executing).length,other=views.length-running;
  return `${running===0?'暂无执行中任务':`${running} 个执行中`}${other===0?'':` · ${other} 个待处理`}`;
}

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
