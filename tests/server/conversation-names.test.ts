import { expect, it } from 'vitest';
import { createConversationNames } from '../../src/server/conversation-names.js';

it('coalesces a conversation refresh and does not apply a result after disable', async () => {
  let finish!: (name: string) => void;
  let calls = 0;
  const cache = createConversationNames(async (_id, signal) => {
    calls++;
    return new Promise<string>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve('ignored')); });
  });
  cache.register('one', 'host-one');
  const first = cache.refresh('one');
  const second = cache.refresh('one');
  await Promise.resolve();
  expect(calls).toBe(1);
  cache.disable(); finish('late title');
  await Promise.all([first, second]);
  expect(cache.get('one')).toEqual({ value: null, freshness: 'unavailable' });
});

it('keeps last known host name stale on failure and refreshes after the interval', async () => {
  let now = 0, calls = 0;
  const cache = createConversationNames(async () => {
    calls++;
    if(calls === 2) throw Error('private provider detail');
    return calls === 1 ? 'Host title' : 'Renamed title';
  }, { now: () => now });
  cache.register('one', 'host-one');
  await cache.refresh('one');
  expect(cache.get('one')).toEqual({ value: 'Host title', freshness: 'fresh' });
  await cache.refresh('one'); expect(calls).toBe(1);
  now = 10000; await cache.refresh('one');
  expect(cache.get('one')).toEqual({ value: 'Host title', freshness: 'stale' });
  now = 20000; await cache.refresh('one');
  expect(cache.get('one')).toEqual({ value: 'Renamed title', freshness: 'fresh' });
  cache.disable();
});

it('serializes different conversations and fences forget/re-register results', async () => {
  let finish!: (name: string) => void;
  const calls: string[] = [];
  const cache = createConversationNames(async id => {
    calls.push(id);
    if(calls.length === 1) return new Promise<string>(resolve => {finish=resolve;});
    return 'New name';
  });
  cache.register('a','host-a'); cache.register('b','host-b');
  const first=cache.refresh('a'), second=cache.refresh('b');
  await Promise.resolve(); expect(calls).toEqual(['host-a']);
  cache.forget('a'); cache.register('a','host-a');
  finish('Obsolete name'); await Promise.all([first,second]);
  expect(cache.get('a').value).toBeNull();
  expect(cache.get('b').value).toBe('New name');
  cache.disable();
});

it('bounds identities, rejects remapping and does not retain empty or oversized names', async () => {
  const cache = createConversationNames(async id => id === 'empty' ? '' : 'x'.repeat(1025), { maxEntries: 2 });
  expect(cache.register('a','empty')).toBe(true);
  expect(cache.register('a','different')).toBe(false);
  expect(cache.register('b','large')).toBe(true);
  expect(cache.register('c','extra')).toBe(false);
  await cache.refresh('a'); await cache.refresh('b');
  expect(cache.get('a').value).toBeNull(); expect(cache.get('b').value).toBeNull();
  cache.disable();
});
