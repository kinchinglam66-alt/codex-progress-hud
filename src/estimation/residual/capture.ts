import type {HistorySnapshot} from '../../observer/history-snapshot.js';
import type {Features} from './contract.js';
import {createPrefixFingerprint} from './fingerprint.js';
export type ActionFeatures=Pick<Features,'outstandingActions'|'completedActions'|'failedActions'|'oldestActionActiveSeconds'|'prefixComplete'>;
/** Piggybacks on planner iteration. Replays rebuild counters; no extra history reads. */
export function captureHistoryFeatures(source:HistorySnapshot,turnId:string){
  let result:ActionFeatures|null=null,fingerprint:string|null=null;
  const snapshot:HistorySnapshot={...source,async *records(signal){
    let completedActions=0,failedActions=0,overflow=false;
    const actions=new Set<string>(),hash=createPrefixFingerprint();result=null;fingerprint=null;
    for await(const item of source.records(signal)){
      const r=item.record;
      if(r.turnId===turnId){
        hash.add(r);
        if(r.kind==='tool_start'&&r.actionId){if(actions.size>=4096)overflow=true;else actions.add(r.actionId);}
        if(r.kind==='tool_result'){
          if(r.actionId)actions.delete(r.actionId);
          if(r.complete!==false){completedActions++;if(typeof r.exitCode==='number'&&r.exitCode!==0)failedActions++;}
        }
      }
      yield item;
    }
    if(!overflow){fingerprint=hash.finish();result=Object.freeze({outstandingActions:actions.size,completedActions,failedActions,
      // Source wall-time alone cannot prove age excluding manual pauses.
      oldestActionActiveSeconds:actions.size===0?0:null,prefixComplete:source.coverage.complete});}
  }};
  return {snapshot,result:()=>result,fingerprint:()=>fingerprint};
}
