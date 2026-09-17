import {execFile,spawn} from 'node:child_process';
import {mkdtemp,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach,expect,it} from 'vitest';
import {createNativeStorage} from '../../src/estimation/native-storage.js';
import {createNativeGuardTransport} from '../../src/estimation/native-guard-transport.js';
import {captureInvocationProcessIdentity} from '../../src/estimation/invocation-process.js';
import {resolveTrustedPowerShellPath} from '../../src/estimation/recovery-boot-boundary.js';
const execute=promisify(execFile),roots:string[]=[],transports:ReturnType<typeof createNativeGuardTransport>[]=[];
const shell=resolveTrustedPowerShellPath(),helper=resolve('scripts/windows/native-guard.ps1');
const flags=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hud-native-guard-'));roots.push(root);const home=join(root,'observer-auth');
 await execute(shell,[...flags,'-File',resolve('scripts/windows/observer-home.ps1'),'-ParentDirectory',root],{windowsHide:true,timeout:10000});
 await createNativeStorage(home).prepare(new AbortController().signal);
 const args=[...flags,'-File',helper,'-RuntimeHome',home];
 const transport=createNativeGuardTransport({executable:shell,args,cwd:root,env:{...process.env}});transports.push(transport);
 return {root,home,args,transport};
}
afterEach(async()=>{
 for(const t of transports.splice(0))await t.close();
 for(const root of roots.splice(0)){
  if(!root.startsWith(join(tmpdir(),'hud-native-guard-')))throw Error('UNSAFE_TEST_CLEANUP');
  await rm(root,{recursive:true,force:true});
 }
});
it('rechecks actual storage and detects changed ACL without repair',async()=>{
 const {home,transport}=await fixture();const signal=new AbortController().signal;
 await expect(transport.check({op:'verify_storage'},signal)).resolves.toBe('ok');
 await expect(transport.check({op:'verify_storage'},signal)).resolves.toBe('ok');
 await execute(shell,[...flags,'-Command',"$p=$env:HUD_TEST_TARGET;$a=[IO.Directory]::GetAccessControl($p);$a.SetAccessRuleProtection($false,$true);[IO.Directory]::SetAccessControl($p,$a)"],{windowsHide:true,env:{...process.env,HUD_TEST_TARGET:join(home,'hud-native','custody')},timeout:10000});
 await expect(transport.check({op:'verify_storage'},signal)).rejects.toThrow();
 await expect(createNativeStorage(home).verify(signal)).rejects.toThrow();
},20000);
it('does not reuse a prior successful path check',async()=>{
 const {home,transport}=await fixture();const signal=new AbortController().signal;
 await transport.check({op:'verify_storage'},signal);
 await rename(join(home,'hud-native','snapshots'),join(home,'hud-native','moved'));
 await expect(transport.check({op:'verify_storage'},signal)).rejects.toThrow();
},15000);
it('checks live, mismatched and exited identities without terminating the target',async()=>{
 const {transport}=await fixture();const signal=new AbortController().signal;
 const child=spawn(process.execPath,['-e','process.stdin.resume()'],{windowsHide:true,stdio:'pipe'});
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 try{
  const identity=await captureInvocationProcessIdentity(child.pid!);expect(identity).not.toBeNull();
  await expect(transport.check({op:'owner_exited',pid:child.pid!,creationIdentity:identity!},signal)).resolves.toBe('live');
  await expect(transport.check({op:'owner_exited',pid:child.pid!,creationIdentity:'0'},signal)).resolves.toBe('exited');
  expect(child.exitCode).toBeNull();child.stdin.end();await closed;
  await expect(transport.check({op:'owner_exited',pid:child.pid!,creationIdentity:identity!},signal)).resolves.toBe('exited');
 }finally{if(child.exitCode===null)child.kill();await closed;}
},20000);
it.each([
 '{"v":1,"id":1,"id":2,"op":"verify_storage"}\n',
 '{"v":1,"id":1,"op":"verify_storage","path":"elsewhere"}\n',
 '{"v":1,"id":1,"op":"kill"}\n',
 'x'.repeat(257)+'\n',
])('rejects malformed wire input',async input=>{
 const {args}=await fixture();const child=spawn(shell,args,{windowsHide:true,stdio:'pipe'});
 const closed=new Promise<number|null>(resolve=>child.once('close',resolve));const timer=setTimeout(()=>child.kill(),10000);
 child.stdin.end(input);try{expect(await closed).toBe(1);}finally{clearTimeout(timer);}
},20000);
