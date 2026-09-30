import type {RunningTurnDiscovery} from './conversation-record.js';

/** Authenticated session hints only. No task exists until a native start is
 * confirmed and the host revalidates the original enabled generation. */
export function createSessionStartRecovery(options:{
 now:()=>number;wallNow:()=>number;
 discover:(hostId:string,signal:AbortSignal)=>Promise<RunningTurnDiscovery|null>;
 activate:(key:string,hostId:string,result:RunningTurnDiscovery,generation:number|undefined,signal:AbortSignal)=>Promise<void>;
}){
 type Entry={hostId:string;generation:number|undefined;wallFloor:number;expires:number;due:number;controller?:AbortController};
 const entries=new Map<string,Entry>();let closed=false,inFlight=0;
 const cancel=(key:string)=>{entries.get(key)?.controller?.abort();entries.delete(key);};
 return {
  watch(key:string,hostId:string,generation:number|undefined){
   if(closed)return;
   // Replayed lifecycle hints cannot extend expiry or rewind the native floor.
   const previous=entries.get(key);
   if(previous&&previous.hostId===hostId&&previous.generation===generation)return;
   if(previous)cancel(key);
   if(entries.size>=32)return;
   entries.set(key,{hostId,generation,wallFloor:options.wallNow(),expires:options.now()+15*60*1000,due:options.now()});
  },cancel,
  tick(){
   if(closed)return;
   for(const [key,entry] of entries){
    if(options.now()>=entry.expires){cancel(key);continue;}
    if(inFlight>=2||entry.controller||options.now()<entry.due)continue;
    const controller=new AbortController();entry.controller=controller;inFlight++;
    const current=()=>!closed&&!controller.signal.aborted&&entries.get(key)===entry&&options.now()<entry.expires;
    const timer=setTimeout(()=>controller.abort(),15000);timer.unref?.();
    void options.discover(entry.hostId,controller.signal).then(async result=>{
     if(!current()||!result||!Number.isSafeInteger(result.startedAtMs)||result.startedAtMs<entry.wallFloor||
       result.startedAtMs>options.wallNow())return;
     if(!await result.confirm(controller.signal)||!current())return;
     await options.activate(key,entry.hostId,result,entry.generation,controller.signal);
     if(current())cancel(key);
    }).catch(()=>{/* Missing evidence never authorizes a task or model call. */}).finally(()=>{
     clearTimeout(timer);inFlight--;delete entry.controller;entry.due=options.now()+5000;
    });
   }
  },close(){closed=true;for(const key of entries.keys())cancel(key);},
 };
}
