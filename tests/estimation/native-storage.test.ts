import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveTrustedPowerShellPath} from '../../src/estimation/recovery-boot-boundary.js';
import {createNativeStorage} from '../../src/estimation/native-storage.js';
const execute=promisify(execFile),roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){
 if(!root.startsWith(join(tmpdir(),'hud-native-storage-')))throw Error('UNSAFE_TEST_CLEANUP');
 await rm(root,{recursive:true,force:true});
}});
async function fixture(protectedParent=true){
 const parent=await mkdtemp(join(tmpdir(),'hud-native-storage-'));roots.push(parent);
 const runtimeHome=join(parent,'observer-auth');
 if(protectedParent)await execute(resolveTrustedPowerShellPath(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-File',resolve('scripts/windows/observer-home.ps1'),'-ParentDirectory',parent],{windowsHide:true,timeout:10000});
 else await mkdir(runtimeHome);
 return {runtimeHome,storage:createNativeStorage(runtimeHome)};
}
it('creates and re-verifies dedicated directories under a protected independent home',async()=>{
 const f=await fixture();const paths=await f.storage.prepare(new AbortController().signal);
 expect(paths).toEqual({snapshots:join(f.runtimeHome,'hud-native','snapshots'),custody:join(f.runtimeHome,'hud-native','custody')});
 expect((await stat(paths.snapshots)).isDirectory()).toBe(true);
 await f.storage.verify(new AbortController().signal);
 expect(await f.storage.prepare(new AbortController().signal)).toEqual(paths);
},15000); // Several trusted PowerShell/ACL checks; keep their production timeouts unchanged.
it('refuses an inherited-open parent without creating storage or changing its ACL',async()=>{
 const f=await fixture(false);
 await expect(f.storage.prepare(new AbortController().signal)).rejects.toThrow('NATIVE_STORAGE_UNAVAILABLE');
 await expect(stat(join(f.runtimeHome,'hud-native'))).rejects.toMatchObject({code:'ENOENT'});
});
it('refuses missing storage in verify-only mode',async()=>{
 const f=await fixture();await expect(f.storage.verify(new AbortController().signal)).rejects.toThrow('NATIVE_STORAGE_UNAVAILABLE');
 await expect(stat(join(f.runtimeHome,'hud-native'))).rejects.toMatchObject({code:'ENOENT'});
});
it('rejects a main Codex subtree or network home before any filesystem action',()=>{
 expect(()=>createNativeStorage(join(homedir(),'.codex','observer-auth'))).toThrow('NATIVE_STORAGE_UNAVAILABLE');
 expect(()=>createNativeStorage('\\\\server\\share\\observer-auth')).toThrow('NATIVE_STORAGE_UNAVAILABLE');
});
