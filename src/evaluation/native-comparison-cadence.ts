import {ordinaryRequestIntervalSeconds} from '../estimation/long-task-policy.js';
import {createNativeRetentionPermit,type NativeRetentionState} from '../estimation/native-owner-retention.js';
export const comparisonRunTimeoutMs=(paired:boolean):number=>
 900000+(paired?ordinaryRequestIntervalSeconds(Number.MAX_SAFE_INTEGER,0)*1000:0);

/** Diagnostic adapter uses production cadence; waiting is outside measured preparation. */
export function comparisonReleasePlan(state:NativeRetentionState,requestStartedAtMs:number,idleStartedAtMs:number,remainingSeconds:number){
 if(!Number.isFinite(requestStartedAtMs)||requestStartedAtMs<0||!Number.isFinite(idleStartedAtMs)||idleStartedAtMs<requestStartedAtMs||
   !Number.isFinite(remainingSeconds)||remainingSeconds<0)throw Error('TRIAL_CADENCE_INVALID');
 const nextOrdinaryAtMs=requestStartedAtMs+ordinaryRequestIntervalSeconds(remainingSeconds,0)*1000;
 const permit=createNativeRetentionPermit({...state,idleStartedAtMs,nextOrdinaryAtMs});
 if(!permit)throw Error('TRIAL_CADENCE_INVALID');
 return {nextOrdinaryAtMs,permit};
}

export async function waitForComparisonEligibility(nextAtMs:number,signal:AbortSignal,now:()=>number,wait:(ms:number)=>Promise<void>):Promise<number>{
 signal.throwIfAborted();
 const began=now();let current=began;
 if(!Number.isFinite(nextAtMs)||nextAtMs<0||!Number.isFinite(began)||began<0)throw Error('TRIAL_CADENCE_CLOCK_INVALID');
 while(current<nextAtMs){
  signal.throwIfAborted();await wait(Math.min(60000,nextAtMs-current));signal.throwIfAborted();
  const after=now();
  if(!Number.isFinite(after)||after<=current)throw Error('TRIAL_CADENCE_CLOCK_INVALID');
  current=after;
 }
 return current-began;
}
