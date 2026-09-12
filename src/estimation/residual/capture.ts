import type {HistorySnapshot} from '../../observer/history-snapshot.js';
import type {Features} from './contract.js';
import {createPrefixFingerprint,researchTurnId} from './fingerprint.js';
export type ActionFeatures=Pick<Features,'outstandingActions'|'completedActions'|'failedActions'|'oldestActionActiveSeconds'|'prefixComplete'>;
/** Piggybacks on planner iteration. Partial replays preserve a completed fixed snapshot. */
export function captureHistoryFeatures(source:HistorySnapshot,turnId:string){
  let result:ActionFeatures|null=null,fingerprint:string|null=null;
  let reason:'incomplete_scan'|'unknown_attribution'|'action_overflow'|'snapshot_changed'|null='incomplete_scan';
  let invalid=false;
  const snapshot:HistorySnapshot={...source,async *records(signal){
    let completedActions=0,failedActions=0,overflow=false,unknown=false;
    const actions=new Set<string>(),hash=createPrefixFingerprint();
    for await(const item of source.records(signal)){
      const r=item.record;
      const explicitTurn=researchTurnId(r);
      // An unowned tool may belong to this turn: never silently count it as zero.
      if(explicitTurn===null&&(r.kind==='tool_start'||r.kind==='tool_result'))unknown=true;
      if(explicitTurn===turnId){
        hash.add(r);
        if(r.kind==='tool_start'&&r.actionId){if(actions.size>=4096)overflow=true;else actions.add(r.actionId);}
        if(r.kind==='tool_result'){
          if(r.actionId)actions.delete(r.actionId);
          if(r.complete!==false){completedActions++;if(typeof r.exitCode==='number'&&r.exitCode!==0)failedActions++;}
        }
      }
      yield item;
    }
    const nextFingerprint=hash.finish();
    if(unknown||overflow||fingerprint!==null&&fingerprint!==nextFingerprint){
      reason=unknown?'unknown_attribution':overflow?'action_overflow':'snapshot_changed';invalid=true;result=null;fingerprint=null;
    }else if(!invalid){reason=null;fingerprint=nextFingerprint;result=Object.freeze({outstandingActions:actions.size,completedActions,failedActions,
      // Source wall-time alone cannot prove age excluding manual pauses.
      oldestActionActiveSeconds:actions.size===0?0:null,prefixComplete:source.coverage.complete});}
  }};
  return {snapshot,result:()=>result,fingerprint:()=>fingerprint,reason:()=>reason};
}
