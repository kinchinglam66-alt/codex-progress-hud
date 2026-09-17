import {spawn,type ChildProcessWithoutNullStreams,type SpawnOptionsWithoutStdio} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {Invocation} from './owned-process.js';
import {encodeNativeGuardRequest,decodeNativeGuardResponse,type NativeGuardRequest,type NativeGuardResult} from './native-guard-protocol.js';
type Timer=ReturnType<typeof setTimeout>;
interface Pending {id:number;op:NativeGuardRequest['op'];resolve:(value:NativeGuardResult)=>void;reject:(error:Error)=>void;signal:AbortSignal;abort:()=>void;timer:Timer}
interface Generation {
 child:ChildProcessWithoutNullStreams;stopped:boolean;closed:boolean;buffer:Buffer;
 pending:Pending|undefined;idle:Timer|undefined;cleanup:Timer|undefined;ended:Promise<void>;finish:()=>void;
}
export interface NativeGuardTransportOptions {
 /** Trusted host policy only; never caches a previous verification result. */
 idleTimeoutMs?:number;
 spawn?:(executable:string,args:string[],options:SpawnOptionsWithoutStdio)=>ChildProcessWithoutNullStreams;
}
/** Trusted caller must attest fixed script and home on every request. */
export function createNativeGuardTransport(invocation:Omit<Invocation,'input'>,options:NativeGuardTransportOptions={}){
 const idleTimeoutMs=options.idleTimeoutMs??30000;
 if(!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<30000||idleTimeoutMs>1860000)throw Error('NATIVE_GUARD_INVALID_IDLE_TIMEOUT');
 if(!isAbsolute(invocation.executable)||!isAbsolute(invocation.cwd)||invocation.args.length>256||
  invocation.args.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw Error('NATIVE_GUARD_INVALID_LAUNCH');
 const config={...invocation,args:[...invocation.args],env:{...invocation.env}},launch=options.spawn??spawn;
 let generation:Generation|undefined,disabled=false,poisoned=false,requestId=0;
 const settleFailure=(g:Generation)=>{
  const pending=g.pending;if(!pending)return;g.pending=undefined;clearTimeout(pending.timer);
  pending.signal.removeEventListener('abort',pending.abort);pending.reject(Error('NATIVE_GUARD_FAILED'));
 };
 const stop=(g:Generation)=>{
  if(g.closed||g.stopped)return;g.stopped=true;clearTimeout(g.idle);g.idle=undefined;
  if(g.pending)clearTimeout(g.pending.timer);
  g.cleanup=setTimeout(()=>{poisoned=true;settleFailure(g);g.finish();},5000);
  try{g.child.kill();}catch{/* Actual close remains mandatory. */}
 };
 const start=():Generation=>{
  const child=launch(config.executable,[...config.args],{cwd:config.cwd,env:{...config.env},windowsHide:true,shell:false,stdio:'pipe'});
  let finish!:()=>void;const ended=new Promise<void>(resolve=>{finish=resolve;});
  const g:Generation={child,stopped:false,closed:false,buffer:Buffer.alloc(0),pending:undefined,idle:undefined,cleanup:undefined,ended,finish};
  generation=g;
  child.once('close',()=>{
   g.closed=true;clearTimeout(g.idle);clearTimeout(g.cleanup);settleFailure(g);
   if(generation===g)generation=undefined;g.finish();
  });
  const bad=()=>{if(generation===g&&!g.closed)stop(g);};
  child.on('error',bad);child.stdin.on('error',bad);child.stdout.on('error',bad);child.stderr.on('error',bad);child.stderr.on('data',bad);
  child.stdout.on('data',(chunk:Buffer)=>{
   if(generation!==g||g.closed||g.stopped)return;
   if(!g.pending||g.buffer.length+chunk.length>1024){stop(g);return;}
   g.buffer=Buffer.concat([g.buffer,chunk]);const newline=g.buffer.indexOf(10);if(newline<0)return;
   if(newline!==g.buffer.length-1){stop(g);return;}
   try{
    const result=decodeNativeGuardResponse(new TextDecoder('utf-8',{fatal:true}).decode(g.buffer.subarray(0,newline)),g.pending.id,g.pending.op);
    const pending=g.pending;g.pending=undefined;g.buffer=Buffer.alloc(0);
    clearTimeout(pending.timer);pending.signal.removeEventListener('abort',pending.abort);
    g.idle=setTimeout(()=>stop(g),idleTimeoutMs);pending.resolve(result);
   }catch{stop(g);}
  });return g;
 };
 const retire=async()=>{
  const g=generation;if(g){stop(g);await g.ended;}
  if(poisoned||(g&&!g.closed))throw Error('NATIVE_GUARD_CLOSE_UNCONFIRMED');
 };
 return {
  check(request:NativeGuardRequest,signal:AbortSignal):Promise<NativeGuardResult>{
   if(disabled||poisoned||signal.aborted||generation?.stopped||requestId>=Number.MAX_SAFE_INTEGER)
    return Promise.reject(Error('NATIVE_GUARD_UNAVAILABLE'));
   if(generation?.pending)return Promise.reject(Error('NATIVE_GUARD_BUSY'));
   let frame:string;const id=requestId+1;
   try{frame=encodeNativeGuardRequest(id,request);}catch(error){return Promise.reject(error);}
   requestId=id;let g:Generation;try{g=generation??start();}catch{return Promise.reject(Error('NATIVE_GUARD_FAILED'));}
   clearTimeout(g.idle);g.idle=undefined;
   return new Promise((resolve,reject)=>{
    const abort=()=>stop(g);
    g.pending={id,op:request.op,resolve,reject,signal,abort,timer:setTimeout(()=>stop(g),6000)};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
    try{g.child.stdin.write(frame);}catch{stop(g);}
   });
  },retire,
  async close(){disabled=true;await retire();},
  status:()=>({checking:generation?.pending!==undefined,resident:generation!==undefined,closing:generation?.stopped===true,poisoned}),
 };
}
