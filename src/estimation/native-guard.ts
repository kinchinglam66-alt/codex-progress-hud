import {createNativeStorage} from './native-storage.js';
import {prepareNativeGuardInvocation} from './native-guard-launch.js';
import {createNativeGuardTransport} from './native-guard-transport.js';
import type {NativeGuardRequest,NativeGuardResult} from './native-guard-protocol.js';
export interface NativeGuard {
 verify(signal:AbortSignal):Promise<void>;
 isExited(identity:{pid:number;creationIdentity:string},signal:AbortSignal):Promise<boolean>;
 retire():Promise<void>;
}
/** Local resource owner only. No credential metadata or contents are inspected. */
export function createNativeGuard(runtimeHome:string,scriptPath:string,options:{idleTimeoutMs?:number}={}){
 createNativeStorage(runtimeHome); // Enforce independent local observer-auth boundary.
 let transport:ReturnType<typeof createNativeGuardTransport>|undefined;
 let busy=false,epoch=0,retiring:Promise<void>|undefined,operation:Promise<NativeGuardResult>|undefined,controller:AbortController|undefined;
 const check=(request:NativeGuardRequest,signal:AbortSignal):Promise<NativeGuardResult>=>{
  if(busy||retiring||signal.aborted)return Promise.reject(Error('NATIVE_GUARD_UNAVAILABLE'));
  busy=true;const generation=epoch;controller=new AbortController();const combined=AbortSignal.any([signal,controller.signal]);
  const current=()=>{combined.throwIfAborted();if(generation!==epoch)throw Error('NATIVE_GUARD_RETIRED');};
  operation=(async()=>{
   try{const invocation=await prepareNativeGuardInvocation(runtimeHome,scriptPath);current();transport??=createNativeGuardTransport(invocation,options);const result=await transport.check(request,combined);current();return result;}
   catch(error){await transport?.retire();throw error;}
   finally{busy=false;controller=undefined;}
  })();return operation;
 };
 return {
  async verify(signal:AbortSignal){await check({op:'verify_storage'},signal);},
  async isExited(identity:{pid:number;creationIdentity:string},signal:AbortSignal){
   return await check({op:'owner_exited',pid:identity.pid,creationIdentity:identity.creationIdentity},signal)==='exited';
  },
  retire():Promise<void>{
   if(retiring)return retiring;epoch++;controller?.abort();
   const work=(async()=>{await transport?.retire();await operation?.catch(()=>undefined);})();
   retiring=work.finally(()=>{retiring=undefined;});return retiring;
  },
  status:()=>({...transport?.status(),checking:busy,resident:transport?.status().resident??false}),
 } satisfies NativeGuard & {status():unknown};
}
