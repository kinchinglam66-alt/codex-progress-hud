import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCodexNameReader } from '../../src/server/codex-name-reader.js';
const fixture=fileURLToPath(new URL('../fixtures/name-server.mjs',import.meta.url));
const launch=(mode:string) => () => spawn(process.execPath,[fixture,mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});

it('retains failed-termination ownership until close and retries on disable', async () => {
  const child=launch('timeout')();
  const kill=child.kill.bind(child);
  const failedKill=vi.spyOn(child,'kill').mockReturnValue(false);
  const reader=createCodexNameReader(()=>child,{timeoutMs:10});
  try {
    await expect(reader.read('host',new AbortController().signal)).rejects.toThrow('NAME_READ_FAILED');
    expect(reader.ownership()).toBe('termination_failed');
    const attempts=failedKill.mock.calls.length;
    reader.disable();
    expect(failedKill.mock.calls.length).toBeGreaterThan(attempts);
    expect(reader.ownership()).toBe('termination_failed');
  } finally {
    failedKill.mockRestore();
    kill();
    await vi.waitFor(()=>expect(reader.ownership()).toBe('idle'));
  }
});

it('reads only the matching thread name and waits for child close', async () => {
  const reader=createCodexNameReader(launch('ok'));
  try {
    expect(await reader.read('host-one',new AbortController().signal)).toBe('Host title');
    expect(await reader.read('host-two',new AbortController().signal)).toBe('Host title');
  } finally {reader.disable();}
});
it.each(['mismatch','invalid','flood'])('rejects %s output with no raw details', async mode => {
  const reader=createCodexNameReader(launch(mode));
  try {await expect(reader.read('private-host',new AbortController().signal)).rejects.toThrow('NAME_READ_FAILED');}
  finally {reader.disable();}
});
it('aborts the owned child and refuses overlapping reads', async () => {
  const reader=createCodexNameReader(launch('timeout'));
  const controller=new AbortController();
  const pending=reader.read('host-one',controller.signal);
  await expect(reader.read('host-two',controller.signal)).rejects.toThrow('NAME_READER_BUSY');
  controller.abort();
  await expect(pending).rejects.toThrow('NAME_READ_FAILED');
  reader.disable();
  await expect(reader.read('host-three',new AbortController().signal)).rejects.toThrow('NAME_READER_DISABLED');
});
it('bounds a silent metadata request without a model call', async () => {
  const reader=createCodexNameReader(launch('timeout'),{timeoutMs:100});
  try {await expect(reader.read('host-one',new AbortController().signal)).rejects.toThrow('NAME_READ_FAILED');}
  finally {reader.disable();}
});
