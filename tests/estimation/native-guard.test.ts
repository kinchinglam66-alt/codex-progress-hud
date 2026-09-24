import {execFile} from 'node:child_process';
import {mkdtemp,rm,copyFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach,expect,it as test} from 'vitest';
// These cases execute Windows PowerShell and validate Windows ACLs.
const it=test.skipIf(process.platform!=='win32');
import {createNativeGuard} from '../../src/estimation/native-guard.js';
import {createNativeStorage} from '../../src/estimation/native-storage.js';
import {resolveTrustedPowerShellPath} from '../../src/estimation/recovery-boot-boundary.js';
const execute=promisify(execFile),roots:string[]=[],guards:ReturnType<typeof createNativeGuard>[]=[];
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hud-native-guard-wrapper-'));roots.push(root);
 const home=join(root,'observer-auth'),script=join(root,'native-guard.ps1');
 await copyFile(resolve('scripts/windows/native-guard.ps1'),script);
 await execute(resolveTrustedPowerShellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/windows/observer-home.ps1'),'-ParentDirectory',root],{windowsHide:true,timeout:10000});
 await createNativeStorage(home).prepare(new AbortController().signal);
 const guard=createNativeGuard(home,script);guards.push(guard);return {home,script,guard};
}
afterEach(async()=>{
 for(const guard of guards.splice(0))await guard.retire();
 for(const root of roots.splice(0)){
  if(!root.startsWith(join(tmpdir(),'hud-native-guard-wrapper-')))throw Error('UNSAFE_TEST_CLEANUP');
  await rm(root,{recursive:true,force:true});
 }
});
it('rechecks script hash even while its process is resident',async()=>{
 const {guard,script}=await fixture();const signal=new AbortController().signal;
 await guard.verify(signal);expect(guard.status().resident).toBe(true);
 await appendFile(script,'\n# changed after successful check');
 await expect(guard.verify(signal)).rejects.toThrow();expect(guard.status().resident).toBe(false);
},20000);
it('normal retirement allows a new checked generation',async()=>{
 const {guard}=await fixture();const signal=new AbortController().signal;
 await guard.verify(signal);await guard.retire();expect(guard.status().resident).toBe(false);
 await guard.verify(signal);expect(guard.status().resident).toBe(true);
},20000);
it('pre-cancelled work never creates a helper',async()=>{
 const {guard}=await fixture();const controller=new AbortController();controller.abort();
 await expect(guard.verify(controller.signal)).rejects.toThrow();expect(guard.status().resident).toBe(false);
},20000);
it('retirement during asset validation cancels the request before helper startup',async()=>{
 const {guard}=await fixture();const pending=expect(guard.verify(new AbortController().signal)).rejects.toThrow();
 const retired=guard.retire();await expect(guard.verify(new AbortController().signal)).rejects.toThrow();
 await retired;await pending;expect(guard.status().resident).toBe(false);
 await guard.verify(new AbortController().signal);
},20000);
it('simultaneous check is rejected without cancelling the first',async()=>{
 const {guard}=await fixture();const pending=guard.verify(new AbortController().signal);
 await expect(guard.verify(new AbortController().signal)).rejects.toThrow();await pending;
 expect(guard.status().resident).toBe(true);
},20000);
it('independent homes never share a guard generation',async()=>{
 const a=await fixture(),b=await fixture();const signal=new AbortController().signal;
 await a.guard.verify(signal);await b.guard.verify(signal);await appendFile(a.script,'\n# changed');
 await expect(a.guard.verify(signal)).rejects.toThrow();await b.guard.verify(signal);
 expect(b.guard.status().resident).toBe(true);
},25000);
