import {createHash} from 'node:crypto';
import {lstat, open, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {createOwnedProcessRunner} from './owned-process.js';
import {resolveObserverAuthHome} from './codex-invocation.js';

export interface ObserverHomeProfile {parentDirectory:string; powershell:string; scriptPath:string; scriptSha256:string}
/** Trusted desktop inputs only. Pin and executable provenance come from release
 * assets/platform discovery, never a model or HTTP request. No credential reads.
 * Realpath checks do not defeat same-user/admin path replacement races. */
export function createObserverHomeManager(profile: ObserverHomeProfile) {
  const config = Object.freeze({...profile});
  const hostEnvironment = {...process.env};
  const defaultHome = homedir();
  const runner = createOwnedProcessRunner({timeoutMs:10000});
  let active=false, disabled=false;
  const fail=()=>new Error('OBSERVER_HOME_UNAVAILABLE');
  const disable=()=>{disabled=true;runner.disable();};
  const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','TEMP','TMP','PATH'].includes(key.toUpperCase())));
  return {disable,
    status() {
      const child = runner.status();
      return {active:active || child.active, poisoned:child.poisoned};
    },
    async prepare(verifyOnly:boolean, signal:AbortSignal):Promise<string> {
    if(active || disabled || signal.aborted) throw fail();
    active=true;
    try {
      if(process.platform!=='win32' || typeof verifyOnly!=='boolean' || !/^[a-f0-9]{64}$/.test(config.scriptSha256)) throw fail();
      resolveObserverAuthHome(hostEnvironment,join(config.parentDirectory,'observer-auth'));
      resolveObserverAuthHome({HOME:defaultHome},join(config.parentDirectory,'observer-auth'));
      for(const path of [config.parentDirectory,config.powershell,config.scriptPath]) {
        if(typeof path!=='string' || !isAbsolute(path) || !/^[a-z]:[\\/]/i.test(path) || /[\x00-\x1f\x7f]/.test(path) ||
          canonical(await realpath(path))!==canonical(path)) throw fail();
      }
      if(!(await lstat(config.parentDirectory)).isDirectory() || !(await lstat(config.powershell)).isFile() || !(await lstat(config.scriptPath)).isFile()) throw fail();
      const script=await open(config.scriptPath,'r');
      try {
        const before=await script.stat();
        if(!before.isFile() || before.size>65536) throw fail();
        const buffer=Buffer.alloc(65537);
        const {bytesRead}=await script.read(buffer,0,buffer.length,0);
        const after=await script.stat();
        if(bytesRead!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs ||
          createHash('sha256').update(buffer.subarray(0,bytesRead)).digest('hex')!==config.scriptSha256) throw fail();
      } finally {await script.close();}
      if(disabled || signal.aborted) throw fail();
      const result=await runner.run({executable:config.powershell,cwd:config.parentDirectory,env,input:'',
        args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',config.scriptPath,'-ParentDirectory',config.parentDirectory,...(verifyOnly?['-VerifyOnly']:[])]},signal);
      if(disabled || signal.aborted || !result.closed || result.reason!=='exited' || result.exitCode!==0 || result.stderr!=='' || Buffer.byteLength(result.stdout)>4096) throw fail();
      const response:unknown=JSON.parse(result.stdout);
      if(!response || typeof response!=='object' || Array.isArray(response) || Object.keys(response).sort().join(',')!=='ok,path' ||
        (response as {ok:unknown}).ok!==true || (response as {path:unknown}).path!==join(config.parentDirectory,'observer-auth')) throw fail();
      try {
        const auth=await lstat(join(config.parentDirectory,'observer-auth','auth.json'));
        if(!auth.isFile() || auth.isSymbolicLink() || auth.nlink!==1) throw fail();
      } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw fail();}
      if(disabled || signal.aborted) throw fail();
      return join(config.parentDirectory,'observer-auth');
    } catch {disable();throw fail();}
    finally {active=false;}
  }};
}
