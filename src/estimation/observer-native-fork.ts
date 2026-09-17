import type {SessionRpc} from './observer-persistent-session.js';
import {nativePreservationInstructions} from './native-preservation.js';

export type NativeForkOrigin =
 | {kind?:'snapshot';sourceThreadId:string;path:string;lastTurnId?:string}
 | {kind:'owned-base';sourceThreadId:string;rootSourceThreadId:string;lastTurnId:string};
export type NativeForkSource=NativeForkOrigin&{
 cwd:string;baseInstructions:string;developerInstructions:string;custodyTag:string;
};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Internal protocol boundary only: caller attests snapshot/config, admits any
 * possible model work, and closes the owned process after any failure. Never
 * pass a source task ID to goal/clear, even if the runtime misbehaves. */
export async function forkObserverThread(rpc:SessionRpc,source:NativeForkSource,signal:AbortSignal,onCreated?:(threadId:string)=>Promise<void>):Promise<{threadId:string}>{
 signal.throwIfAborted();
 const validId=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
 if(!validId(source.sourceThreadId)||
  (source.kind!==undefined&&source.kind!=='snapshot'&&source.kind!=='owned-base')||
  (source.kind!==undefined&&!validId(source.lastTurnId))||
  (source.lastTurnId!==undefined&&!validId(source.lastTurnId))||
  (source.kind==='owned-base'?(Object.hasOwn(source,'path')||!validId(source.rootSourceThreadId)||source.rootSourceThreadId===source.sourceThreadId):!validId(source.path))){
   throw Error('NATIVE_FORK_ORIGIN_INVALID');
 }
 const response=object(await rpc.call('thread/fork',{
   threadId:source.sourceThreadId,...(source.kind==='owned-base'?{}:{path:source.path}),
   ...(source.lastTurnId===undefined?{}:{lastTurnId:source.lastTurnId}),
   ephemeral:false,excludeTurns:true,deferGoalContinuation:true,
   threadSource:source.custodyTag,
   cwd:source.cwd,runtimeWorkspaceRoots:[source.cwd],sandbox:'read-only',approvalPolicy:'never',
   model:'gpt-5.6-luna',modelProvider:'openai',serviceTier:'default',
   baseInstructions:`${source.baseInstructions}\n${nativePreservationInstructions}`,developerInstructions:source.developerInstructions,
   config:{model_reasoning_effort:'medium',web_search:'disabled',
     'features.goals':false,'features.tool_suggest':false,'features.in_app_local_automation':false},
 }));
 const threadId=object(response.thread).id;
 if(typeof threadId!=='string'||threadId.length===0||threadId===source.sourceThreadId||
  (source.kind==='owned-base'&&threadId===source.rootSourceThreadId))throw Error('NATIVE_FORK_ID_INVALID');
 // Persist custody before honoring a cancellation delivered with the reply.
 // A cancelled fork still exists and must remain recoverable by its owner.
 await onCreated?.(threadId);
 signal.throwIfAborted();
 await rpc.call('thread/goal/clear',{threadId});
 signal.throwIfAborted();
 const goal=object(await rpc.call('thread/goal/get',{threadId}));
 signal.throwIfAborted();
 if(!Object.hasOwn(goal,'goal')||goal.goal!==null)throw Error('NATIVE_FORK_GOAL_UNVERIFIED');
 return {threadId};
}
