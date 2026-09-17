import type {NativeRetentionState} from '../estimation/native-owner-retention.js';

/** Diagnostic adapter: state replacement synchronously revokes retention but
 * starts asynchronous cleanup. Join that cleanup; never bypass a busy guard.
 * The caller keeps this inside the timed preparation section. */
export async function transitionComparisonNativeState(
 worker:{updateRetentionState:(state:NativeRetentionState)=>void;release:()=>Promise<void>;status?:()=>{nativeLifecycle?:{retained:boolean}}},
 previous:NativeRetentionState|null,next:NativeRetentionState,signal:AbortSignal,
):Promise<void>{
 signal.throwIfAborted();
 worker.updateRetentionState(next);
 // The worker alone grants bounded process retention. This adapter must not
 // turn an accepted transition into unconditional release; acquisition still
 // validates the permit, account, source and cumulative resource limits.
 const retained=worker.status?.().nativeLifecycle?.retained===true;
 if(previous&&(previous.conversationKey!==next.conversationKey||previous.turnKey!==next.turnKey||
  previous.generation!==next.generation||previous.running!==next.running)&&!retained){
  await worker.release();
 }
 signal.throwIfAborted();
}
