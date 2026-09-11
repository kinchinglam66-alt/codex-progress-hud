import {afterEach, expect, it} from 'vitest';
import {ObserverScheduler, type ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => {resolve = value;});
  return {promise, resolve};
}

function workerPool() {
  const pending = new Map<string, ReturnType<typeof deferred<{status: 'interpreted'; interpretation: {relation: 'continue'; status: 'running'; summary: string; estimate: {remainingSeconds: number; errorPercent: number}}; usage: {kind: 'subscription-tokens'; inputTokens: number; outputTokens: number; cachedInputTokens: number}}>>>();
  const workers = new Map<string, ObserverWorker>();
  const released: string[] = [];
  let poisonedKey: string | undefined;
  const result = (key: string) => ({status: 'interpreted' as const, interpretation: {relation: 'continue' as const, status: 'running' as const, summary: key, estimate: {remainingSeconds: 120, errorPercent: 10}}, usage: {kind: 'subscription-tokens' as const, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0}});
  const source = {
    acquire(key: string): ObserverWorker {
      const existing = workers.get(key);
      if (existing) return existing;
      const worker: ObserverWorker = {
        observe: async (_input, _signal, conversationKey) => {
          const gate = deferred<ReturnType<typeof result>>();
          pending.set(conversationKey, gate);
          return gate.promise;
        },
        status: () => ({active: false, disabled: false, poisoned: key === poisonedKey}),
        disable() {},
        close: async () => {released.push(key);},
      };
      workers.set(key, worker);
      return worker;
    },
    async release(key: string) {workers.delete(key); released.push(key);},
    all: () => [...workers.values()],
  };
  return {source, pending, released, result, poison: (key: string) => {poisonedKey = key;}};
}

function startConversation(goals: PassiveGoals, contexts: PassiveContextStore, key: string, now: number): string {
  const envelope = normalizeHookInput('UserPromptSubmit', {session_id: key, turn_id: 'turn', tool_use_id: 'tool'}, now, `protected-${key}-token-123456789012345678901234567890`).envelope;
  envelope.content = {kind: 'user', text: `task ${key}`, truncated: false};
  goals.observe(envelope, true, now);
  contexts.ingest(envelope, now);
  return envelope.sessionKey;
}

afterEach(() => { /* scheduler close owns dynamic workers */ });

it('runs five distinct conversations concurrently and isolates one poisoned worker', async () => {
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts);
  const pool = workerPool();
  const delivered: string[] = [];
  const skips: string[] = [];
  const keys: string[] = [];
  let now = 0;
  const scheduler = new ObserverScheduler({contexts, goals, workerSource: pool.source, now: () => now,
    onObservation: record => {if (record.kind === 'skip') skips.push(`${record.key}:${record.status}`); if (record.kind === 'result' && record.accepted) delivered.push(record.key);},
  });

  for (const key of ['a', 'b', 'c', 'd', 'e']) {
    const conversationKey = startConversation(goals, contexts, key, 0);
    keys.push(conversationKey);
    scheduler.changed(conversationKey, 'prompt');
  }
  now = 20_000;
  scheduler.tick();
  pool.poison(keys[0]!);

  if (scheduler.stats().inFlight !== 5) throw new Error(JSON.stringify({stats: scheduler.stats(), skips, keys, pending: [...pool.pending.keys()]}));
  expect(scheduler.stats().disabled).toBe(false);

  pool.pending.get(keys[0]!)?.resolve(pool.result(keys[0]!));
  for (const key of keys.slice(1)) pool.pending.get(key)?.resolve(pool.result(key));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(delivered).toHaveLength(4);
  expect(new Set(delivered)).toEqual(new Set(keys.slice(1)));
  expect(scheduler.stats().disabled).toBe(false);
  await scheduler.close();
});
