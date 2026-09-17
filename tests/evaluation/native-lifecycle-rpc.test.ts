import {expect,it} from 'vitest';
import {guardNativeLifecycleRpc,nativeLifecycleSchedule} from '../../src/evaluation/native-lifecycle-rpc.js';

it('allows only the fixed no-inference immediate or real five-minute lifecycle schedule',()=>{
 expect(nativeLifecycleSchedule(undefined)).toEqual({requests:3,intervalMs:0,timeoutMs:120000});
 expect(nativeLifecycleSchedule('--cadence-5m')).toEqual({requests:2,intervalMs:300000,timeoutMs:420000});
 expect(()=>nativeLifecycleSchedule('--cadence-1s')).toThrow('LIFECYCLE_MODE_INVALID');
});
import type {SessionRpc} from '../../src/estimation/observer-persistent-session.js';
it('blocks every inference-capable operation before reaching the runtime',async()=>{
 const calls:string[]=[];let stopped=0;
 const rpc:SessionRpc={call:async method=>{calls.push(method);return {};},subscribe:()=>()=>{}};
 for(const method of ['turn/start','thread/compact/start','thread/resume','thread/start','unknown']){
  const guard=guardNativeLifecycleRpc(rpc,()=>{stopped++;});
  await expect(guard.rpc.call(method,{})).rejects.toThrow('NATIVE_LIFECYCLE_RPC_FORBIDDEN');guard.close();
 }
 expect(calls).toEqual([]);expect(stopped).toBe(5);
});
it('fails closed on unexpected model activity and unsubscribes on completion',async()=>{
 let listener:((n:{method:string;params:Record<string,unknown>})=>void)|undefined,stopped=0;
 const guard=guardNativeLifecycleRpc({call:async()=>({}),subscribe:callback=>{listener=callback;return()=>{listener=undefined;};}},()=>{stopped++;});
 await expect(guard.rpc.call('thread/goal/get',{threadId:'fork'})).resolves.toEqual({});
 listener!({method:'turn/started',params:{}});
 await expect(guard.rpc.call('thread/read',{threadId:'fork'})).rejects.toThrow('NATIVE_LIFECYCLE_STOPPED');
 expect(stopped).toBe(1);guard.close();expect(listener).toBeUndefined();
});
