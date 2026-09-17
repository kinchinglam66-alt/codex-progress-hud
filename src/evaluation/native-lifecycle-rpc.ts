import type {SessionRpc} from '../estimation/observer-persistent-session.js';
const allowed=new Set(['initialize','thread/fork','thread/goal/clear','thread/goal/get','thread/read','thread/delete']);
export function nativeLifecycleSchedule(mode:string|undefined):{requests:number;intervalMs:number;timeoutMs:number}{
 if(mode===undefined)return {requests:3,intervalMs:0,timeoutMs:120000};
 if(mode==='--cadence-5m')return {requests:2,intervalMs:300000,timeoutMs:420000};
 throw Error('LIFECYCLE_MODE_INVALID');
}
/** Synthetic no-inference probe guard. Production inference does not use this allowlist. */
export function guardNativeLifecycleRpc(rpc:SessionRpc,stop:()=>void){
 let stopped=false;
 const halt=()=>{if(!stopped){stopped=true;stop();}};
 const unsubscribe=rpc.subscribe(notification=>{
  if(notification.method==='turn/started'||notification.method==='thread/tokenUsage/updated'||
    notification.method==='item/started')halt();
 });
 return {rpc:{subscribe:rpc.subscribe,async call(method,params){
  if(stopped)throw Error('NATIVE_LIFECYCLE_STOPPED');
  if(!allowed.has(method)){halt();throw Error('NATIVE_LIFECYCLE_RPC_FORBIDDEN');}
  return rpc.call(method,params);
 }} satisfies SessionRpc,close(){stopped=true;unsubscribe();}};
}
