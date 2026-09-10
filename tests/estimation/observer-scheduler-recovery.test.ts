import {expect, it} from 'vitest';
import {ObserverScheduler, type ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverResult} from '../../src/estimation/observer-provider.js';

const failure: ObserverResult = {status: 'process_error', interpretation: null, usage: null};
const success: ObserverResult = {
  status: 'interpreted',
  interpretation: {relation: 'continue', status: 'running', summary: 'ordinary recovery observation', estimate: {remainingSeconds: 120, errorPercent: 20}},
  usage: {kind: 'subscription-tokens', inputTokens: 4, outputTokens: 1, cachedInputTokens: 0},
};

it('re-enables ordinary observation after the real global scheduler safety stop', async () => {
  let now = 0;
  let disabled = false;
  let active = false;
  const calls: Array<{finish(result: ObserverResult): void}> = [];
  const worker: ObserverWorker & {rearm(): void} = {
    observe: (_input, _signal) => {
      active = true;
      return new Promise(resolve => calls.push({finish(result) {active = false; resolve(result);}}));
    },
    status: () => ({active, disabled, poisoned: false}),
    disable: () => {disabled = true;},
    rearm: () => {disabled = false;},
    close: async () => {disabled = true;},
  };
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts);
  const observations: unknown[] = [];
  const scheduler = new ObserverScheduler({contexts, goals, workers: [worker], now: () => now, onObservation: record => observations.push(record)});
  const key = normalizeHookInput('UserPromptSubmit', {session_id: 'scheduler-recovery', turn_id: 'turn', tool_use_id: 'tool'}, now, 'protected-observer-scheduler-recovery-token-123456789').envelope.sessionKey;
  const envelope = normalizeHookInput('UserPromptSubmit', {session_id: 'scheduler-recovery', turn_id: 'turn', tool_use_id: 'tool'}, now, 'protected-observer-scheduler-recovery-token-123456789').envelope;
  envelope.content = {kind: 'user', text: 'task data', truncated: false};
  goals.observe(envelope, true, now);
  contexts.ingest(envelope, now);
  scheduler.changed(key, 'prompt');
  now = 15_000;
  expect(goals.scheduling(key, now)).toMatchObject({ready: true});
  scheduler.tick();
  expect(calls).toHaveLength(1);
  calls[0]!.finish(failure);
  await Promise.resolve();
  await Promise.resolve();
  expect(scheduler.stats().disabled).toBe(true);

  const recoveryGeneration = await scheduler.prepareRecovery();
  worker.rearm();
  await scheduler.restoreRecovery(recoveryGeneration);
  now = 100_000;
  const secondEnvelope = normalizeHookInput('UserPromptSubmit', {session_id: 'scheduler-recovery', turn_id: 'turn-2', tool_use_id: 'tool-2'}, now, 'protected-observer-scheduler-recovery-token-123456789').envelope;
  secondEnvelope.content = {kind: 'user', text: 'new ordinary task data', truncated: false};
  goals.observe(secondEnvelope, true, now);
  contexts.ingest(secondEnvelope, now);
  scheduler.changed(key, 'prompt');
  scheduler.tick();
  now = 111_000;
  scheduler.tick();
  expect(calls).toHaveLength(2);
  calls[1]!.finish(success);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  await scheduler.close();
});

it('drains a second active flight and refuses poisoned slots before recovery restore', async () => {
  let now = 0;
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts);
  const calls: Array<{finish(result: ObserverResult): void}> = [];
  const states = [{active: false, disabled: false, poisoned: false}, {active: false, disabled: false, poisoned: false}];
  const workers: ObserverWorker[] = states.map((state) => ({
    observe: () => { state.active = true; return new Promise(resolve => calls.push({finish(result) {state.active = false; resolve(result);}})); },
    status: () => ({...state}),
    disable: () => {state.disabled = true;},
    close: async () => {state.disabled = true;},
  }));
  const scheduler = new ObserverScheduler({contexts, goals, workers, now: () => now});
  for (const session of ['active-one', 'active-two']) {
    const envelope = normalizeHookInput('UserPromptSubmit', {session_id: session, turn_id: 'turn', tool_use_id: `tool-${session}`}, now, 'protected-observer-scheduler-recovery-token-123456789').envelope;
    envelope.content = {kind: 'user', text: session, truncated: false};
    goals.observe(envelope, true, now); contexts.ingest(envelope, now); scheduler.changed(envelope.sessionKey, 'prompt');
  }
  now = 15_000;
  scheduler.tick();
  expect(calls).toHaveLength(2);
  calls[0]!.finish(failure);
  await Promise.resolve();
  await Promise.resolve();
  let drained = false;
  const pending = scheduler.prepareRecovery().then(() => {drained = true;});
  await Promise.resolve();
  expect(drained).toBe(false);
  calls[1]!.finish(failure);
  await pending;
  expect(drained).toBe(true);
  states.forEach(state => {state.disabled = false;});
  await scheduler.restoreRecovery(1);
  states[1]!.poisoned = true;
  await expect(scheduler.prepareRecovery()).rejects.toThrow('OBSERVER_RECOVERY_CLOSE_UNCONFIRMED');
  await scheduler.close();
});
