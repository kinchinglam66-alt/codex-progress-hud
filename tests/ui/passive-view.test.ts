import {expect, it} from 'vitest';
import {TaskStore} from '../../src/server/task-store.js';
import {buildConversationViews} from '../../src/ui/view-model.js';
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

it('shows whole-goal time beyond 24 hours without inventing completion percentage', () => {
  const view = buildConversationViews([row()], 1)[0]!;
  expect(view.etaLabel).toBe('24:59:59 ±31%');
  expect(view.statusLabel).toBe('执行中');
  expect(view.progressPercent).toBeNull();
  expect(view.progressMode).toBe('indeterminate');
});
it.each([
  ['pending','等待首次估时'],['history_loading','正在加载任务历史'],['estimating','正在估时'],
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
  expect(view.etaLabel).toBe('24:59:00 ±31%');
  expect(view.freshnessLabel).toBe('估值更新于 3 分钟前');
  expect(view.diagnosticLabel).toContain('估时调用失败');
  expect(view.diagnosticLabel).toContain('小时内尝试 2 次');
});
it.each(['waiting', 'paused'] as const)('freezes %s while another running row counts down', runtime => {
  const views = buildConversationViews([row({runtime, status: runtime}), row()], 3600);
  expect(views[0]?.etaLabel).toBe('25:00:00 ±30%');
  expect(views[0]?.progressMode).toBe('paused');
  expect(views[1]?.etaLabel).toBe('24:00:00 ±32%');
});
it('shows overdue as pending update, never as task completion', () => {
  const view = buildConversationViews([row()], 90000)[0]!;
  expect(view.etaLabel).toBe('00:00:00 · 已超出估时，等待更新');
  expect(view.statusLabel).toBe('执行中');
  expect(view.progressPercent).toBeNull();
});
it('keeps unknown and explicit interruptions distinct from completion', () => {
  const unknown = row({status: 'unknown', prediction: null});
  expect(buildConversationViews([unknown])[0]).toMatchObject({etaLabel: '剩余时间未知', statusLabel: '执行中 · 目标状态待判断'});
  const interrupted = row({runtime: 'interrupted', status: 'interrupted', prediction: null});
  expect(buildConversationViews([interrupted])[0]).toMatchObject({statusLabel: '任务已中断', etaLabel: '工作计时已停止'});
  const completed = row(); completed.goal!.status = 'completed';
  const stopped = row(); stopped.goal!.runtime = 'stopped';
  expect(buildConversationViews([completed, stopped])).toEqual([]);
});
