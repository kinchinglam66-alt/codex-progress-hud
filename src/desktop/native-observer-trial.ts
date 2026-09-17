import {resolve} from 'node:path';
import {createObserverIdentityRuntime} from '../estimation/observer-identity-runtime.js';
import {createNativeWorkerResources} from '../estimation/native-worker-resources.js';
import {createNativeGuard} from '../estimation/native-guard.js';

/** Trusted host resource composition. Diagnostics supply their bounded options;
 * native-production-worker fixes the installed policy. Conversation payloads
 * cannot select a runtime, change limits or grant model-call authorization. */
export interface NativeObserverTrial {maxSourceBytes:number;mode?:'legacy'|'completed-turn';reuseNativeGuard?:boolean;retainNativeGuard?:boolean}
type IdentityOptions=Parameters<typeof createObserverIdentityRuntime>[0];
const PIN='ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b';
// Safety ceiling, NOT evidence of effective model context capacity.
const TRIAL_SOURCE_CEILING=8*1024*1024;
export function assertNativeObserverRuntime(identity:Pick<IdentityOptions,'version'|'executableSha256'>):void{
 if(identity.version!=='0.153.4'||identity.executableSha256!==PIN)throw Error('NATIVE_TRIAL_RUNTIME_UNVERIFIED');
}
export function createNativeObserverTrial(identity:IdentityOptions,trial:NativeObserverTrial|undefined){
 if(trial===undefined)return undefined;
 if(trial.retainNativeGuard&&(!trial.reuseNativeGuard||trial.mode!=='completed-turn'))throw Error('NATIVE_TRIAL_GUARD_RETENTION_INVALID');
 if(trial.mode!==undefined&&trial.mode!=='legacy'&&trial.mode!=='completed-turn')throw Error('NATIVE_TRIAL_MODE_INVALID');
 assertNativeObserverRuntime(identity);
 if(!Number.isSafeInteger(trial.maxSourceBytes)||trial.maxSourceBytes<1||trial.maxSourceBytes>TRIAL_SOURCE_CEILING)
  throw Error('NATIVE_TRIAL_SOURCE_LIMIT_INVALID');
 return createNativeWorkerResources({runtimeHome:resolve(identity.parentDirectory,'observer-auth'),maxSourceBytes:trial.maxSourceBytes,
  ...(trial.reuseNativeGuard===true?{guard:trial.retainNativeGuard
   ?createNativeGuard(resolve(identity.parentDirectory,'observer-auth'),resolve(identity.resourcesDirectory,'native-guard.ps1'),{idleTimeoutMs:1860000})
   :createNativeGuard(resolve(identity.parentDirectory,'observer-auth'),resolve(identity.resourcesDirectory,'native-guard.ps1'))}:{}),
  prepareCleanupInvocation:async signal=>{
   const cleanup=createObserverIdentityRuntime(identity);
   try{return await cleanup.prepareCleanupServer(signal);}
   finally{await cleanup.close();}
  }});
}
