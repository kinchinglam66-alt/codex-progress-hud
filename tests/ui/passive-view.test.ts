import {expect, it} from 'vitest';
import {TaskStore} from '../../src/server/task-store.js';
import {buildConversationViews,createConversationViewProjector} from '../../src/ui/view-model.js';
import type {PassiveGoalView} from '../../src/server/passive-goals.js';
import type {ObserverDiagnostics} from '../../src/core/observer-diagnostics.js';

function row(patch: Partial<PassiveGoalView> = {}) {
  const store = new TaskStore({goalForConversation: () => ({generation: 1, estimateRevision: 1,
    status: 'running', runtime: 'running', activeSeconds: 10,
    prediction: {remainingSeconds: 90000, observedActiveSeconds: 10, errorPercent: 30}, ...patch})});
  store.apply({taskId: 'task', event: {type: 'turn_started'}}, 0,
    {conversationKey: 'chat', turnKey: 'turn', isCurrentTurn: true});
  return store.conversationRows(0)[0]!;
}

it('uses display-only countdown overrides without altering progress or uncertainty',()=>{
  const value=row({activeSeconds:100,prediction:{remainingSeconds:100,observedActiveSeconds:100,errorPercent:30}});
  const before=structuredClone(value),project=createConversationViewProjector();
  const view=project([value],0,[],new Map([['chat',104]]))[0]!;
  expect(view.etaLabel).toBe('00:01:44 · 上次估时误差 ±30%');
  expect(view.progressPercent).toBe(50);
  expect(value).toEqual(before);
});

it('projects elapsed over estimated total and never retreats when ETA increases',()=>{
  const project=createConversationViewProjector();
  const value=row({activeSeconds:100,prediction:{remainingSeconds:100,observedActiveSeconds:100,errorPercent:30}});
  expect(project([value])[0]).toMatchObject({progressPercent:50,progressMode:'determinate',progressLabel:'预估进度'});
  expect(project([value],60)[0]?.progressPercent).toBe(80);
  value.goal!.activeSeconds=160;
  value.goal!.prediction={remainingSeconds:900,observedActiveSeconds:160,errorPercent:30};
  expect(project([value])[0]?.progressPercent).toBe(80);
  value.goal!.activeSeconds=900;
  expect(project([value])[0]?.progressPercent).toBe(84);
});
it.each(['waiting','paused','interrupted','failed'] as const)('freezes progress while %s despite a revised prediction',runtime=>{
  const project=createConversationViewProjector();
  const value=row({activeSeconds:100,prediction:{remainingSeconds:100,observedActiveSeconds:100,errorPercent:30}});
  expect(project([value])[0]?.progressPercent).toBe(50);
  value.goal!.runtime=runtime;value.goal!.prediction!.remainingSeconds=1;
  expect(project([value],500)[0]?.progressPercent).toBe(50);
  value.goal!.runtime='running';
  expect(project([value])[0]?.progressPercent).toBe(99);
});
it('retains established progress without an estimate but never fabricates an initial value',()=>{
  const project=createConversationViewProjector(),value=row({prediction:null});
  expect(project([value])[0]?.progressPercent).toBeNull();
  value.goal!.activeSeconds=100;value.goal!.prediction={remainingSeconds:100,observedActiveSeconds:100,errorPercent:30};
  expect(project([value])[0]?.progressPercent).toBe(50);
  value.goal!.prediction=null;
  expect(project([value])[0]?.progressPercent).toBe(50);
});
it('isolates equal-name conversations and resets a new goal or removed task',()=>{
  const project=createConversationViewProjector();
  const a=row({activeSeconds:100,prediction:{remainingSeconds:100,observedActiveSeconds:100,errorPercent:30}});
  const b=row({activeSeconds:0,prediction:{remainingSeconds:100,observedActiveSeconds:0,errorPercent:30}});
  b.conversationKey='other';
  expect(project([a,b]).map(v=>v.progressPercent)).toEqual([50,0]);
  a.goal!.generation++;a.goal!.activeSeconds=0;a.goal!.prediction!.observedActiveSeconds=0;
  expect(project([a])[0]?.progressPercent).toBe(0);
  expect(project([])).toEqual([]);
  expect(project([row({prediction:null})])[0]?.progressPercent).toBeNull();
});
it('caps overdue progress below completion and continues hiding completed goals',()=>{
  const project=createConversationViewProjector();
  const value=row({activeSeconds:200,prediction:{remainingSeconds:100,observedActiveSeconds:0,errorPercent:30}});
  expect(project([value])[0]?.progressPercent).toBe(99);
  value.goal!.status='completed';expect(project([value])).toEqual([]);
});
it('retains the peak across same-goal snapshot refreshes and rejects invalid estimates',()=>{
  const project=createConversationViewProjector();
  const value=row({activeSeconds:100,prediction:{remainingSeconds:100,observedActiveSeconds:100,errorPercent:30}});
  expect(project([value],20)[0]?.progressPercent).toBe(60);
  expect(project([structuredClone(value)])[0]?.progressPercent).toBe(60);
  value.goal!.prediction!.remainingSeconds=Number.NaN;
  expect(project([value])[0]?.progressPercent).toBe(60);
  expect(createConversationViewProjector()([value])[0]?.progressPercent).toBeNull();
  value.task.id='replacement-task';value.goal!.prediction=null;
  expect(project([value])[0]?.progressPercent).toBeNull();
});

