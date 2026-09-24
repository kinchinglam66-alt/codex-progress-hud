import {join} from 'node:path';
import {createOwnedProcessRunner} from './owned-process.js';
import {createObserverHomeValidation} from './observer-home-validation.js';
import {nativePowerShellEnvironment} from './native-powershell-environment.js';

export interface ObserverHomeProfile {parentDirectory:string; powershell:string; scriptPath:string; scriptSha256:string}
/** Trusted desktop inputs only. Pin and executable provenance come from release
 * assets/platform discovery, never a model or HTTP request. No credential reads.
 * Realpath checks do not defeat same-user/admin path replacement races. */
export function createObserverHomeManager(profile: ObserverHomeProfile) {
  const config = Object.freeze({...profile});
  const validation = createObserverHomeValidation(config);
  const runner = createOwnedProcessRunner({timeoutMs:10000});
  let active=false, disabled=false;
  const fail=()=>new Error('OBSERVER_HOME_UNAVAILABLE');
  const disable=()=>{disabled=true;runner.disable();};
  const env=nativePowerShellEnvironment();
  return {disable,
    status() {
      const child = runner.status();
      return {active:active || child.active, poisoned:child.poisoned};
    },
    async prepare(verifyOnly:boolean, signal:AbortSignal):Promise<string> {
    if(active || disabled || signal.aborted) throw fail();
    active=true;
    try {
      if(typeof verifyOnly!=='boolean')throw fail();
      await validation.assets();
      if(disabled || signal.aborted) throw fail();
      const result=await runner.run({executable:config.powershell,cwd:config.parentDirectory,env,input:'',
        args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',config.scriptPath,'-ParentDirectory',config.parentDirectory,...(verifyOnly?['-VerifyOnly']:[])]},signal);
      if(disabled || signal.aborted || !result.closed || result.reason!=='exited' || result.exitCode!==0 || result.stderr!=='' || Buffer.byteLength(result.stdout)>4096) throw fail();
      const response:unknown=JSON.parse(result.stdout);
      if(!response || typeof response!=='object' || Array.isArray(response) || Object.keys(response).sort().join(',')!=='ok,path' ||
        (response as {ok:unknown}).ok!==true || (response as {path:unknown}).path!==join(config.parentDirectory,'observer-auth')) throw fail();
      await validation.credentials();
      if(disabled || signal.aborted) throw fail();
      return join(config.parentDirectory,'observer-auth');
    } catch {disable();throw fail();}
    finally {active=false;}
  }};
}
