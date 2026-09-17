import {createNativeContextPhaseRecord,evaluateNativeContextPairs,evaluateNativeContextSplitPairs,evaluateNativeContextSplitUsagePairs,type NativeContextPair,type NativeContextPhaseRecord,type NativeContextStrategy} from '../estimation/native-context-metrics.js';
import type {ObserverResult} from '../estimation/observer-provider.js';
import {observerResponseSchema} from '../estimation/observer-contract.js';
export interface ComparisonCheckpoint {contextHash:string;expectedMarkers:readonly string[];expectedImageColor:'red'}
export interface ComparisonOutput {record:NativeContextPhaseRecord;result:ObserverResult;deliveryAgeMs:number;sourceUnchanged:boolean;cleanupConfirmed:boolean;toolsIsolated:boolean}
export function comparisonContextEvidence(checkpoint:ComparisonCheckpoint,summary:string){
 const missingMarkerIndices=checkpoint.expectedMarkers.flatMap((marker,index)=>summary.includes(marker)?[]:[index]);
 const imageMatched=/(?:\bred\b|红|紅)/iu.test(summary);
 return {missingMarkerIndices,imageMatched,verified:missingMarkerIndices.length===0&&imageMatched};
}
/** Six calls maximum; the adapter separately owns durable admission before
 * every ETA/compaction. Only explicitly authorized expired-sample collection
 * may continue a failed freshness check; it never turns a failure into a pass. */
export async function runNativeContextComparison(checkpoints:readonly ComparisonCheckpoint[],run:(index:number,strategy:NativeContextStrategy)=>Promise<ComparisonOutput>,mode:'paired'|'native-diagnostic'|'native-sequence-diagnostic'='paired',expiryPolicy:'stop'|'collect-expired'='stop',contentPolicy:'stop'|'collect-invalid-content'='stop'){
 if(!['stop','collect-invalid-content'].includes(contentPolicy)||contentPolicy==='collect-invalid-content'&&mode!=='paired')throw Error('COMPARISON_CONTENT_POLICY_INVALID');
 if(expiryPolicy!=='stop'&&expiryPolicy!=='collect-expired')throw Error('COMPARISON_EXPIRY_POLICY_INVALID');
 if(mode!=='paired'&&mode!=='native-diagnostic'&&mode!=='native-sequence-diagnostic')throw Error('COMPARISON_MODE_INVALID');
 if(checkpoints.length!==3||new Set(checkpoints.map(c=>c.contextHash)).size!==3||checkpoints.some(c=>
  !/^[a-f0-9]{64}$/.test(c.contextHash)||c.expectedImageColor!=='red'||c.expectedMarkers.length<2||
  c.expectedMarkers.some(m=>typeof m!=='string'||!m||m.length>128)))throw Error('COMPARISON_CHECKPOINTS_INVALID');
 const pairs:NativeContextPair[]=[];let version:string|undefined;
 const expiredSamples:Array<{index:number;strategy:NativeContextStrategy;remainingSeconds:number;ageMs:number}>=[];
 const contextFailures:Array<{index:number;strategy:NativeContextStrategy;missingMarkerIndices:number[];imageMatched:boolean}>=[];
 for(let index=0;index<(mode==='native-diagnostic'?1:3);index++){
  const checkpoint=checkpoints[index]!,rows:Partial<Record<NativeContextStrategy,NativeContextPhaseRecord>>={};
  const order:NativeContextStrategy[]=mode!=='paired'?['native']:index%2===0?['history','native']:['native','history'];
  for(const strategy of order){
   const output=await run(index,strategy);
   if(output.sourceUnchanged!==true||output.cleanupConfirmed!==true||output.toolsIsolated!==true)throw Error('COMPARISON_ISOLATION_FAILED');
   const record=createNativeContextPhaseRecord(output.record);
   if(record.strategy!==strategy||record.contextIdentityHash!==checkpoint.contextHash)throw Error('COMPARISON_RECORD_MISMATCH');
   if(version!==undefined&&version!==record.version)throw Error('COMPARISON_VERSION_MISMATCH');version=record.version;
   const answer=observerResponseSchema.safeParse(output.result.interpretation);
   if(output.result.status!=='interpreted'||!answer.success||answer.data.status!=='running'||answer.data.estimate===null||
    !Number.isFinite(output.deliveryAgeMs)||output.deliveryAgeMs<0)
    throw Error('COMPARISON_NO_VALID_ETA');
   // Refreshing the local active clock does not refresh the fixed source text.
   // Do not grant a strategy a freshness advantage by omitting preparation.
   const ageMs=Math.max(record.contextAgeMs,output.deliveryAgeMs);
   const expired=answer.data.estimate.remainingSeconds*1000<=ageMs;
   if(expired&&expiryPolicy==='stop')throw Error('COMPARISON_ETA_EXPIRED');
   const summary=answer.data.summary??'';
   const evidence=comparisonContextEvidence(checkpoint,summary);
   if(!evidence.verified){
    if(contentPolicy==='stop')throw Error('COMPARISON_CONTEXT_UNVERIFIED');
    contextFailures.push({index,strategy,missingMarkerIndices:evidence.missingMarkerIndices,imageMatched:evidence.imageMatched});
   }
   if(expired)expiredSamples.push({index,strategy,remainingSeconds:answer.data.estimate.remainingSeconds,ageMs});
   rows[strategy]=record;
  }
  if(mode==='paired')pairs.push({history:rows.history!,native:rows.native!});
 }
 const invalidIndices=new Set([...expiredSamples,...contextFailures].map(sample=>sample.index));
 const gate=evaluateNativeContextPairs(pairs.filter((_,index)=>!invalidIndices.has(index)));
 const allTiming=evaluateNativeContextPairs(pairs);
 return {pairs,expiredSamples,expiryPolicy,contextFailures,contentPolicy,
  splitGate:evaluateNativeContextSplitPairs(pairs,[...invalidIndices]),
  splitUsageGate:evaluateNativeContextSplitUsagePairs(pairs,[...invalidIndices]),
  timingSummary:{scope:'all collected pairs, including expired or content-invalid samples; descriptive only',pairCount:pairs.length,
   medianPreparationImprovement:allTiming.medianPreparationImprovement,
   medianDeliveryRegression:allTiming.medianFirstValidDeliveryRegression},
  gate:invalidIndices.size?{...gate,passed:false,reasons:[...gate.reasons,...(expiredSamples.length?['expired_eta_samples']:[]),...(contextFailures.length?['unverified_context_samples']:[])]}:gate};
}
