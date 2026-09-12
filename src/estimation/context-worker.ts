import type {ObserverWorker} from './observer-scheduler.js';
import {prepareContext,type ContextPreparationOptions} from './context-preparation.js';
import type {PreparedContext} from './prepared-context.js';

export type PreparationConfiguration=Omit<ContextPreparationOptions,
  'snapshot'|'baseInput'|'currentTurnId'|'observedAtMs'|'signal'> & {close?:()=>Promise<void>};
export interface PreparationScope {conversationKey:string;turnGeneration:number;sourceEpoch:number;signal:AbortSignal}

/** One cancellation owner spans history preparation and its compression calls.
 * The configured provider remains responsible for authorization and accounting. */
export function withContextPreparation(delegate:ObserverWorker,
  configure:(scope:PreparationScope)=>Promise<PreparationConfiguration>):ObserverWorker {
  let disabled=false,poisoned=false;
  let pending:Promise<PreparedContext>|undefined;
  let controller:AbortController|undefined;
  const worker:ObserverWorker={
    ...delegate,
    observe(input,signal,key,generation,onStage){
      if(disabled||poisoned)return Promise.resolve({status:'disabled',interpretation:null,usage:null});
      if(pending)return Promise.resolve({status:'busy',interpretation:null,usage:null});
      return delegate.observe(input,signal,key,generation,onStage);
    },
    status(){const state=delegate.status();return {...state,active:!!pending||state.active,
      disabled:disabled||state.disabled,poisoned:poisoned||state.poisoned};},
    disable(){disabled=true;controller?.abort();delegate.disable();},
    async close(){worker.disable();await pending?.catch(()=>undefined);await delegate.close();},
    prepareContext(input,history,signal,key,generation,observedAtMs){
      if(disabled||poisoned||pending||delegate.status().active){
        return history.snapshot.close().then(()=>{throw Error('context_preparation_unavailable');});
      }
      const ownedController=new AbortController();controller=ownedController;
      const combined=AbortSignal.any([signal,ownedController.signal]);
      const operation=(async()=>{
        let config:PreparationConfiguration|undefined;
        try{
          combined.throwIfAborted();
          config=await configure({conversationKey:key,turnGeneration:generation,sourceEpoch:history.snapshot.sourceEpoch,signal:combined});
          combined.throwIfAborted();
          return await prepareContext({...config,snapshot:history.snapshot,currentTurnId:history.currentTurnId,
            baseInput:input,observedAtMs,signal:combined});
        }finally{
          try{await config?.close?.();}catch{poisoned=true;throw Error('compression_cleanup_unconfirmed');}
          finally{await history.snapshot.close();}
        }
      })();
      const owned=operation.finally(()=>{if(pending===owned)pending=undefined;if(controller===ownedController)controller=undefined;});
      pending=owned;return owned;
    },
  };
  return worker;
}
