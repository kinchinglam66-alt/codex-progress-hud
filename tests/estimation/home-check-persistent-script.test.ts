import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach,expect,it} from 'vitest';
import {createHomeCheckTransport} from '../../src/estimation/home-check-transport.js';
const execute=promisify(execFile);
const shell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const helper=resolve('scripts/windows/observer-home.ps1');
const roots:string[]=[];
const transports:ReturnType<typeof createHomeCheckTransport>[]=[];
const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper];
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'hud-persistent-home-')); roots.push(root);
  const target=join(root,'observer-auth');
  const transport=createHomeCheckTransport({executable:shell,cwd:root,env:{...process.env},args:[...args,'-ParentDirectory',root,'-Persistent']},target);
  transports.push(transport);return {root,target,transport};
}
afterEach(async()=>{
  for(const transport of transports.splice(0))await transport.close();
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});
it.skipIf(process.platform!=='win32')('checks fresh state after success without rereading or altering synthetic credentials',async()=>{
  const {target,transport}=await fixture();const signal=new AbortController().signal;
  await expect(transport.check(false,signal)).resolves.toBe(target);
  await expect(transport.check(true,signal)).resolves.toBe(target);
  await writeFile(join(target,'config.toml'),'synthetic disallowed config');
  await expect(transport.check(true,signal)).rejects.toThrow('HOME_CHECK_FAILED');
},20000);
it.skipIf(process.platform!=='win32')('verify-only cannot create a missing home',async()=>{
  const {transport}=await fixture(); await expect(transport.check(true,new AbortController().signal)).rejects.toThrow('HOME_CHECK_FAILED');
});
it.skipIf(process.platform!=='win32')('detects changed ACL on the next request without repairing it',async()=>{
  const {target,transport}=await fixture();const signal=new AbortController().signal;
  await transport.check(false,signal);
  await execute(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$p=$env:HUD_TEST_TARGET; $a=[IO.Directory]::GetAccessControl($p); $a.SetAccessRuleProtection($false,$true); [IO.Directory]::SetAccessControl($p,$a)"],{windowsHide:true,env:{...process.env,HUD_TEST_TARGET:target},timeout:10000});
  await expect(transport.check(true,signal)).rejects.toThrow('HOME_CHECK_FAILED');
},20000);
it.skipIf(process.platform!=='win32')('detects credentials replaced by a directory',async()=>{
  const {target,transport}=await fixture();const signal=new AbortController().signal;
  await transport.check(false,signal);await mkdir(join(target,'auth.json'));
  await expect(transport.check(true,signal)).rejects.toThrow('HOME_CHECK_FAILED');
});
it.skipIf(process.platform!=='win32')('rechecks path existence after an earlier successful response',async()=>{
  const {root,target,transport}=await fixture();const signal=new AbortController().signal;
  await transport.check(false,signal);await rename(target,join(root,'moved-owned-fixture'));
  await expect(transport.check(true,signal)).rejects.toThrow('HOME_CHECK_FAILED');
});
it.skipIf(process.platform!=='win32')('rejects a newly permissive credential ACL despite a protected directory',async()=>{
  const {target,transport}=await fixture();const signal=new AbortController().signal;
  await transport.check(false,signal);const auth=join(target,'auth.json');await writeFile(auth,'synthetic-not-a-token');
  await transport.check(true,signal);
  await execute(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$p=$env:HUD_TEST_TARGET; $a=[IO.File]::GetAccessControl($p); $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'Read','Allow'); $a.AddAccessRule($r); [IO.File]::SetAccessControl($p,$a)"],{windowsHide:true,env:{...process.env,HUD_TEST_TARGET:auth},timeout:10000});
  await expect(transport.check(true,signal)).rejects.toThrow('HOME_CHECK_FAILED');
},20000);
it.skipIf(process.platform!=='win32').each([
  ['extra fields','{"v":1,"id":1,"op":"prepare","path":"ignored"}\n'],
  ['malformed','{oops}\n'],
  ['duplicate id','{"v":1,"id":1,"op":"prepare"}\n{"v":1,"id":1,"op":"verify"}\n'],
  ['decreasing id','{"v":1,"id":2,"op":"prepare"}\n{"v":1,"id":1,"op":"verify"}\n'],
])('persistent protocol refuses %s',async(_label,input)=>{
  const {root}=await fixture();
  const child=spawn(shell,[...args,'-ParentDirectory',root,'-Persistent'],{windowsHide:true,stdio:'pipe'});
  const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
  const timer=setTimeout(()=>child.kill(),10000);child.stdin.end(input);
  try{expect(await closed).toBe(1);}finally{clearTimeout(timer);}
},20000);
it.skipIf(process.platform!=='win32')('rejects oversized protocol input and exits on parent EOF',async()=>{
  const {root}=await fixture();
  for(const input of ['x'.repeat(257)+'\n','']){
    const child=spawn(shell,[...args,'-ParentDirectory',root,'-Persistent'],{windowsHide:true,stdio:'pipe'});
    const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
    const timer=setTimeout(()=>child.kill(),10000);
    child.stdin.end(input);const code=await closed;clearTimeout(timer);
    expect(code).toBe(input?1:0);
  }
},20000);
