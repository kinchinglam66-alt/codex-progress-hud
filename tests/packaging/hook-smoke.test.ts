import {expect, it} from 'vitest';
import {Readable} from 'node:stream';
import {runHookEvent} from '../../src/hooks/main.js';
import {TaskStore} from '../../src/server/task-store.js';

const helperPath = '../../scripts/hook-smoke-assertions.mjs';
it('fails the packaged probe when a real fail-open Stop acknowledges a dropped delivery', async () => {
  const {assertHookProcess} = await import(helperPath);
  let stdout = '', stderr = '';
  await runHookEvent('Stop', {
    stdin: Readable.from([JSON.stringify({session_id: 'smoke', turn_id: 'a'})]),
    hmacKey: 'synthetic-smoke-hmac-key-abcdefghijklmnopqrstuvwxyz',
    postHook: async () => {throw new Error('synthetic dropped delivery');},
    writeStdout: value => {stdout += value;}, writeStderr: value => {stderr += value;}
  });
  expect(JSON.parse(stdout)).toEqual({continue: true});
  expect(() => assertHookProcess({status: 0, stdout, stderr}, 'Stop')).toThrow('delivery');
});

it('requires the target turn to become quiescent even when process diagnostics are empty', async () => {
  const {assertStoppedTurn} = await import(helperPath);
  const store = new TaskStore({now: () => 100});
  store.apply({taskId: 'a', event: {type: 'tracking_started'}});
  expect(() => assertStoppedTurn(store.snapshot(), 'a')).toThrow('Stop');
  store.apply({taskId: 'a', event: {type: 'turn_stopped'}});
  expect(() => assertStoppedTurn(store.snapshot(), 'a')).not.toThrow();
});

it('accepts acknowledgement-only successful Hook delivery', async () => {
  const {assertHookProcess} = await import(helperPath);
  expect(() => assertHookProcess({status: 0, stdout: '{"continue":true}', stderr: ''}, 'Stop')).not.toThrow();
});
