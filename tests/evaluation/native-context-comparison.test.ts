import {expect,it} from 'vitest';
import {runNativeContextComparison} from '../../src/evaluation/native-context-comparison.js';
const checkpoints=['a','b','c'].map(hash=>({contextHash:hash.repeat(64),expectedMarkers:['EARLY-7',`CURRENT-${hash}`],expectedImageColor:'red' as const}));
it('reports a separate split gate without replacing the legacy gate',async()=>{
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{
  const value=output(index,strategy);
  if(index>0&&strategy==='native')value.record.stages.snapshotMs=60;
  return value;
 });
 expect(result.gate.passed).toBe(false);
 expect(result).toHaveProperty('splitGate');
 expect(result.splitGate.passed).toBe(true);
 expect(result.splitUsageGate.passed).toBe(true);
});
it.each(['content','expired'] as const)('rejects %s evidence in the split gate without stage shifting',async failure=>{
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{
  const value=output(index,strategy);
  if(index===1&&strategy==='native'){
   if(failure==='content')value.result.interpretation.summary='missing';
   else value.deliveryAgeMs=300000;
  }
  return value;
 },'paired','collect-expired','collect-invalid-content');
 expect(result).toHaveProperty('splitGate');
 expect(result.splitGate.passed).toBe(false);
 expect(result.splitGate.validPairCount).toBe(2);
 expect(result.splitGate.stages[1]?.stage).toBe('same-turn');
 expect(result.splitUsageGate.passed).toBe(false);
 expect(result.splitUsageGate.validPairCount).toBe(2);
});
it('collects the fixed six slots after content failure but invalidates the pair and entire gate',async()=>{
 const calls:string[]=[];
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls.push(`${index}:${strategy}`);const value=output(index,strategy);
  if(index===0&&strategy==='native')value.result.interpretation.summary='CURRENT-a red';
  return value;
 },'paired','collect-expired','collect-invalid-content');
 expect(calls).toEqual(['0:history','0:native','1:native','1:history','2:history','2:native']);
 expect(result.contextFailures).toEqual([{index:0,strategy:'native',missingMarkerIndices:[0],imageMatched:true}]);
 expect(result.pairs).toHaveLength(3);expect(result.gate.validPairCount).toBe(2);expect(result.gate.passed).toBe(false);
 expect(result.gate.reasons).toContain('unverified_context_samples');
 expect(result.timingSummary.pairCount).toBe(3);
});
it('never passes when every slot has missing image evidence',async()=>{
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{
  const value=output(index,strategy);value.result.interpretation.summary=`EARLY-7 CURRENT-${String.fromCharCode(97+index)}`;return value;
 },'paired','collect-expired','collect-invalid-content');
 expect(result.contextFailures).toHaveLength(6);expect(result.gate.validPairCount).toBe(0);expect(result.gate.passed).toBe(false);
});
it('keeps the original gate when every collected slot is valid',async()=>{
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>output(index,strategy),'paired','collect-expired','collect-invalid-content');
 expect(result.contextFailures).toEqual([]);expect(result.gate.validPairCount).toBe(3);expect(result.gate.passed).toBe(true);
});
it.each([0,1])('unions expired and content-invalid pair identities without double removal (%s)',async failedIndex=>{
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{
  const value=output(index,strategy);
  if(index===0&&strategy==='history')value.deliveryAgeMs=300000;
  if(index===failedIndex&&strategy==='native')value.result.interpretation.summary='missing';
  return value;
 },'paired','collect-expired','collect-invalid-content');
 expect(result.gate.validPairCount).toBe(failedIndex===0?2:1);
 expect(result.gate.passed).toBe(false);
 expect(result.gate.reasons).toEqual(expect.arrayContaining(['expired_eta_samples','unverified_context_samples']));
});
it.each(['source','cleanup','isolation','malformed','runtime'] as const)('still stops immediately on %s while collecting semantic failures',async broken=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);value.result.interpretation.summary='missing';
  if(broken==='source')value.sourceUnchanged=false;
  if(broken==='cleanup')value.cleanupConfirmed=false;
  if(broken==='isolation')value.toolsIsolated=false;
  if(broken==='malformed')value.result.interpretation.estimate.remainingSeconds=-1;
  if(broken==='runtime')throw Error('runtime failure');
  return value;
 },'paired','collect-expired','collect-invalid-content')).rejects.toThrow();
 expect(calls).toBe(1);
});
it('rejects unsupported collection policy and native-only collection before invoking',async()=>{
 let calls=0;const run=async(index:number,strategy:'history'|'native')=>{calls++;return output(index,strategy);};
 await expect(runNativeContextComparison(checkpoints,run,'paired','stop','invalid' as never)).rejects.toThrow('COMPARISON_CONTENT_POLICY_INVALID');
 await expect(runNativeContextComparison(checkpoints,run,'native-diagnostic','stop','collect-invalid-content')).rejects.toThrow('COMPARISON_CONTENT_POLICY_INVALID');
 expect(calls).toBe(0);
});
function output(index:number,strategy:'history'|'native'){
 return {record:{strategy,version:'trial-v1',processState:strategy==='history'&&index>0?'warm' as const:'cold' as const,
  contextIdentityHash:checkpoints[index]!.contextHash,contextAgeMs:100,knownTokens:100,cacheTokens:0,unknownTokenCount:0,
  stages:{queueMs:10,snapshotMs:strategy==='history'?60:20,accountProcessMs:10,forkImportMs:20,compactionMs:0,inferenceMs:100,deliveryMs:10}},
  result:{status:'interpreted' as const,usage:null,interpretation:{relation:'continue' as const,status:'running' as const,
   summary:`EARLY-7 CURRENT-${String.fromCharCode(97+index)} red`,estimate:{remainingSeconds:300,errorPercent:50}}},
  deliveryAgeMs:150,sourceUnchanged:true,cleanupConfirmed:true,toolsIsolated:true};
}
it('executes three distinct checkpoints in alternating paired order and keeps native cold resets in the warm comparison',async()=>{
 const calls:string[]=[];
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{calls.push(`${index}:${strategy}`);return output(index,strategy);});
 expect(calls).toEqual(['0:history','0:native','1:native','1:history','2:history','2:native']);
 expect(result.pairs).toHaveLength(3);expect(result.gate.passed).toBe(true);
});
it('distinguishes an expired valid ETA from a missing answer and stops before another call',async()=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);value.result.interpretation.estimate.remainingSeconds=120;value.deliveryAgeMs=229383;
  return value;
 })).rejects.toThrow('COMPARISON_ETA_EXPIRED');
 expect(calls).toBe(1);
});
it('does not let a refreshed active clock hide an expired source snapshot',async()=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);
  value.record.contextAgeMs=229383;
  value.deliveryAgeMs=11072;
  value.result.interpretation.estimate.remainingSeconds=120;
  return value;
 },'native-diagnostic')).rejects.toThrow('COMPARISON_ETA_EXPIRED');
 expect(calls).toBe(1);
});
it('collects expired samples without counting their pairs as valid or passing the gate',async()=>{
 let calls=0;
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);
  if(index===0&&strategy==='history')value.deliveryAgeMs=300000;
  return value;
 },'paired','collect-expired');
 expect(calls).toBe(6);expect(result.pairs).toHaveLength(3);
 expect(result.expiredSamples).toEqual([{index:0,strategy:'history',remainingSeconds:300,ageMs:300000}]);
 expect(result.gate.passed).toBe(false);expect(result.gate.validPairCount).toBe(2);
 expect(result.gate.reasons).toContain('expired_eta_samples');
});
it.each(['content','cleanup','source','model'] as const)('still stops on %s failure while collecting expired samples',async broken=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);value.deliveryAgeMs=300000;
  if(broken==='content')value.result.interpretation.summary='missing';
  if(broken==='cleanup')value.cleanupConfirmed=false;
  if(broken==='source')value.sourceUnchanged=false;
  if(broken==='model')throw Error('model failed');
  return value;
 },'paired','collect-expired')).rejects.toThrow();
 expect(calls).toBe(1);
});
it('runs only one native diagnosis without treating it as a valid performance pair',async()=>{
 const calls:string[]=[];
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{calls.push(`${index}:${strategy}`);return output(index,strategy);},'native-diagnostic');
 expect(calls).toEqual(['0:native']);expect(result.pairs).toHaveLength(0);expect(result.gate.passed).toBe(false);
});
it('runs all three native checkpoints for cross-turn diagnosis without producing performance pairs',async()=>{
 const calls:string[]=[];
 const result=await runNativeContextComparison(checkpoints,async(index,strategy)=>{calls.push(`${index}:${strategy}`);return output(index,strategy);},'native-sequence-diagnostic');
 expect(calls).toEqual(['0:native','1:native','2:native']);
 expect(result.pairs).toHaveLength(0);expect(result.gate.passed).toBe(false);
});
it('stops the native sequence at the first content error without substituting history or retrying',async()=>{
 const calls:number[]=[];
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls.push(index);const value=output(index,strategy);if(index===1)value.result.interpretation.summary='stale';return value;
 },'native-sequence-diagnostic')).rejects.toThrow('COMPARISON_CONTEXT_UNVERIFIED');
 expect(calls).toEqual([0,1]);
});
it('stops a native diagnosis on invalid output without a history fallback or another call',async()=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);value.result.interpretation.summary='missing evidence';return value;
 },'native-diagnostic')).rejects.toThrow('COMPARISON_CONTEXT_UNVERIFIED');
 expect(calls).toBe(1);
});
it.each(['context','isolation','cleanup','source','expired','failure'] as const)('stops without retry when %s evidence fails',async broken=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);
  if(calls===2){
   if(broken==='context')value.result.interpretation.summary='CURRENT-a red';
   if(broken==='isolation')value.toolsIsolated=false;
   if(broken==='cleanup')value.cleanupConfirmed=false;
   if(broken==='source')value.sourceUnchanged=false;
   if(broken==='expired')value.deliveryAgeMs=300000;
   if(broken==='failure')throw Error('model failed');
  }
  return value;
 })).rejects.toThrow();
 expect(calls).toBe(2);
});
it('rejects duplicate or mismatched checkpoints rather than counting them as evidence',async()=>{
 let calls=0;
 await expect(runNativeContextComparison([checkpoints[0]!,checkpoints[0]!,checkpoints[1]!],async()=>{calls++;return output(0,'history');})).rejects.toThrow('COMPARISON_CHECKPOINTS_INVALID');
 expect(calls).toBe(0);
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>({...output(index,strategy),record:{...output(index,strategy).record,contextIdentityHash:'f'.repeat(64)}}))).rejects.toThrow('COMPARISON_RECORD_MISMATCH');
});
it('rejects a changed runtime/prompt version before collecting another checkpoint',async()=>{
 let calls=0;
 await expect(runNativeContextComparison(checkpoints,async(index,strategy)=>{
  calls++;const value=output(index,strategy);if(calls===2)value.record.version='other-version';return value;
 })).rejects.toThrow('COMPARISON_VERSION_MISMATCH');
 expect(calls).toBe(2);
});
