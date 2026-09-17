import type {NativeTurnSource} from '../observer/native-source-request.js';

export interface NativeTurnBase {
 readonly key:string;
 readonly threadId:string|null;
 readonly lastTurnId:string|null;
}
type Source=Pick<NativeTurnSource,'identity'|'sourceEpoch'|'currentTurnId'|'baseKey'|'boundary'|'validate'>;

/** Identity/creation state only. The caller durably claims every runtime resource
 * before creating it; close joins work but never deletes resources or assumes
 * that an acknowledged fork means the owning process has exited. */
export function createNativeTurnBaseOwner(){
 let binding:string|undefined,closed=false,failed=false;
 let creation:Promise<NativeTurnBase>|undefined;
 const pending=new Set<Promise<NativeTurnBase>>();
 const available=()=>{if(closed||failed)throw Error('NATIVE_BASE_UNAVAILABLE');};
 return {
  acquire(source:Source,signal:AbortSignal,create:(signal:AbortSignal)=>Promise<string>):Promise<NativeTurnBase>{
   const work=(async()=>{
    try{
     available();signal.throwIfAborted();
     const boundary=source.boundary;
     const captured=JSON.stringify([source.identity,source.sourceEpoch,source.currentTurnId,source.baseKey,boundary.currentTurnId,boundary.currentStartOffset,boundary.completed]);
     if(binding!==undefined&&binding!==captured)throw Error('NATIVE_BASE_BINDING_CHANGED');
     binding=captured;
     await source.validate(signal);available();signal.throwIfAborted();
     if(!creation){
      // Capture scalar identity before awaiting creation. A later trigger may
      // grow the supplement but cannot change this terminal cutoff.
      const key=source.baseKey,lastTurnId=boundary.completed?.turnId??null;
      creation=(async()=>{
       const threadId=lastTurnId===null?null:await create(signal);
       if(lastTurnId!==null&&(typeof threadId!=='string'||!threadId.trim()))throw Error('NATIVE_BASE_ID_INVALID');
       available();signal.throwIfAborted();
       return Object.freeze({key,threadId,lastTurnId});
      })();
     }
     const result=await creation;
     await source.validate(signal);available();signal.throwIfAborted();
     return result;
    }catch(error){failed=true;throw error;}
   })();
   pending.add(work);
   // Avoid an unobserved rejecting finally promise while retaining the original.
   void work.then(()=>pending.delete(work),()=>pending.delete(work));
   return work;
  },
  async close(){closed=true;await Promise.allSettled([...pending]);}
 };
}
