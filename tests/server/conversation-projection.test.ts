import { expect, it } from 'vitest';
import { TaskStore } from '../../src/server/task-store.js';
import type { ProgressEnvelope } from '../../src/core/schema.js';

function start(store: TaskStore, id: string, conversationKey = id, at = 0) {
  return store.apply({ taskId: id, title: 'Model supplied title', event: { type: 'turn_started' } }, at,
    { conversationKey, turnKey: id, isCurrentTurn: true });
}
function event(store: TaskStore, id: string, value: ProgressEnvelope['event'], at = 1000) {
  return store.apply({ taskId: id, event: value }, at);
}

it('projects independent progress with unavailable host names, without model title substitution', () => {
  const store = new TaskStore({ now: () => 1000 });
  start(store, 'a'); start(store, 'b');
  event(store, 'a', { type: 'model_progress', phase: 'work', progress: 0.2 });
  event(store, 'b', { type: 'model_progress', phase: 'work', progress: 0.7 });
  expect(store.conversationRows(2000).map(row => [row.task.id, row.task.progress, row.name])).toEqual([
    ['a', 0.2, { value: null, freshness: 'unavailable' }],
    ['b', 0.7, { value: null, freshness: 'unavailable' }]
  ]);
  event(store, 'a', { type: 'validation_observed', result: 'passed' });
  event(store, 'a', { type: 'model_outcome', outcome: 'completed', verified: true });
  expect(store.conversationRows(2000).map(row => row.task.id)).toEqual(['b']);
});

it.each([
  [{ type: 'turn_stopped' }, false],
  [{ type: 'tracking_stopped' }, false],
  [{ type: 'tracking_paused' }, true],
  [{ type: 'waiting', reason: 'approval' }, true],
  [{ type: 'waiting', reason: 'user' }, true],
  [{ type: 'runtime_failed', message: 'synthetic failure' }, true],
  [{ type: 'runtime_interrupted' }, true],
  [{ type: 'session_ended' }, true],
  [{ type: 'lease_lost' }, true],
  [{ type: 'stale_detected' }, true],
  [{ type: 'model_outcome', outcome: 'completed', verified: false }, true]
] satisfies [ProgressEnvelope['event'], boolean][])(
  'filters status produced by %j', (value, visible) => {
    const store = new TaskStore({ now: () => 1000 });
    start(store, 'a'); event(store, 'a', value);
    expect(store.conversationRows(2000)).toHaveLength(visible ? 1 : 0);
  }
);

it('preserves visible conversation order across updates and turn replacement', () => {
  const store = new TaskStore();
  start(store, 'a', 'one'); start(store, 'b', 'two');
  event(store, 'a', { type: 'activity_seen', category: 'hook' });
  start(store, 'c', 'one', 2000);
  expect(store.conversationRows(2000).map(row => row.task.id)).toEqual(['c', 'b']);
  store.setHidden('c', true, 2100);
  expect(store.conversationRows(2200).map(row => row.task.id)).toEqual(['b']);
  store.setHidden('c', false, 2300);
  expect(store.conversationRows(2300).map(row => row.task.id)).toEqual(['b', 'c']);
});

it('never resurrects an old failure after the current turn leaves the visible set', () => {
  const store = new TaskStore();
  start(store, 'a', 'same'); event(store, 'a', { type: 'runtime_failed', message: 'synthetic failure' });
  start(store, 'b', 'same', 2000);
  event(store, 'b', { type: 'turn_stopped' }, 3000);
  expect(store.conversationRows(3000)).toEqual([]);
});

it('does not invent a conversation for a legacy unidentified task', () => {
  const store = new TaskStore();
  store.apply({ taskId: 'legacy', event: { type: 'turn_started' } }, 0);
  expect(store.conversationRows(1000)).toEqual([]);
});

it('protects visible current warnings from retention while pruning superseded ones', () => {
  const store = new TaskStore({ terminalRetentionMs: 100, now: () => 5000 });
  start(store, 'a'); event(store, 'a', { type: 'runtime_failed', message: 'synthetic failure' }, 10);
  store.sweep(200);
  expect(store.has('a', 200)).toBe(true);
  expect(store.conversationRows(200).map(row => row.task.id)).toEqual(['a']);
  start(store, 'b', 'a', 300);
  store.sweep(400);
  expect(store.has('a', 400)).toBe(false);
});

it('rejects excess conversations without evicting visible work or changing current identity', () => {
  const store = new TaskStore({ maxTasks: 1 });
  start(store, 'a', 'one');
  const result = start(store, 'b', 'two', 100);
  expect(result.tasks.map(task => task.id)).toEqual(['a']);
  expect(result.turnTracking?.capacityReached).toBe(true);
  expect(store.conversationRows(100).map(row => row.task.id)).toEqual(['a']);
  start(store, 'replacement', 'one', 200);
  expect(store.conversationRows(200).map(row => row.task.id)).toEqual(['replacement']);
});

it('does not let callers mutate stored state through projected rows', () => {
  const store = new TaskStore(); start(store, 'a');
  const rows = store.conversationRows(100);
  rows[0]!.task.status = 'idle';
  expect(store.conversationRows(100)[0]!.task.status).toBe('running');
});

it('does not duplicate complete plans in the multi-row wire projection', () => {
  const store = new TaskStore(); start(store, 'a');
  event(store, 'a', { type: 'plan_updated', steps: [{title:'Large plan entry',status:'pending'}] }, 100);
  expect(store.snapshot().selected?.task.plan).toHaveLength(1);
  expect(store.snapshot().rows?.[0]?.task.plan).toEqual([]);
});

it('bounds a full 32-conversation aggregate with long Unicode names and plans', () => {
  const store = new TaskStore({nameForConversation:()=>({value:'名'.repeat(1024),freshness:'fresh'})});
  for(let index=0;index<32;index++) {
    const id=String(index);
    start(store,id);
    event(store,id,{type:'plan_updated',steps:Array.from({length:100},()=>({
      title:'步'.repeat(160),status:'pending' as const
    }))},100);
  }
  const snapshot=store.snapshot();
  expect(snapshot.rows).toHaveLength(32);
  expect(snapshot.rows?.every(row=>row.task.plan.length===0)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(512*1024);
});
