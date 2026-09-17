/** Host-internal lifecycle metadata, never source text or HTTP configuration. */
export interface NativeRetentionState {
 readonly conversationKey:string;readonly turnKey:string;readonly generation:number;readonly running:boolean;
 /** Host-attested normal turn-end idle only; never inferred from !running. */
 readonly idleEligible?:boolean;
}
export interface NativeRetentionPermit {
 readonly conversationKey:string;readonly turnKey:string;readonly generation:number;
 readonly idleStartedAtMs:number;readonly deadlineMs:number;
}
export type NativeRetirementReason='request_end'|'state_revoked'|'account_changed'|'disabled'|'idle_expired'|'clock_invalid'|'permit_invalid'|'resource_limit'|'resource_unknown'|'process_unhealthy'|'binding_changed'|'operation_failed';
/** Read-only local diagnostics: no source, account, path or provider identifiers. */
export interface NativeLifecycleDiagnostic {
 generation:number;processStarts:number;reuses:number;requests:number|null;knownBytes:number|null;
 retained:boolean;idleRemainingMs:number|null;retirementReason:NativeRetirementReason|null;
}
const clock=(value:number)=>Number.isFinite(value)&&value>=0;
const identified=(state:NativeRetentionState)=>state.conversationKey.length>0&&state.turnKey.length>0&&
 Number.isSafeInteger(state.generation)&&state.generation>=0&&state.running===true;
export function createNativeRetentionPermit(input:NativeRetentionState&{idleStartedAtMs:number;nextOrdinaryAtMs:number}):NativeRetentionPermit|null{
 if(!identified(input)||!clock(input.idleStartedAtMs)||!clock(input.nextOrdinaryAtMs))return null;
 const deadlineMs=Math.min(input.idleStartedAtMs+1860000,Math.max(input.idleStartedAtMs+60000,input.nextOrdinaryAtMs+60000));
 if(!Number.isFinite(deadlineMs)||deadlineMs<=input.idleStartedAtMs)return null;
 return Object.freeze({conversationKey:input.conversationKey,turnKey:input.turnKey,generation:input.generation,
  idleStartedAtMs:input.idleStartedAtMs,deadlineMs});
}
export function nativeRetentionValid(permit:NativeRetentionPermit|null|undefined,state:NativeRetentionState|null|undefined,nowMs:number):boolean{
 return !!permit&&!!state&&identified(state)&&clock(nowMs)&&clock(permit.idleStartedAtMs)&&
  Number.isFinite(permit.deadlineMs)&&permit.deadlineMs>permit.idleStartedAtMs&&
  permit.deadlineMs<=permit.idleStartedAtMs+1860000&&
  state.conversationKey===permit.conversationKey&&state.turnKey===permit.turnKey&&state.generation===permit.generation&&
  nowMs>=permit.idleStartedAtMs&&nowMs<permit.deadlineMs;
}

/** Runtime retention only, never a model dispatch or old-result acceptance
 * proof. A new turn may reuse the remaining lifetime, never extend it. */
export function nativeProcessRetentionValid(permit:NativeRetentionPermit|null|undefined,state:NativeRetentionState|null|undefined,nowMs:number):boolean{
 if(!permit||!state||!(state.running===true||state.idleEligible===true))return false;
 if(!identified({...state,running:true})||!identified({...permit,running:true}))return false;
 const sameTurn=state.turnKey===permit.turnKey;
 if(sameTurn?state.generation!==permit.generation:state.generation<=permit.generation)return false;
 return nativeRetentionValid(permit,{...state,turnKey:permit.turnKey,generation:permit.generation,running:true},nowMs);
}
