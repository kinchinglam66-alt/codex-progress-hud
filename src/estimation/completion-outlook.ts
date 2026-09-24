import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {ConversationRecord} from '../observer/conversation-record.js';
import type {ObserverInput,ObserverResponse} from './observer-contract.js';
import {assessEstimateCondition} from './estimate-conditions.js';
const ref=z.string().regex(/^te_[a-f0-9]{32}$/);
export const turnEvidenceSchema=z.object({schemaVersion:z.literal(1),waitingForAuthorization:z.boolean().nullable(),
  facts:z.array(z.object({ref,ordinal:z.number().int().nonnegative(),atMs:z.number().int().nonnegative(),
    kind:z.enum(['tool_started','tool_ended','tool_failed','tool_in_progress','continued_after_failure','final_reply','runtime_running','runtime_waiting','runtime_interrupted','runtime_failed','runtime_completed'])}).strict()).max(32)}).strict();
export const completionOutlookSchema=z.object({path:z.enum(['deliver_result','report_blocker','uncertain']),
  reason:z.string().trim().min(1).max(512),evidenceRefs:z.array(ref).max(8)}).strict();
export const completionOutlookInstructions=`Return completionOutlook in the SAME estimate response: path deliver_result, report_blocker, or uncertain, a brief factual reason (not chain of thought), and evidenceRefs from turnEvidence.facts. Predict the CURRENT TURN end, not project completion or guaranteed code correctness. A failed tool alone is not evidence that the agent will immediately report a blocker and stop; inspect subsequent work, running tools and explicit waiting. Do not assume either successful repair or abandonment. Missing authorization-wait evidence is unknown, not false. Cite only supplied references; if the ending route is ambiguous choose uncertain. Numeric ETA may accompany uncertainty; estimate may be null if no defensible duration exists. Do not impose a minimum duration or multiply ETA to disguise uncertainty. Neither this outlook nor reaching zero establishes native completion, pause or interruption.`;
export function collectTurnEvidence(records:readonly ConversationRecord[],turnId:string|null|undefined,nowMs:number):z.infer<typeof turnEvidenceSchema>|undefined {
  if(!turnId)return;
  const facts:z.infer<typeof turnEvidenceSchema>['facts']=[];
  const active=new Map<string,{ordinal:number;atMs:number}>();let failed=false;
  const add=(kind:(typeof facts)[number]['kind'],ordinal:number,atMs:number)=>{
    facts.push({kind,ordinal,atMs,ref:'te_'+createHash('sha256').update(JSON.stringify([turnId,ordinal,atMs,kind])).digest('hex').slice(0,32)});
  };
  for(const [ordinal,r] of records.entries()){
    if(!Number.isSafeInteger(r.atMs)||r.atMs<0||r.atMs>nowMs)break;
    if((r.sourceTurnId??r.turnId)!==turnId)continue;
    if(r.kind==='tool_start'){
      add('tool_started',ordinal,r.atMs);if(failed){add('continued_after_failure',ordinal,r.atMs);failed=false;}
      if(r.actionId)active.set(r.actionId,{ordinal,atMs:r.atMs});
    }
    if(r.kind==='tool_result'){
      if(r.actionId)active.delete(r.actionId);add('tool_ended',ordinal,r.atMs);
      if(typeof r.exitCode==='number'&&r.exitCode!==0){failed=true;add('tool_failed',ordinal,r.atMs);}
    }
    if(r.kind==='assistant'&&r.assistantPhase==='final')add('final_reply',ordinal,r.atMs);
    if(r.kind==='runtime'){
      if(r.outcome==='completed')add('runtime_completed',ordinal,r.atMs);
      else if(r.runtime)add(`runtime_${r.runtime}`,ordinal,r.atMs);
      if(r.runtime!=='running')active.clear();
    }
  }
  for(const operation of active.values())add('tool_in_progress',operation.ordinal,operation.atMs);
  // Current native records do not distinguish approval waits from general
  // quiescence. Never infer that distinction from tool names or source prose.
  return {schemaVersion:1,waitingForAuthorization:null,facts:facts.slice(-32)};
}
export function validateCompletionOutlook(response:ObserverResponse,input:ObserverInput):ObserverResponse {
  const outlook=response.completionOutlook;if(!outlook)return response;
  const facts=new Map(input.turnEvidence?.facts.map(f=>[f.ref,f])??[]);
  const selected=outlook.evidenceRefs.map(r=>facts.get(r));
  const invalid=selected.some(f=>!f)||outlook.path!=='uncertain'&&selected.length===0;
  const failureOnly=outlook.path==='report_blocker'&&selected.every(f=>f?.kind==='tool_failed'||f?.kind==='tool_ended');
  if(invalid||failureOnly||response.basis==='insufficient_context')return {...response,completionOutlook:{path:'uncertain',reason:'Available evidence does not establish the proposed ending route.',evidenceRefs:outlook.evidenceRefs.filter(r=>facts.has(r))}};
  return response;
}
export function estimateUncertain(response:ObserverResponse):boolean {
  const condition=assessEstimateCondition(response);
  return response.basis==='insufficient_context'||response.completionOutlook?.path==='uncertain'||(condition!==undefined&&condition.issue!=='consistent');
}