it('shows whole-goal time beyond 24 hours without inventing completion percentage', () => {
  const view = buildConversationViews([row()], 1)[0]!;
  expect(view.etaLabel).toBe('24:59:59 · 上次估时误差 ±30%');
  expect(view.statusLabel).toBe('本轮执行中');
  expect(view.progressPercent).toBeNull();
  expect(view.progressMode).toBe('indeterminate');
});
it.each([
  ['pending','等待首次估时'],['history_loading','正在加载任务历史'],['estimating','正在估时'],
  ['history_unavailable','任务历史暂不可用，正在重试读取'],
  ['insufficient_context','依据不足，暂无法估时'],['call_failed','估时调用失败'],
  ['setup_failed','估时启动失败，请检查运行环境或授权'],
  ['rate_limited','估时受限，等待可用额度'],['disabled','估时已停用，请查看诊断']
] as const)('shows a distinct missing estimate reason for %s',(state,label)=>{
  const value=row({prediction:null});value.observer={state,estimateAgeSeconds:null,callsLastHour:1,retryPending:false};
  expect(buildConversationViews([value])[0]?.etaLabel).toBe(label);
});
it('keeps valid ETA and separately shows freshness and static diagnostics',()=>{
  const value=row();value.observer={state:'call_failed',estimateAgeSeconds:120,callsLastHour:2,retryPending:true};
  const view=buildConversationViews([value],60)[0]!;
  expect(view.etaLabel).toBe('24:59:00 · 上次估时误差 ±30%');
  expect(view.freshnessLabel).toBe('估值更新于 3 分钟前');
  expect(view.diagnosticLabel).toContain('估时调用失败');
  expect(view.diagnosticLabel).toContain('小时内尝试 2 次');
});
it.each(['waiting', 'paused'] as const)('freezes %s while another running row counts down', runtime => {
  const views = buildConversationViews([row({runtime, status: runtime}), row()], 3600);
  expect(views[0]?.etaLabel).toBe('25:00:00 · 上次估时误差 ±30%');
  expect(views[0]?.progressMode).toBe('paused');
  expect(views[1]?.etaLabel).toBe('24:00:00 · 上次估时误差 ±30%');
});
it('shows overdue as pending update, never as task completion', () => {
  const view = buildConversationViews([row()], 90000)[0]!;
  expect(view.etaLabel).toBe('已超出预计时间 · 等待重新估时');
  expect(view.statusLabel).toBe('本轮执行中');
  expect(view.progressPercent).toBeNull();
});
it('keeps unknown and explicit interruptions distinct from completion', () => {
  const unknown = row({status: 'unknown', prediction: null});
  expect(buildConversationViews([unknown])[0]).toMatchObject({etaLabel: '剩余时间未知', statusLabel: '本轮执行中 · 状态待判断'});
  const interrupted = row({runtime: 'interrupted', status: 'interrupted', prediction: null});
  expect(buildConversationViews([interrupted])[0]).toMatchObject({statusLabel: '本轮已中断', etaLabel: '工作计时已停止'});
  const completed = row(); completed.goal!.status = 'completed';
  const stopped = row(); stopped.goal!.runtime = 'stopped';
  expect(buildConversationViews([completed, stopped])).toEqual([]);
});
it.each([
  ['failed','本轮失败'],['waiting','本轮等待用户'],['paused','本轮跟踪已暂停']
] as const)('labels %s as the current turn', (runtime,label)=>{
  expect(buildConversationViews([row({runtime,status:runtime})])[0]?.statusLabel).toBe(label);
});
