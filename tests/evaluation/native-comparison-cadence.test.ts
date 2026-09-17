import {expect,it} from 'vitest';
import * as cadence from '../../src/evaluation/native-comparison-cadence.js';
const state={conversationKey:'trial-native',turnKey:'source-turn',generation:0,running:true};
it('leaves fifteen minutes of operation budget after a valid thirty-minute cadence',()=>{
 expect(cadence.comparisonRunTimeoutMs(true)-1800000).toBe(900000);
 expect(cadence.comparisonRunTimeoutMs(false)).toBe(900000);
});
it('anchors ordinary eligibility to the actual request, not to delayed release',()=>{
 expect(cadence.comparisonReleasePlan(state,1000,21000,300)).toEqual({
  nextOrdinaryAtMs:301000,
  permit:{conversationKey:'trial-native',turnKey:'source-turn',generation:0,idleStartedAtMs:21000,deadlineMs:361000}
 });
 expect(cadence.comparisonReleasePlan(state,1000,21000,3600).nextOrdinaryAtMs).toBe(601000);
 expect(()=>cadence.comparisonReleasePlan(state,22000,21000,300)).toThrow('TRIAL_CADENCE_INVALID');
 expect(()=>cadence.comparisonReleasePlan({...state,running:false},1000,21000,300)).toThrow('TRIAL_CADENCE_INVALID');
});
it('waits the full real cadence in abortable bounded pieces and rejects a reversed clock',async()=>{
 let now=21000;const waits:number[]=[];
 const elapsed=await cadence.waitForComparisonEligibility(301000,new AbortController().signal,()=>now,async ms=>{waits.push(ms);now+=ms;});
 expect(now).toBe(301000);expect(elapsed).toBe(280000);
 expect(waits).toEqual([60000,60000,60000,60000,40000]);
 await expect(cadence.waitForComparisonEligibility(401000,new AbortController().signal,()=>now,async()=>{now--;})).rejects.toThrow('TRIAL_CADENCE_CLOCK_INVALID');
 const c=new AbortController();c.abort();
 await expect(cadence.waitForComparisonEligibility(501000,c.signal,()=>now,async()=>{throw Error('must not wait');})).rejects.toThrow();
});
