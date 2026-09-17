import {createPersistentObserverWorker,type PersistentWorkerOptions} from '../estimation/observer-persistent-worker.js';
import type {createObserverIdentityRuntime} from '../estimation/observer-identity-runtime.js';
import {createNativeObserverTrial} from './native-observer-trial.js';

export function createDesktopPersistentWorker(identity:Parameters<typeof createObserverIdentityRuntime>[0],
 options:PersistentWorkerOptions,instructions:string){
 const nativeContext=createNativeObserverTrial(identity,{maxSourceBytes:8*1024*1024,
  mode:'completed-turn',reuseNativeGuard:true,retainNativeGuard:true});
 if(!nativeContext)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
 return createPersistentObserverWorker({...options,nativeContext,nativeInstructions:instructions,
  completedTurnContext:true,reuseNativeTurnSession:true,inlineCurrentTurnSupplement:true});
}
