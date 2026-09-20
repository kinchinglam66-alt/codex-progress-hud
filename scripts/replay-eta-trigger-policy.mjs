import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ordinaryRequestIntervalSeconds} from '../dist/estimation/long-task-policy.js';

// Read-only comparison at recorded request anchors. No synthetic model predictions,
// interpolation, live scheduling, network, or claims of counterfactual accuracy.
const path=process.argv[2];if(!path)throw Error('Usage: node scripts/replay-eta-trigger-policy.mjs <private-pilot.jsonl>');
const bytes=await readFile(path),rows=[];let malformed=0;
for(const line of bytes.toString('utf8').split(/\r?\n/u)){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{malformed++;}}
const oldInterval=(remaining,unknown)=>remaining===null?(unknown<=1?300:unknown===2?600:1800):remaining<=1800?300:remaining<=7200?600:remaining<=28800?900:1800;
const states=new Map(),comparisons=[];
for(const row of rows){
 if(!row.key||!Number.isFinite(row.activeSeconds))continue;
 const key=JSON.stringify([row.key,row.generation]),state=states.get(key)??{prediction:null,unknown:0};states.set(key,state);
 if(row.kind==='result'&&row.accepted===true){
  if(row.estimate&&Number.isFinite(row.observedActiveSeconds))state.prediction={...row.estimate,anchor:row.observedActiveSeconds};
  if(row.estimate)state.unknown=0;else state.unknown++;
 }
 if(row.kind!=='request')continue;
 const p=state.prediction,remaining=p?Math.max(0,p.remainingSeconds-Math.max(0,row.activeSeconds-p.anchor)):null;
 comparisons.push({requestId:row.requestId,oldIntervalSeconds:oldInterval(remaining,state.unknown),
   newIntervalSeconds:ordinaryRequestIntervalSeconds(remaining,state.unknown),
   activeTimeKnown:row.activeTimeKnown===true});
}
console.log(JSON.stringify({sourceSha256:createHash('sha256').update(bytes).digest('hex'),records:rows.length,malformed,
 recordedRequests:comparisons.length,acceptedResults:rows.filter(r=>r.kind==='result'&&r.accepted===true).length,
 journalGaps:rows.filter(r=>r.kind==='journal_gap').length,unknownUsageResults:rows.filter(r=>r.kind==='result'&&r.usage===null).length,
 comparisons,limits:['request-anchor policy comparison only','not a 1Hz coverage reconstruction','no counterfactual ETA, call count or token estimate','milestones absent in legacy logs; turn ETA only']},null,2));
