import {expect,it} from 'vitest';
import {createObserverLoginOwner} from '../../src/estimation/observer-login-owner.js';
import type {Invocation} from '../../src/estimation/owned-process.js';
import {access,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const invocation=(code:string):Invocation=>({executable:process.execPath,cwd:process.cwd(),args:['-e',code],env:process.env,input:''});
it('returns only process outcome, never login output or account authorization',async()=>{
  const owner=createObserverLoginOwner(()=>invocation('process.stdout.write("PRIVATE_AUTH_URL");process.stderr.write("PRIVATE_LOGIN_INFO")'));
  expect(await owner.login(new AbortController().signal)).toBe('process_exited');
  await owner.close();
  expect(await owner.login(new AbortController().signal)).toBe('cancelled');
});
it('cancels pending preparation, excludes overlap and drains on close without spawning',async()=>{
  let release!:(value:Invocation)=>void,entered!:()=>void;
  const prepared=new Promise<Invocation>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  let inner:AbortSignal|undefined;
  const owner=createObserverLoginOwner(async signal=>{inner=signal;entered();return prepared;});
  const first=owner.login(new AbortController().signal);
  await started;
  expect(await owner.login(new AbortController().signal)).toBe('busy');
  const closing=owner.close();
  expect(inner?.aborted).toBe(true);
  release(invocation('process.exit(0)'));
  expect(await first).toBe('cancelled');
  await closing;
});
it('reports failure without echoing thrown details or nonzero child output',async()=>{
  const throwing=createObserverLoginOwner(()=>{throw Error('PRIVATE');});
  expect(await throwing.login(new AbortController().signal)).toBe('failed');
  await throwing.close();
  const failing=createObserverLoginOwner(()=>invocation('process.stderr.write("PRIVATE");process.exit(1)'));
  expect(await failing.login(new AbortController().signal)).toBe('failed');
  await failing.close();
});
it('does not prepare a pre-cancelled request',async()=>{
  let calls=0;
  const owner=createObserverLoginOwner(()=>{calls++;return invocation('process.exit(0)');});
  const controller=new AbortController();controller.abort();
  expect(await owner.login(controller.signal)).toBe('cancelled');
  expect(calls).toBe(0);
  await owner.close();
});

it('presents only a bounded device authorization event through the dedicated callback', async () => {
  const events: unknown[] = [];
  const owner = createObserverLoginOwner(
    (_signal, action) => invocation(action === 'device-auth'
      ? 'process.stdout.write("Open https://auth.openai.com/codex/device and enter code ABCD-EFGH")'
      : 'process.exit(0)'),
    {onDeviceAuth: event => events.push(event)},
  );
  expect(await owner.deviceAuth(new AbortController().signal)).toBe('process_exited');
  expect(events).toEqual([{kind: 'device-auth', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH'}]);
  await owner.close();
});

it('parses ANSI-wrapped device prompts from stderr and rejects non-device URLs', async () => {
  const events: unknown[] = [];
  const owner = createObserverLoginOwner(
    (_signal, action) => invocation(action === 'device-auth'
      ? 'process.stderr.write("\\u001b[1mOpen https://auth.openai.com/codex/device and enter code WXYZ-1234\\u001b[0m")'
      : 'process.exit(0)'),
    {onDeviceAuth: event => events.push(event)},
  );
  expect(await owner.deviceAuth(new AbortController().signal)).toBe('process_exited');
  expect(events).toEqual([{kind: 'device-auth', url: 'https://auth.openai.com/codex/device', code: 'WXYZ-1234'}]);
  await owner.close();

  const rejectedEvents: unknown[] = [];
  const rejected = createObserverLoginOwner(
    () => invocation('process.stderr.write("Open https://auth.openai.com/other and enter code WXYZ-1234")'),
    {onDeviceAuth: event => rejectedEvents.push(event)},
  );
  expect(await rejected.deviceAuth(new AbortController().signal)).toBe('process_exited');
  expect(rejectedEvents).toEqual([]);
  await rejected.close();
});

it('cancels an actual waiting child and confirms cleanup before close resolves',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hud-login-child-'));
  const marker=join(root,'ready');
  const owner=createObserverLoginOwner(()=>invocation(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`));
  const controller=new AbortController();
  const pending=owner.login(controller.signal);
  try {
    let ready=false;
    for(let i=0;i<500;i++) {
      try {await access(marker);ready=true;break;} catch {await new Promise(resolve=>setTimeout(resolve,5));}
    }
    expect(ready).toBe(true);
    controller.abort();
    expect(await pending).toBe('cancelled');
    await owner.close();
  } finally {owner.disable();await owner.close();await rm(root,{recursive:true,force:true});}
});
