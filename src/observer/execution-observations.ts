import type {ConversationRecord} from './conversation-record.js';
import {createHash} from 'node:crypto';

export interface ExecutionObservation {
  startOrdinal:number;endOrdinal:number;startedAtMs:number;endedAtMs:number;
  elapsedSeconds:number;clock:'wall';overlapsOtherTool:boolean;
  operationKey?:string;
}
export interface ExecutionObservations {
  schemaVersion:1;snapshotAtMs:number;throughOrdinal:number;
  samples:ExecutionObservation[];
  reportedSamples:Array<{endOrdinal:number;reportedSeconds:number;provenance:'native_reported_duration';
    startTimeKnown:false;overlapKnown:false;activeTimeKnown:false}>;
  comparableGroups:Array<{operationKey:string;sampleEndOrdinals:number[];count:number;
    medianSeconds:number;minSeconds:number;maxSeconds:number;minimumSampleCountMet:boolean}>;
  // Heterogeneous tools are evidence, not interchangeable units of work.
  extrapolationAllowed:false;
}

/** Prefix-only facts. Ambiguous starts, waits and unknown turn identities cannot
 * supply a duration. No command classification or inference-time claim. */
export function executionObservations(records:readonly ConversationRecord[],
  currentTurnId:string|null|undefined,nowMs:number):ExecutionObservations|undefined {
  if(!currentTurnId||!Number.isFinite(nowMs)||nowMs<0)return undefined;
  const pending=new Map<string,{ordinal:number;atMs:number}|null>();
  const completed=new Set<string>();
  const starts:number[]=[];
  const samples:ExecutionObservation[]=[];
  const reportedSamples:ExecutionObservations['reportedSamples']=[];
  let throughOrdinal=-1;
  let previousAtMs=-Infinity;
  for(const [ordinal,r] of records.entries()){
    // Do not silently step over future records in a malformed/non-prefix stream.
    if(!Number.isFinite(r.atMs)||r.atMs<0||r.atMs>nowMs||r.atMs<previousAtMs)break;
    previousAtMs=r.atMs;
    throughOrdinal=ordinal;
    if(r.turnId!==currentTurnId){pending.clear();continue;}
    if(r.kind==='runtime'&&r.runtime!=='running'){pending.clear();continue;}
    if(!r.actionId)continue;
    if(r.kind==='tool_start'){
      completed.delete(r.actionId);
      starts.push(r.atMs);
      pending.set(r.actionId,pending.has(r.actionId)?null:{ordinal,atMs:r.atMs});
    }else if(r.kind==='tool_result'){
      // Duplicate completion events must not turn a paired observation into
      // another native-reported sample. A later explicit start permits reuse.
      if(completed.has(r.actionId))continue;
      completed.add(r.actionId);
      const start=pending.get(r.actionId);pending.delete(r.actionId);
      if(start===undefined&&Number.isFinite(r.reportedExecutionSeconds)&&r.reportedExecutionSeconds!>=0&&r.reportedExecutionSeconds!<=31_536_000)
        reportedSamples.push({endOrdinal:ordinal,reportedSeconds:r.reportedExecutionSeconds!,
          provenance:'native_reported_duration',startTimeKnown:false,overlapKnown:false,activeTimeKnown:false});
      if(!start||r.atMs<start.atMs)continue;
      const elapsedSeconds=(r.atMs-start.atMs)/1000;
      if(elapsedSeconds>31_536_000)continue;
      const source=records[start.ordinal]!;
      // Exact operation identity, not a semantic guess from executable names.
      // Unknown cwd/command cannot establish comparable work. Even identical
      // commands may see changed code/cache, so groups remain descriptive only.
      const operation=source.commandArgv??source.command;
      const operationKey=source.toolName&&operation&&source.cwd
        ?createHash('sha256').update(JSON.stringify([source.toolName,source.cwd,operation])).digest('hex'):undefined;
      samples.push({startOrdinal:start.ordinal,endOrdinal:ordinal,startedAtMs:start.atMs,
        endedAtMs:r.atMs,elapsedSeconds,clock:'wall',overlapsOtherTool:pending.size>0,
        ...(operationKey?{operationKey}:{})});
    }
  }
  // Include outstanding starts when identifying parallel work. Durations must
  // never be summed as if overlapping tools were serial work.
  for(const sample of samples){
    sample.overlapsOtherTool=sample.overlapsOtherTool||starts.some(at=>at>sample.startedAtMs&&at<sample.endedAtMs)||samples.some(other=>other!==sample&&
      other.startedAtMs<sample.endedAtMs&&other.endedAtMs>sample.startedAtMs)||
      [...pending.values()].some(other=>other!==null&&other.atMs<sample.endedAtMs);
  }
  const recent=samples.slice(-5),groups=new Map<string,ExecutionObservation[]>();
  for(const sample of recent){
    if(!sample.operationKey||sample.overlapsOtherTool)continue;
    const group=groups.get(sample.operationKey)??[];group.push(sample);groups.set(sample.operationKey,group);
  }
  const comparableGroups=[...groups].map(([operationKey,group])=>{
    const values=group.map(s=>s.elapsedSeconds).sort((a,b)=>a-b),count=values.length;
    return {operationKey,sampleEndOrdinals:group.map(s=>s.endOrdinal),count,
      medianSeconds:(values[Math.floor((count-1)/2)]!+values[Math.floor(count/2)]!)/2,
      minSeconds:values[0]!,maxSeconds:values[count-1]!,minimumSampleCountMet:count>=3};
  });
  return {schemaVersion:1,snapshotAtMs:nowMs,throughOrdinal:Math.max(0,throughOrdinal),
    samples:recent,reportedSamples:reportedSamples.slice(-5),comparableGroups,extrapolationAllowed:false};
}
