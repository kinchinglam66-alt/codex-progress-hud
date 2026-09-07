import {expect, it} from 'vitest';
import {TaskStore} from '../../src/server/task-store.js';
import type {PassiveGoalView} from '../../src/server/passive-goals.js';

const running = (): PassiveGoalView => ({generation: 1, runtime: 'running', status: 'running', activeSeconds: 10,
  prediction: {remainingSeconds: 3600, errorPercent: 30, observedActiveSeconds: 10}, estimateRevision: 1});
it('keeps an unfinished goal visible after a turn stops and hides inferred completion', () => {
  let goal: PassiveGoalView|null = running();
  const store = new TaskStore({now: () => 10000, goalForConversation: () => goal});
  store.apply({taskId: 'one', event: {type: 'turn_started'}}, 0, {conversationKey: 'chat', turnKey: 'turn', isCurrentTurn: true});
  goal = {...running(), runtime: 'waiting', status: 'unknown'};
  store.apply({taskId: 'one', event: {type: 'turn_stopped'}}, 10000);
  expect(store.conversationRows(10000)[0]?.goal).toMatchObject({status: 'unknown', runtime: 'waiting', sampledAtMs: 10000});
  goal = {...goal, status: 'completed'};
  store.refreshPresentation();
  expect(store.snapshot().rows).toEqual([]);
  goal = null; store.refreshPresentation();
  expect(store.snapshot().rows).toEqual([]);
});
it('reclaims inferred-completed capacity without evicting another active goal', () => {
  const goals = new Map([['a', running()], ['b', running()], ['c', running()]]);
  const store = new TaskStore({maxTasks: 2, goalForConversation: key => goals.get(key) ?? null});
  for (const key of ['a', 'b']) store.apply({taskId: key, event: {type: 'turn_started'}}, 0,
    {conversationKey: key, turnKey: key, isCurrentTurn: true});
  expect(store.canAdmit('c')).toBe(false);
  goals.set('a', {...running(), status: 'completed'});
  expect(store.canAdmit('c')).toBe(true);
  store.apply({taskId: 'c', event: {type: 'turn_started'}}, 10, {conversationKey: 'c', turnKey: 'c', isCurrentTurn: true});
  expect(store.conversationRows().map(row => row.conversationKey).sort()).toEqual(['b', 'c']);
});
it('keeps projected snapshots detached from goal ownership', () => {
  const goal = running();
  const store = new TaskStore({goalForConversation: () => goal});
  store.apply({taskId: 'one', event: {type: 'turn_started'}}, 0, {conversationKey: 'chat', turnKey: 'turn', isCurrentTurn: true});
  const row = store.conversationRows()[0]!;
  row.goal!.prediction!.remainingSeconds = 1;
  expect(goal.prediction!.remainingSeconds).toBe(3600);
});
