import type {ObserverHomeProfile} from './observer-home.js';
import {createObserverHomeValidation} from './observer-home-validation.js';
import {createHomeCheckTransport} from './home-check-transport.js';

/** One identity runtime owns this executor. No verification-result cache. */
export function createReusableHomeCheck(profile:ObserverHomeProfile) {
  const config=Object.freeze({...profile}),validation=createObserverHomeValidation(config);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','TEMP','TMP','PATH'].includes(key.toUpperCase())));
  const transport=createHomeCheckTransport({executable:config.powershell,cwd:config.parentDirectory,env,
    args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',config.scriptPath,'-ParentDirectory',config.parentDirectory,'-Persistent']},validation.authHome);
  let checking=false,disabled=false,epoch=0;
  let operation:Promise<string>|undefined;
  let controller:AbortController|undefined;
  const fail=()=>Error('OBSERVER_HOME_UNAVAILABLE');
  const retire=async()=>{
    epoch++;controller?.abort();await transport.retire();await operation?.catch(()=>undefined);
  };
  return {
    check(verifyOnly:boolean,signal:AbortSignal):Promise<string> {
      if(checking||disabled||signal.aborted||typeof verifyOnly!=='boolean')return Promise.reject(fail());
      checking=true;const generation=epoch;controller=new AbortController();
      const combined=AbortSignal.any([signal,controller.signal]);
      const check=()=>{if(disabled||combined.aborted||generation!==epoch)throw fail();};
      operation=(async()=>{
        try {
          await validation.assets();check();
          const path=await transport.check(verifyOnly,combined);check();
          await validation.credentials();check();return path;
        }catch{await transport.retire().catch(()=>undefined);throw fail();}
        finally{checking=false;controller=undefined;}
      })();
      return operation;
    },
    retire,
    async close(){disabled=true;await retire();await transport.close();},
    status(){return {...transport.status(),checking};},
  };
}
