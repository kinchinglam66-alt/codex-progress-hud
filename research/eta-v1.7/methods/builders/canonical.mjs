import {createHash} from 'node:crypto';
export const sha=b=>createHash('sha256').update(typeof b==='string'||Buffer.isBuffer(b)?b:JSON.stringify(b)).digest('hex');
export const check=(v,m)=>{if(!v)throw Error(m);};
export const lines=b=>b.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
export function parseSource(bytes){let offset=0;return bytes.toString('utf8').split('\n').filter(Boolean).map(line=>{offset+=Buffer.byteLength(line+'\n');return {row:JSON.parse(line),through:offset};});}
export function canonicalLedger({sourceBytes,snapshots,audit,commands,records,zero}){
 const native=parseSource(sourceBytes),seen=new Set(),events=[],mapping=[];
 for(const request of audit.filter(r=>r.type==='server-request'&&r.frame?.method==='item/tool/call')){
  const p=request.frame.params;check(p.tool==='hud_benchmark_container','UNKNOWN_COMMAND_TOOL');
  check(!seen.has(p.callId),'DUPLICATE_REAL_CALL_ID');seen.add(p.callId);
  const cmd=commands.filter(c=>c.callId===p.callId),proof=records.filter(c=>c.callId===p.callId);
  check(proof.length===1,'UNIQUE_BROKER_PROOF');const executed=proof[0].executionStarted===true;
  if(executed)check(cmd.length===1&&cmd[0].command===p.arguments.command&&sha(cmd[0].command)===proof[0].commandSha256,'COMMAND_BINDING');
  else check(cmd.length===0&&proof[0].executionStarted===false&&sha(p.arguments)===proof[0].argumentsSha256,'REJECTED_ARGUMENT_BINDING');
  check(request.atMs>=zero&&(!executed||request.atMs<=cmd[0].atMs),'START_CLOCK');
  const id=events.filter(e=>e.phase==='started').length+1;
  events.push({id,phase:'started',atMs:request.atMs,tool:'container_command',command:p.arguments.command,arguments:p.arguments});
  const result=audit.filter(r=>r.type==='server-result'&&r.requestId===request.frame.id);
  const candidates=native.filter(e=>e.row.payload?.type==='item_completed'&&e.row.payload?.item?.type==='DynamicToolCall'&&e.row.payload.item.id===p.callId);
  check(result.length===1&&candidates.length===1,'UNIQUE_COMPLETED_COMMAND');
  const n=candidates[0],item=n.row.payload.item;
  check(sha(item.arguments)===sha(p.arguments)&&sha(item.content_items)===sha(result[0].result.contentItems),'NATIVE_RPC_RESULT_BINDING');
  const visible=snapshots.find(s=>Math.max(s.atMs,s.source?.atMs??s.atMs)>=result[0].atMs&&s.source?.ready&&s.source?.etaReady&&s.source.completeBytes>=n.through);
  check(visible&&visible.source.completeBytes<=sourceBytes.length,'RESULT_READ_AVAILABILITY');
  check(sha(sourceBytes.subarray(0,visible.source.completeBytes))===visible.source.sourceSha256,'SNAPSHOT_PREFIX_HASH');
  check(item.content_items.length===1&&item.content_items[0].type==='inputText','TEXT_COMMAND_RESULT');
  const out=JSON.parse(item.content_items[0].text);
  if(executed)check(typeof out.stdout==='string'&&typeof out.stderr==='string'&&Number.isInteger(out.exitCode)&&out.executionStarted===true,'COMMAND_OUTPUT_SCHEMA');
  else check(out.executionStarted===false&&out.kind==='argument-error','EXPLICIT_UNEXECUTED_RESULT');
  const visibleAtMs=Math.max(visible.atMs,visible.source.atMs??visible.atMs);
  const value=executed?{stdout:out.stdout,stderr:out.stderr,exitCode:out.exitCode,outputComplete:out.outputComplete??null}:{executionStarted:false,errorCode:out.errorCode,message:out.message,outputComplete:out.outputComplete??null};
  events.push({id,phase:'result_arrived',atMs:visibleAtMs,tool:'container_command',result:value});
  mapping.push({id,callId:p.callId,requestSequence:request.sequence,resultSequence:result[0].sequence,nativeOrdinal:n.row.ordinal,nativeThroughByte:n.through,resultSentAtMs:result[0].atMs,visibleAtMs,prefixBytes:visible.source.completeBytes,prefixSha256:visible.source.sourceSha256,executionStarted:proof[0].executionStarted,historicalOutputTruncated:proof[0].outputTruncated??false});
 }
 check(events.length===seen.size*2&&mapping.filter(m=>m.executionStarted).length===commands.length,'CANONICAL_COVERAGE');
 return {events:events.toSorted((a,b)=>a.atMs-b.atMs||(a.phase==='started'?-1:1)),mapping};
}
export function buildPair({initial,goal,timeBasis,ledger,zero,seconds}){
 check(typeof initial==='string'&&seconds>=0,'PAIR_SCOPE');
 const visible=ledger.events.filter(e=>e.atMs<=zero+seconds*1000);
 const activity=visible.map(e=>({id:e.id,phase:e.phase,elapsedSeconds:(e.atMs-zero)/1000,tool:e.tool}));
 const executionContent=visible.map(e=>({id:e.id,phase:e.phase,...(e.phase==='started'?{command:e.command,arguments:e.arguments}:{result:e.result})}));
 const make=content=>({goalSummary:goal,timeBasis,activeSeconds:seconds,runtime:'running',messages:[{kind:'user',scope:'current',truncated:false,text:initial},{kind:'user',scope:'current',truncated:false,text:'Observed tool-call records through the current clock cutoff. Starts identify received container-command requests; a request can be rejected before execution. Result arrival alone does not establish successful task completion. executionContent contains any supplied command arguments and returned output for those same event identities.\n'+JSON.stringify({activity,executionContent:content})}],truncated:false,observation:{sequence:2,summaryThroughSequence:2,activeTimeKnown:false,historyComplete:false,currentAction:null,previousEstimate:null,omittedCategories:['assistant','tool','summary']}});
 const a=make([]),f=make(executionContent);check(JSON.stringify({...a,messages:a.messages.slice(0,1)})===JSON.stringify({...f,messages:f.messages.slice(0,1)}),'COMMON_INPUT');
 return {activity:a,full:f,audit:{events:activity.length,commands:activity.filter(e=>e.phase==='started').length,results:activity.filter(e=>e.phase==='result_arrived').length,latestAtMs:visible.at(-1)?.atMs??null,cutoffMs:zero+seconds*1000,duplicateIdentities:activity.length-new Set(activity.map(e=>e.id+'/'+e.phase)).size}};
}
