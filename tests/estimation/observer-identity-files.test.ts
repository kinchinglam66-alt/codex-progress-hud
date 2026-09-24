import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,link,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureObserverIdentityFiles} from '../../src/estimation/observer-identity-files.js';

let root='';
let authHome='';

beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'codex-observer-identity-'));
  authHome=join(root,'observer-auth');
  await mkdir(authHome);
  await writeFile(join(authHome,'auth.json'),'credential-content-must-not-be-read');
});

afterEach(async()=>{if(root) await rm(root,{recursive:true,force:true});});

it('captures opaque stable metadata without reading credential contents and permits absent config',async()=>{
  const captured=await captureObserverIdentityFiles(authHome);
  expect(captured).toEqual(expect.any(String));
  expect(captured).not.toContain('credential-content-must-not-be-read');
  expect(await captureObserverIdentityFiles(join(authHome,'missing'))).toBeNull();
});

it('rejects replacement, writes, hardlinks, and missing authentication files',async()=>{
  const original=await captureObserverIdentityFiles(authHome);
  expect(original).not.toBeNull();

  await writeFile(join(authHome,'auth.json'),'changed-content-with-a-different-size');
  expect(await captureObserverIdentityFiles(authHome)).not.toBe(original);

  const replacement=join(authHome,'replacement.json');
  await writeFile(replacement,'replacement-content');
  await rm(join(authHome,'auth.json'));
  await rename(replacement,join(authHome,'auth.json'));
  expect(await captureObserverIdentityFiles(authHome)).not.toBe(original);

  const hardlinkSource=join(root,'hardlink-source.json');
  await writeFile(hardlinkSource,'hardlink-content');
  await rm(join(authHome,'auth.json'));
  await link(hardlinkSource,join(authHome,'auth.json'));
  expect(await captureObserverIdentityFiles(authHome)).toBeNull();

  await rm(join(authHome,'auth.json'));
  expect(await captureObserverIdentityFiles(authHome)).toBeNull();
});

it('tracks config metadata while failing closed for a symlinked config',async()=>{
  const withoutConfig=await captureObserverIdentityFiles(authHome);
  await writeFile(join(authHome,'config.toml'),'trusted-config-metadata-only');
  const withConfig=await captureObserverIdentityFiles(authHome);
  expect(withConfig).not.toBe(withoutConfig);

  await rm(join(authHome,'config.toml'));
  const configTarget=join(root,'config-target.toml');
  await writeFile(configTarget,'config');
  await link(configTarget,join(authHome,'config.toml'));
  expect(await captureObserverIdentityFiles(authHome)).toBeNull();
});

it('does not treat unrelated child creation as an identity-file replacement',async()=>{
  const before=await captureObserverIdentityFiles(authHome);
  await writeFile(join(authHome,'app-server-runtime.log'),'transient app-server state');
  expect(await captureObserverIdentityFiles(authHome)).toBe(before);
});

it('requires explicit external mode for credential-free homes and rejects credentials appearing',async()=>{
  expect(await captureObserverIdentityFiles(authHome,'external')).toBeNull();
  await rm(join(authHome,'auth.json'));
  expect(await captureObserverIdentityFiles(authHome)).toBeNull();
  const captured=await captureObserverIdentityFiles(authHome,'external');
  expect(captured).toEqual(expect.any(String));
  expect(await captureObserverIdentityFiles(authHome,'external')).toBe(captured);
  await writeFile(join(authHome,'auth.json'),'unexpected-identity');
  expect(await captureObserverIdentityFiles(authHome,'external')).toBeNull();
});

it('tracks external home replacement and config changes without reading secrets',async()=>{
  await rm(join(authHome,'auth.json'));
  const original=await captureObserverIdentityFiles(authHome,'external');
  await writeFile(join(authHome,'config.toml'),'private-config-value');
  const configured=await captureObserverIdentityFiles(authHome,'external');
  expect(configured).not.toBeNull();
  expect(configured).not.toBe(original);
  expect(configured).not.toContain('private-config-value');
  await rename(authHome,join(root,'previous-home'));
  await mkdir(authHome);
  expect(await captureObserverIdentityFiles(authHome,'external')).not.toBe(original);
  expect(await captureObserverIdentityFiles(join(root,'missing'),'external')).toBeNull();
});
