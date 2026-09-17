import {spawn,execFile} from 'node:child_process';
import {mkdtemp,copyFile,writeFile,rm,link} from 'node:fs/promises';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {afterEach,expect,it} from 'vitest';
import {prepareNativeGuardInvocation} from '../../src/estimation/native-guard-launch.js';
import {createNativeStorage} from '../../src/estimation/native-storage.js';
import {resolveTrustedPowerShellPath} from '../../src/estimation/recovery-boot-boundary.js';
const roots:string[]=[],execute=promisify(execFile);
afterEach(async()=>{for(const root of roots.splice(0)){if(!root.startsWith(join(tmpdir(),'hud-guard-launch-')))throw Error('UNSAFE_CLEANUP');await rm(root,{recursive:true,force:true});}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hud-guard-launch-'));roots.push(root);const script=join(root,'guard.ps1'),home=join(root,'observer-auth');
 await copyFile(resolve('scripts/windows/native-guard.ps1'),script);
 await execute(resolveTrustedPowerShellPath(),['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/windows/observer-home.ps1'),'-ParentDirectory',root],{windowsHide:true,timeout:10000});
 await createNativeStorage(home).prepare(new AbortController().signal);return {root,home,script};
}
it('executes the verified bytes even if the pathname is modified before spawn',async()=>{
 const {home,script}=await fixture();const invocation=await prepareNativeGuardInvocation(home,script);
 await writeFile(script,"[Console]::Out.Write('UNVERIFIED_CODE');exit 0");
 const child=spawn(invocation.executable,[...invocation.args],{cwd:invocation.cwd,env:invocation.env,windowsHide:true,stdio:'pipe'});
 const closed=once(child,'close');let output='';child.stdout.on('data',chunk=>{output+=chunk;});
 const timer=setTimeout(()=>child.kill(),10000);child.stdin.end('{"v":1,"id":1,"op":"verify_storage"}\n');
 try{expect((await closed)[0]).toBe(0);expect(output).toBe('{"v":1,"id":1,"op":"verify_storage","result":"ok"}\n');}finally{clearTimeout(timer);}
},20000);
it('rejects multiply linked launch source rather than trusting staging',async()=>{
 const {root,home,script}=await fixture();await link(script,join(root,'alias.ps1'));
 await expect(prepareNativeGuardInvocation(home,script)).rejects.toThrow();
},15000);
