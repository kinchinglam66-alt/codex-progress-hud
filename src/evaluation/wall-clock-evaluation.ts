import {z} from 'zod';
import {NativeEtaClock} from '../core/eta-native-clock.js';
import {ETA_TIME_BASIS} from '../core/eta-time-basis.js';
import {scoreWallClockPrediction} from './wall-clock-score.js';

const schema=z.object({
  basis:z.literal(ETA_TIME_BASIS),threadId:z.string().min(1),turnId:z.string().min(1),
  controller:z.literal('independent_native_controller'),
  controllerEvidenceRef:z.string().min(1),
  approvalFeedComplete:z.boolean(),
  auditStatus:z.enum(['compliant_observed','violation','unreviewable']),
  // These are independently collected native/controller events and actual
  // render-delivery samples, never timestamps inferred from HUD goal status.
  events:z.array(z.unknown()).min(1),predictions:z.array(z.unknown()),
  taskTokens:z.number().int().nonnegative().nullable(),
  etaTokens:z.array(z.number().int().nonnegative().nullable()),
}).strict();

/** Offline entry for independently attested controller bundles. Evidence refs
 * are provenance, not a replacement for controller review/source verification.
 * Unknown / malformed / interrupted samples remain visible in the report. */
export function evaluateWallClockTask(raw:unknown){
  const data=schema.parse(raw);
  const clock=new NativeEtaClock(data,data.events[0]);
  for(const event of data.events.slice(1))clock.accept(event);
  const native=clock.snapshot();
  const seen=new Map<string,string>();
  const rows:Array<{index:number;primaryEligible:boolean;reason:string|null;result:ReturnType<typeof scoreWallClockPrediction>|null}>=data.predictions.map((p,index)=>{
    const id=p&&typeof p==='object'?(p as {predictionId?:unknown}).predictionId:undefined;
    let reason:string|undefined;
    if(typeof id==='string'){
      const serialized=JSON.stringify(p),previous=seen.get(id);
      if(previous!==undefined)reason=previous===serialized?'duplicate_prediction':'conflicting_prediction';
      else seen.set(id,serialized);
    }
    if(reason)return {index,primaryEligible:false,reason,result:null};
    try{
      const result=scoreWallClockPrediction(native.timeline,p);
      return {index,primaryEligible:result.primaryEligible&&data.auditStatus==='compliant_observed',
        reason:data.auditStatus==='compliant_observed'?null:data.auditStatus,result};
    }catch{return {index,primaryEligible:false,reason:'prediction_protocol_failure',result:null};}
  });
  // A conflicting duplicate corrupts the identity of BOTH rows, not just the latter.
  const conflicts=new Set(rows.filter(r=>r.reason==='conflicting_prediction').map(r=>
    (data.predictions[r.index] as {predictionId:string}).predictionId));
  for(const row of rows){
    if(row.result&&conflicts.has(row.result.predictionId)){
      row.primaryEligible=false;row.reason='conflicting_prediction';
    }
  }
  const eligible=rows.filter(r=>r.primaryEligible);
  const uniqueRows=rows.filter(r=>r.reason!=='duplicate_prediction');
  const numeric=uniqueRows.filter(r=>r.result!==null&&r.reason!=='conflicting_prediction'&&!r.result.reasons.includes('no_numeric_prediction')&&
    !r.result.reasons.includes('binding_mismatch'));
  const errors=eligible.map(r=>r.result!.delivery!.absoluteErrorSeconds);
  const relative=eligible.flatMap(r=>r.result!.delivery!.relativeError===null?[]:[r.result!.delivery!.relativeError!]);
  const knownEtaTokens=data.etaTokens.reduce<number>((sum,n)=>sum+(n??0),0);
  const etaTokens=data.etaTokens.some(n=>n===null)?null:knownEtaTokens;
  return {basis:ETA_TIME_BASIS,threadId:data.threadId,turnId:data.turnId,
    labelSource:data.controller,controllerEvidenceRef:data.controllerEvidenceRef,
    outcome:native.timeline.outcome,clockProblems:native.problems,
    auditStatus:data.auditStatus,rows,primaryPredictions:eligible.length,
    meanAbsoluteErrorSeconds:errors.length?errors.reduce((s,n)=>s+n,0)/errors.length:null,
    meanRelativeError:relative.length?relative.reduce((s,n)=>s+n,0)/relative.length:null,
    duplicateRecords:rows.length-uniqueRows.length,
    numericCoverage:uniqueRows.length?numeric.length/uniqueRows.length:null,
    primaryScorableCoverage:uniqueRows.length?eligible.length/uniqueRows.length:null,
    taskTokens:data.taskTokens,etaTokens,knownEtaTokens,
    unknownEtaUsageCount:data.etaTokens.filter(n=>n===null).length,
    tokenRatio:etaTokens!==null&&data.taskTokens!==null&&data.taskTokens>0?etaTokens/data.taskTokens:null};
}

/** One mean per task, then one mean across tasks; never pool all calls. */
export function summarizeWallClockTasks(tasks:ReturnType<typeof evaluateWallClockTask>[]){
  const bindings=new Set<string>();
  for(const task of tasks){const key=JSON.stringify([task.threadId,task.turnId]);
    if(bindings.has(key))throw Error('duplicate_task_binding');bindings.add(key);}
  const mean=(values:Array<number|null>)=>{const ns=values.filter((n):n is number=>n!==null);
    return ns.length?ns.reduce((s,n)=>s+n,0)/ns.length:null;};
  return {basis:ETA_TIME_BASIS,tasks:tasks.length,
    completedTasks:tasks.filter(t=>t.outcome==='completed').length,
    interruptedTasks:tasks.filter(t=>t.outcome==='interrupted'||t.outcome==='failed').length,
    primaryScorableTasks:tasks.filter(t=>t.primaryPredictions>0).length,
    taskEqualMeanAbsoluteErrorSeconds:mean(tasks.map(t=>t.meanAbsoluteErrorSeconds)),
    taskEqualMeanRelativeError:mean(tasks.map(t=>t.meanRelativeError))};
}
