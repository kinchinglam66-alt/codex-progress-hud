import {expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {captureInvocationProcessIdentity, inspectInvocationProcess} from '../../src/estimation/invocation-process.js';

it.runIf(process.platform === 'win32')('does not kill a reused PID identity and closes only the matching owned process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {windowsHide: true, stdio: 'ignore'});
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const creationIdentity = await captureInvocationProcessIdentity(child.pid!);
    expect(creationIdentity).toMatch(/^\d+$/);
    const record = {admissionId: randomUUID(), conversationKey: 'process-fixture', turnGeneration: 1,
      ownerUuid: randomUUID(), providerKind: 'subscription' as const, phase: 'bound' as const,
      deadline: 0, pid: child.pid!, creationIdentity: creationIdentity!};
    expect(await inspectInvocationProcess({...record, creationIdentity: '1'}, true)).toBe('closed');
    expect(child.exitCode).toBeNull();
    expect(await inspectInvocationProcess(record, false)).toBe('live');
    expect(await inspectInvocationProcess(record, true)).toBe('closed');
    await exited;
  } finally {if (child.exitCode === null) child.kill(); await exited;}
}, 20_000);

it('does not inspect or terminate an invocation with no usable process identity', async () => {
  const record = {admissionId: randomUUID(), conversationKey: 'fixture', turnGeneration: 0,
    ownerUuid: randomUUID(), providerKind: 'subscription' as const, phase: 'prepared' as const, deadline: 0};
  expect(await inspectInvocationProcess(record, true)).toBe('unconfirmed');
  expect(await captureInvocationProcessIdentity(-1)).toBeNull();
});
