import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {Invocation} from './owned-process.js';
import {captureInvocationProcessIdentity} from './invocation-process.js';
import {createObserverAppServerRpc} from './observer-app-server-rpc.js';
import type {ChatgptAuthRefreshHandler} from './observer-auth-refresh-rpc.js';

/** One direct child for a source conversation, independent of individual
 * operations. Caller persists its captured identity against active admissions.
 * No tools are permitted by the trusted invocation profile. */
export function createObserverSessionProcess(options:{captureIdentity?:typeof captureInvocationProcessIdentity;cleanupMs?:number;onRemoteError?:(error:{code:number;message:string})=>void;onChatgptAuthTokensRefresh?:ChatgptAuthRefreshHandler}={}) {
 let child:ChildProcessWithoutNullStreams|undefined,rpc:ReturnType<typeof createObserverAppServerRpc>|undefined;
 let disabled=false,closed=true,poisoned=false,started=false,closing:Promise<void>|undefined;
 let exit:Promise<void>|undefined;
 const cleanupMs=options.cleanupMs??5000;
 if(!Number.isSafeInteger(cleanupMs)||cleanupMs<1||cleanupMs>5000)throw Error('SESSION_PROCESS_DEADLINE');
 const status=()=>({alive:!!child&&!closed,closed,poisoned,disabled});
 const kill=()=>{if(child&&!closed){try{child.kill();}catch{poisoned=true;}}};
 const disable=()=>{disabled=true;rpc?.close();kill();};
 const close=():Promise<void>=>{
   if(closing)return closing;
   disabled=true;rpc?.close();
   closing=(async()=>{
     if(!child||closed)return;
     const owned=child;let grace:ReturnType<typeof setTimeout>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
     try{
       grace=setTimeout(kill,Math.min(500,cleanupMs));
       const timedOut=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{poisoned=true;kill();reject(Error('SESSION_PROCESS_CLOSE_UNCONFIRMED'));},cleanupMs);});
       owned.stdin.end();await Promise.race([exit,timedOut]);
       if(!closed)throw Error('SESSION_PROCESS_CLOSE_UNCONFIRMED');
     }finally{clearTimeout(grace);clearTimeout(deadline);}
   })();return closing;
 };
 return {status,disable,close,
   async start(invocation:Invocation){
     if(disabled)throw Error('SESSION_PROCESS_DISABLED');
     if(started)throw Error('SESSION_PROCESS_ALREADY_STARTED');
     if(!isAbsolute(invocation.executable)||!isAbsolute(invocation.cwd)||invocation.input!==''||invocation.args.length>256||invocation.args.some(a=>typeof a!=='string'||a.includes('\0')))throw Error('SESSION_PROCESS_INVOCATION');
     started=true;closed=false;
     try{child=spawn(invocation.executable,[...invocation.args],{cwd:invocation.cwd,env:{...invocation.env},windowsHide:true,shell:false,stdio:'pipe'});}
     catch{closed=true;throw Error('SESSION_PROCESS_SPAWN');}
     const owned=child;
     exit=new Promise<void>(resolve=>{owned.once('close',()=>{closed=true;rpc?.close();resolve();});});
     owned.on('error',()=>{rpc?.close();kill();});
     owned.stdin.on('error',()=>{rpc?.close();kill();});
     owned.stderr.on('error',()=>{rpc?.close();kill();});
     // Drain diagnostics without retaining private stderr. Bound abnormal floods.
     let stderrBytes=0;owned.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65536){rpc?.close();kill();}});
     rpc=createObserverAppServerRpc({input:owned.stdin,output:owned.stdout,...(options.onRemoteError?{onRemoteError:options.onRemoteError}:{}),...(options.onChatgptAuthTokensRefresh?{onChatgptAuthTokensRefresh:options.onChatgptAuthTokensRefresh}:{})});
     try{
       const pid=owned.pid;if(!pid)throw Error('SESSION_PROCESS_SPAWN');
       const creationIdentity=await (options.captureIdentity??captureInvocationProcessIdentity)(pid);
       if(!creationIdentity||closed||disabled)throw Error('SESSION_PROCESS_IDENTITY');
       return {rpc,pid,creationIdentity};
     }catch(error){await close();throw error;}
   },
 };
}
