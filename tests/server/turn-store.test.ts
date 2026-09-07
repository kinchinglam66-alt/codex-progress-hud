import { expect, it } from 'vitest';
import { TaskStore } from '../../src/server/task-store.js';

it('keeps old-turn activity out of follow selection while preserving its history', () => {
  const store = new TaskStore({ now: () => 100 });
  store.apply({ taskId: 'a', event: { type: 'turn_started' } }, 100,
    { conversationKey: 'session_group', turnKey: 'turn_a', isCurrentTurn: true });
  store.apply({ taskId: 'b', event: { type: 'turn_started' } }, 200,
    { conversationKey: 'session_group', turnKey: 'turn_b', isCurrentTurn: true });
  const snapshot = store.apply({ taskId: 'a', event: { type: 'activity_seen', category: 'hook' } }, 300,
    { conversationKey: 'session_group', turnKey: 'turn_a', isCurrentTurn: false });
  expect(snapshot.selectedTaskId).toBe('b');
  expect(snapshot.tasks.find(task => task.id === 'a')).toMatchObject({ conversationKey: 'session_group', isCurrentTurn: false });
  expect(snapshot.tasks).toHaveLength(2);
});

it('starts fresh timing and validation for the next turn without reopening a completed one', () => {
  const store = new TaskStore({ now: () => 100 });
  store.apply({ taskId: 'a', event: { type: 'turn_started' } }, 100,
    { conversationKey: 'session_group', turnKey: 'turn_a', isCurrentTurn: true });
  store.apply({ taskId: 'a', event: { type: 'validation_observed', result: 'passed' } }, 200);
  store.apply({ taskId: 'a', event: { type: 'model_outcome', outcome: 'completed', verified: true } }, 300);
  const snapshot = store.apply({ taskId: 'b', event: { type: 'turn_started' } }, 400,
    { conversationKey: 'session_group', turnKey: 'turn_b', isCurrentTurn: true });
  expect(snapshot.selected?.task).toMatchObject({ id: 'b', activeElapsedMs: 0, status: 'running' });
  expect(snapshot.selected?.task.verificationEvidence).toBeUndefined();
  expect(snapshot.tasks.find(task => task.id === 'a')?.status).toBe('succeeded_verified');
});

it('cannot reassign an existing task to another conversation through metadata', () => {
  const store = new TaskStore({ now: () => 100 });
  store.apply({ taskId: 'a', event: { type: 'turn_started' } }, 100,
    { conversationKey: 'session_group', turnKey: 'turn_a', isCurrentTurn: true });
  expect(() => store.apply({ taskId: 'a', event: { type: 'activity_seen', category: 'hook' } }, 200,
    { conversationKey: 'session_other', turnKey: 'turn_a', isCurrentTurn: true })).toThrow();
});
