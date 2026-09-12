import type {Sample} from '../../../src/estimation/residual/contract.js';
export const versions={input:'i1',prompt:'p1',model:'m1',algorithm:'a1'};
export function samples(start=1,count=30):Sample[]{return Array.from({length:count},(_,i)=>({
  identity:{groupId:(start+i).toString(16).padStart(64,'0'),turnId:(start+i+1000).toString(16).padStart(64,'0'),runId:'a'.repeat(32),sourceEpoch:1,generation:1},
  predictionId:1,features:{rawSeconds:60,elapsedActiveSeconds:null,observedActiveSeconds:10,
    oldestActionActiveSeconds:0,outstandingActions:0,completedActions:0,failedActions:0,prefixComplete:true},
  actualSeconds:121,deliveryLagSeconds:5,versions,
}));}
