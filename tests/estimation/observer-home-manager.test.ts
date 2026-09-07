import {createHash} from 'node:crypto';
import {link, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {createObserverHomeManager} from '../../src/estimation/observer-home.js';

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function profile() {
  const parentDirectory=await mkdtemp(join(tmpdir(),'hud-home-manager-')); roots.push(parentDirectory);
  const scriptPath=resolve('scripts/windows/observer-home.ps1');
  return {parentDirectory,scriptPath,scriptSha256:createHash('sha256').update(await readFile(scriptPath)).digest('hex'),
    powershell:join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')};
}
it.skipIf(process.platform!=='win32')('reports preparation ownership until cancellation drains',async()=>{
  const manager=createObserverHomeManager(await profile());
  expect(manager.status()).toEqual({active:false,poisoned:false});
  const operation=manager.prepare(false,new AbortController().signal);
  expect(manager.status().active).toBe(true);
  manager.disable();
  await expect(operation).rejects.toThrow('OBSERVER_HOME_UNAVAILABLE');
  expect(manager.status()).toEqual({active:false,poisoned:false});
});
it.skipIf(process.platform!=='win32')('runs the pinned helper and returns only the fixed verified home',async()=>{
  const config=await profile(), manager=createObserverHomeManager(config);
  expect(await manager.prepare(false,new AbortController().signal)).toBe(join(config.parentDirectory,'observer-auth'));
  expect(await manager.prepare(true,new AbortController().signal)).toBe(join(config.parentDirectory,'observer-auth'));
  manager.disable();
  await expect(manager.prepare(false,new AbortController().signal)).rejects.toThrow(/^OBSERVER_HOME_UNAVAILABLE$/);
});
it.skipIf(process.platform!=='win32')('rejects a mismatched script before it can create a directory',async()=>{
  const config=await profile();
  const manager=createObserverHomeManager({...config,scriptSha256:'0'.repeat(64)});
  await expect(manager.prepare(false,new AbortController().signal)).rejects.toThrow(/^OBSERVER_HOME_UNAVAILABLE$/);
  expect(await readdir(config.parentDirectory)).toEqual([]);
});
it.skipIf(process.platform!=='win32')('does not provision after cancellation or accept caller mutation of the profile',async()=>{
  const config=await profile(), manager=createObserverHomeManager(config);
  config.scriptSha256='0'.repeat(64);
  const controller=new AbortController();controller.abort();
  await expect(manager.prepare(false,controller.signal)).rejects.toThrow(/^OBSERVER_HOME_UNAVAILABLE$/);
  expect(await readdir(config.parentDirectory)).toEqual([]);
  expect(await manager.prepare(false,new AbortController().signal)).toBe(join(config.parentDirectory,'observer-auth'));
});

it.skipIf(process.platform!=='win32')('refuses provisioning inside the main Codex home before any writes',async()=>{
  const config=await profile();
  vi.stubEnv('CODEX_HOME',config.parentDirectory);
  const manager=createObserverHomeManager(config);
  await expect(manager.prepare(false,new AbortController().signal)).rejects.toThrow(/^OBSERVER_HOME_UNAVAILABLE$/);
  expect(await readdir(config.parentDirectory)).toEqual([]);
});

it.skipIf(process.platform!=='win32')('refuses hard-linked auth without reading or modifying its contents',async()=>{
  const config=await profile(), manager=createObserverHomeManager(config);
  const home=await manager.prepare(false,new AbortController().signal);
  const source=join(home,'synthetic-auth');
  await writeFile(source,'synthetic-not-a-token');
  await link(source,join(home,'auth.json'));
  await expect(manager.prepare(true,new AbortController().signal)).rejects.toThrow(/^OBSERVER_HOME_UNAVAILABLE$/);
  expect(await readFile(source,'utf8')).toBe('synthetic-not-a-token');
});
