import{check,sha}from'./canonical.mjs';
export const GOAL='Complete the supplied public software task, validate locally when possible, and deliver this turn’s final reply.\n\nFixed environment: Dedicated offline Linux benchmark container, public source preloaded, designated command tool, no ETA visible to solver; use the captured initial request for exact paths and constraints.';
export const TIME_BASIS='turn-delivery-wall-minus-confirmed-human-block-v1';
export function initialInput(publicInput){
 check(Array.isArray(publicInput?.input)&&publicInput.input.length===1&&publicInput.input[0].type==='text'&&typeof publicInput.input[0].text==='string','EXACT_INITIAL_REQUEST');
 return{goalSummary:GOAL,timeBasis:TIME_BASIS,activeSeconds:0,runtime:'running',messages:[{kind:'user',scope:'current',truncated:false,text:publicInput.input[0].text}],truncated:false,
 observation:{sequence:1,summaryThroughSequence:1,activeTimeKnown:false,historyComplete:false,currentAction:null,previousEstimate:null,omittedCategories:['assistant','tool','summary']}};
}
export function commonInitial(full,initial,zero,anchorSeconds){
 check(full.activeSeconds===anchorSeconds&&full.observation.historyComplete===true&&full.observation.previousEstimate===null,'NATIVE_INPUT_COMPLETE');
 const out=structuredClone(full),initialMessages=initial.messages.map((m,i)=>({...structuredClone(m),event:{ordinal:i+1,kind:'user',atMs:zero}}));
 for(const m of out.messages){check(m.event&&Number.isFinite(m.event.atMs)&&m.event.atMs<=zero+anchorSeconds*1000,'FUTURE_INPUT_EVENT');if(m.kind!=='user')check(m.event.atMs>=zero,'FOREIGN_TURN_EVENT');}
 // One exact initial request in every arm. Native semantic/timing/progress data
 // are retained; repeated native re-echoes of the same request are not repeated.
 out.messages=[...initialMessages,...out.messages.filter(m=>m.kind!=='user')];
 out.goalSummary=initial.goalSummary;out.observation.sequence=Math.max(out.observation.sequence,out.messages.length);out.observation.summaryThroughSequence=0;
 out.packingLoss={suppliedMessages:out.messages.length,retainedMessages:out.messages.length,droppedByKind:{user:0,assistant:0,tool:0},clippedMessages:0};
 check(!full.truncated&&!(full.packingLoss?.clippedMessages>0)&&!Object.values(full.packingLoss?.droppedByKind??{}).some(v=>v!==0),'SOURCE_CAPACITY_MISSING');return out;
}
export function activityInput(full,initial,zero){
 const cutoff=zero+full.activeSeconds*1000,facts=full.messages.filter(m=>m.kind==='tool').map(m=>{const e=m.event;check(['tool_start','tool_result'].includes(e?.kind)&&e.atMs>=zero&&e.atMs<=cutoff,'ACTIVITY_CAUSAL_EVENT');return{elapsedSeconds:(e.atMs-zero)/1000,phase:e.kind==='tool_start'?'started':'result_arrived',tool:'container_command',pairOrdinal:Number.isSafeInteger(e.pairOrdinal)?e.pairOrdinal:null,counterpartMissing:typeof e.counterpartMissing==='boolean'?e.counterpartMissing:null};});
 const out=structuredClone(initial);out.activeSeconds=full.activeSeconds;
 out.messages.push({kind:'user',scope:'current',truncated:false,text:'Evaluator-provided activity-only projection of records received by this anchor. These are tool lifecycle observations, not task completion claims. Result arrival does not establish success. Arguments, output contents and assistant narration are withheld. A pair reference is only an original observer correlation label and may lack its counterpart.\n'+JSON.stringify(facts)});
 out.observation.sequence=out.messages.length;out.observation.summaryThroughSequence=out.messages.length;return out;
}
export function firstResultAvailability({sourceBytes,library,callId,resultSentAtMs,zero}){
 check(typeof callId==='string'&&Number.isFinite(resultSentAtMs)&&resultSentAtMs>=zero,'FIRST_RESULT_BINDING');
 let offset=0,through=null;for(const line of sourceBytes.toString('utf8').split('\n')){if(!line)continue;offset+=Buffer.byteLength(line+'\n');const row=JSON.parse(line),p=row.payload;
  // The solver's outer exec call id differs from the broker's inner dynamic
  // tool id. Bind only the native DynamicToolCall completion, not nearby output.
  const direct=row.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p?.type)&&p.call_id===callId;
  const dynamic=row.type==='event_msg'&&p?.type==='item_completed'&&p.item?.type==='DynamicToolCall'&&p.item.id===callId;
  if(direct||dynamic){through=offset;break;}}
 if(through===null)return{missing:'matching-first-executed-result-not-in-native-source'};
 const e=library.events.find(e=>e.toByte>=through&&e.atMs>=resultSentAtMs);if(!e)return{missing:'matching-result-prefix-never-observed'};
 return{id:'first-result',atMs:e.atMs,anchorSeconds:(e.atMs-zero)/1000,resultSentAtMs,readerAvailabilityLagMs:e.atMs-resultSentAtMs,sourceThroughByte:e.toByte,sourcePrefixSha256:e.prefixSha256,callId};
}
export function etaOrder(pairIndex,anchor){const first=(pairIndex+(anchor==='p60'?1:0))%2?['activity','full']:['full','activity'];return[...first.map(condition=>({condition,repeat:1})),...first.toReversed().map(condition=>({condition,repeat:2}))];}
export function auditNoSharedHistory(input){check(input.observation.previousEstimate===null&&input.progressState?.previousTurnEstimate==null,'ETA_HISTORY_NOT_EMPTY');check(!Object.hasOwn(input,'truth')&&!Object.hasOwn(input,'treatment')&&!Object.hasOwn(input,'injectedToolDelaySeconds'),'OUTCOME_OR_TREATMENT_LEAK');return{inputSha256:sha(input),activeSeconds:input.activeSeconds,messages:input.messages.length};}
