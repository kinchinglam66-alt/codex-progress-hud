import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, it} from 'vitest';

const roots: string[] = [];
const execute = promisify(execFile);
const helper = resolve('scripts/windows/observer-home.ps1');
const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
async function fixture() {const dir = await mkdtemp(join(tmpdir(), 'hud-home-test-')); roots.push(dir); return dir;}
async function run(parent: string, verifyOnly = false) {
  try {
    const {stdout} = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ParentDirectory', parent, ...(verifyOnly ? ['-VerifyOnly'] : [])], {windowsHide:true, timeout:10000, maxBuffer:4096});
    return {code:0, value:JSON.parse(stdout.trim())};
  } catch (error) {
    const result = error as {code:number; stdout:string};
    return {code:result.code, value:JSON.parse(result.stdout.trim())};
  }
}
afterEach(async () => {for (const root of roots.splice(0)) await rm(root, {recursive:true, force:true});});

it.skipIf(process.platform !== 'win32')('creates a private home and verifies it without modifying sibling main state', async () => {
  const root = await fixture();
  await mkdir(join(root, 'main-codex'));
  expect(await run(root)).toEqual({code:0, value:{ok:true, path:join(root, 'observer-auth')}});
  expect(await run(root, true)).toEqual({code:0, value:{ok:true, path:join(root, 'observer-auth')}});
  expect(await readdir(join(root, 'main-codex'))).toEqual([]);
  expect(await readdir(join(root, 'observer-auth'))).toEqual([]);
});

it.skipIf(process.platform !== 'win32')('does not repair a pre-existing inherited ACL or create during verification', async () => {
  const root = await fixture();
  expect((await run(root, true)).code).toBe(1);
  expect(await readdir(root)).toEqual([]);
  await mkdir(join(root, 'observer-auth'));
  expect(await run(root)).toEqual({code:1, value:{ok:false, code:'OBSERVER_HOME_UNAVAILABLE'}});
});

it.skipIf(process.platform !== 'win32')('rejects junction parent without writing to its destination', async () => {
  const root = await fixture(), destination = await fixture();
  const alias = join(root, 'alias');
  await symlink(destination, alias, 'junction');
  expect((await run(alias)).code).toBe(1);
  expect(await readdir(destination)).toEqual([]);
});

it.skipIf(process.platform !== 'win32')('rejects a protected directory after a foreign read grant without repairing it', async () => {
  const root = await fixture();
  expect((await run(root)).code).toBe(0);
  const command = "$p=$env:HUD_TEST_TARGET; $acl=[System.IO.Directory]::GetAccessControl($p); $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)";
  await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {windowsHide:true, timeout:10000, env:{...process.env, HUD_TEST_TARGET:join(root,'observer-auth')}});
  expect(await run(root, true)).toEqual({code:1, value:{ok:false, code:'OBSERVER_HOME_UNAVAILABLE'}});
  expect(await run(root)).toEqual({code:1, value:{ok:false, code:'OBSERVER_HOME_UNAVAILABLE'}});
});

it.skipIf(process.platform !== 'win32')('refuses local configuration instead of loading or overwriting a route override', async () => {
  const root = await fixture();
  expect((await run(root)).code).toBe(0);
  const config = join(root, 'observer-auth', 'config.toml');
  await writeFile(config, 'model_provider = "unapproved"\n');
  expect(await run(root, true)).toEqual({code:1, value:{ok:false, code:'OBSERVER_HOME_UNAVAILABLE'}});
  expect(await readFile(config, 'utf8')).toBe('model_provider = "unapproved"\n');
});

it.skipIf(process.platform !== 'win32')('rejects a credential-file read grant even when directory ACL is private', async () => {
  const root = await fixture();
  expect((await run(root)).code).toBe(0);
  const auth = join(root, 'observer-auth', 'auth.json');
  await writeFile(auth, 'fixture-not-a-token');
  expect((await run(root, true)).code).toBe(0);
  const command = "$p=$env:HUD_TEST_TARGET; $acl=[System.IO.File]::GetAccessControl($p); $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($p,$acl)";
  await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {windowsHide:true, timeout:10000, env:{...process.env, HUD_TEST_TARGET:auth}});
  expect(await run(root, true)).toEqual({code:1, value:{ok:false, code:'OBSERVER_HOME_UNAVAILABLE'}});
  expect(await readFile(auth, 'utf8')).toBe('fixture-not-a-token');
});
