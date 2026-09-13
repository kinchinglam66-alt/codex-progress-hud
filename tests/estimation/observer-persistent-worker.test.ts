import {expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Script} from 'node:vm';
import {createPersistentObserverWorker,type PersistentHistoryBudget} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createPersistentReceiptJournal,preparationErrorCode} from '../../src/estimation/observer-persistent-receipt.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import {parseCodexCheckpoint} from '../../src/observer/codex-checkpoint.js';
import {persistentHistoryPolicy} from '../../src/estimation/persistent-history-policy.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
const input:ObserverInput={goalSummary:'current',runtime:'running',activeSeconds:10,messages:[{kind:'user',text:'current',truncated:false}],truncated:false};
const controlledBudget=(batch=1024,reserve=32):PersistentHistoryBudget=>({trusted:true,maxSourceBytes:256*1024,maxCompactionOperations:4,contextCapacityBytes:batch+reserve,retainedSummaryReserveBytes:reserve});
const script=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){const id='r'+(++n);emit({id:m.id,result:{turn:{id}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{inputTokens:100*n,outputTokens:10*n,totalTokens:110*n,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const timeoutScript=`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'r1'}}});emit({method:'item/completed',params:{threadId:'t',turnId:'r1',item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const compactionScript=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='thread/compact/start'){const id='c'+(++n);emit({id:m.id,result:{}});emit({method:'item/started',params:{threadId:'t',turnId:id,item:{type:'contextCompaction',id:'ci'}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'contextCompaction',id:'ci'}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else if(m.method==='turn/start'){const id='r'+(++n);emit({id:m.id,result:{turn:{id}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{inputTokens:100*n,outputTokens:10*n,totalTokens:110*n,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const failedCompactionScript=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='thread/compact/start'){const id='c'+(++n);emit({id:m.id,result:{}});emit({method:'item/started',params:{threadId:'t',turnId:id,item:{type:'contextCompaction',id:'ci'}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'failed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
async function fixture(failSettlement=false,options:{script?:string;sessionTimeoutMs?:number;receiptFailure?:boolean;compactionReceiptFailure?:boolean;compactionCloseFailure?:boolean;abortOnUpdate?:()=>void;bootstrapBatchByteCapacity?:number;retainedSummaryByteReserve?:number;historyBudget?:PersistentHistoryBudget}={}){
 new Script(script);
 const dir=await mkdtemp(join(tmpdir(),'hud-persistent-worker-'));await mkdir(join(dir,'ledger'));
 const accounting=await openReleaseAccounting(join(dir,'ledger'),Date.now);let processes=0,preparations=0,authorized=true,settlementAttempts=0;const notifications:unknown[]=[];const imports:unknown[]=[];let lastProcess:ReturnType<typeof createObserverSessionProcess>|undefined;
 if(failSettlement){const original=accounting.forConversation.bind(accounting);accounting.forConversation=key=>{const v=original(key);return {...v,settle:async()=>{settlementAttempts++;throw Error('simulated storage failure');}};};}
 if(options.abortOnUpdate){const original=accounting.forConversation.bind(accounting);accounting.forConversation=key=>{const v=original(key);const update=v.updateInvocation as ((...args:any[])=>Promise<unknown>)|undefined;return {...v,updateInvocation:async(...args:any[])=>{options.abortOnUpdate?.();return update?.(...args);}} as any;};}
 const baseJournal=createPersistentReceiptJournal(join(dir,'receipts'));
 const receiptJournalFactory=options.receiptFailure?()=>({...baseJournal,usageSnapshot:async()=>{throw Error('private journal detail');}}):options.compactionReceiptFailure?()=>({...baseJournal,operationTerminal:async()=>{throw Error('private journal detail');}}):undefined;
 const worker=createPersistentObserverWorker({...({accounting,authorize:()=>authorized,now:Date.now,outputSchema:{type:'object'},receiptDirectory:join(dir,'receipts'),sessionTimeoutMs:options.sessionTimeoutMs,bootstrapBatchByteCapacity:options.bootstrapBatchByteCapacity,retainedSummaryByteReserve:options.retainedSummaryByteReserve,historyBudget:options.historyBudget,receiptJournalFactory,
   prepareSession:async()=>{preparations++;return {invocation:{executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',options.script??script],input:''},binding:{accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)}};},
   processFactory:()=>{processes++;const p=createObserverSessionProcess({captureIdentity:async()=> '123'});lastProcess=p;const start=p.start;const close=p.close;return {...p,start:async(i:any)=>{const r=await start(i);r.rpc.subscribe(n=>notifications.push(n));const call=r.rpc.call;r.rpc.call=(m,p)=>{if(m==='thread/inject_items')imports.push(p);return call(m,p);};return r;},close:async()=>{if(options.compactionCloseFailure&&preparations>1)throw Error('simulated close failure');return close();}};}} as any)});
 return {accounting,worker,notifications,imports,settlementAttempts:()=>settlementAttempts,preparations:()=>preparations,processes:()=>processes,lastProcess:()=>lastProcess,receipts:join(dir,'receipts'),revoke:()=>{authorized=false;}};
}
function history(records:ConversationRecord[],epoch=0):HistorySnapshot{
 return {identity:'local-only-source-identity',sourceEpoch:epoch,revision:records.length,coverage:{complete:true,gaps:[]},
   async *records(){for(const [ordinal,record]of records.entries())yield {ordinal,record};},close:async()=>{}};
}
it('records a bounded preparation stage without leaking a source exception or admitting a model call',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const snapshot=history([]);
 snapshot.records=async function*(){throw Error('private source content and credentials');};
 try{
   await expect(f.worker.prepareContext!(input,{snapshot,currentTurnId:'t'},signal,'source',0,0)).rejects.toThrow('private source');
   const raw=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
   const records=raw.trim().split('\n').map(line=>JSON.parse(line));
   expect(records.find(row=>row.kind==='preparation_failure')).toMatchObject({stage:'history_import',code:'PREPARATION_UNKNOWN',generation:0});
   expect(raw).not.toContain('private source');
   expect(records.some(row=>row.kind==='operation')).toBe(false);
   expect(records.at(-1)).toMatchObject({kind:'process_exit',processExitState:'closed'});
 }finally{await f.worker.close();await f.accounting.close();}
});
it('keeps checkpoint rejection separate from history and compression failures',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'private summary'}]}})!;
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:{...history([]),checkpoint:{...checkpoint,fingerprint:'wrong'}},currentTurnId:'t'},signal,'source',0,0)).rejects.toThrow('CHECKPOINT_INVALID');
   const raw=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
   const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
   expect(rows.find(row=>row.kind==='preparation_failure')).toMatchObject({stage:'checkpoint_import',code:'CHECKPOINT_INVALID'});
   expect(raw).not.toContain('private summary');
   expect(rows.some(row=>row.kind==='operation')).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([
 ['APP_SERVER_RPC_ERROR','APP_SERVER_RPC_ERROR'],
 ['APP_SERVER_RPC_ERROR private payload','PREPARATION_UNKNOWN'],
 ['context_too_large:private payload','context_too_large'],
 ['private credentials','PREPARATION_UNKNOWN'],
])('records only allowlisted preparation errors: %s',(message,expected)=>{
 expect(preparationErrorCode(Error(message))).toBe(expected);
});
it('continues to a forecast after several confirmed native compressions with unknown usage',async()=>{
 const policy=persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:null,source:'configured'});
 const f=await fixture(false,{script:compactionScript,...policy}),signal=new AbortController().signal;
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'long-tail',turnId:'t',kind:'user',atMs:1,text:'retained history '.repeat(40000)}]),currentTurnId:'t'},signal,'source',0,0);
   expect(prepared.representation.confirmedCompactions).toBeGreaterThanOrEqual(4);
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
   expect(f.accounting.snapshot().unknown).toBeGreaterThanOrEqual(4);
   expect(f.accounting.snapshot().unresolved).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('bootstraps the native source window once before incremental tail and reports its provenance',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[
   {type:'message',role:'user',content:[{type:'input_text',text:'inherited source facts'}]},
   {type:'compaction',encrypted_content:'opaque-test-summary'}
 ]}})!;
 const tail:ConversationRecord={id:'tail',turnId:'t',kind:'user',atMs:1,text:'continue'};
 try{
   const first=await f.worker.prepareContext!(input,{snapshot:{...history([tail]),checkpoint},currentTurnId:'t'},signal,'source',0,0);
   expect((f.imports[0] as any).items).toEqual(checkpoint.items);
   expect(first.representation).toMatchObject({sourceRepresentation:'upstream_compacted',checkpointBootstrapped:true,checkpointItemCount:2,checkpointEncodedBytes:checkpoint.encodedBytes});
   expect((await f.worker.observe(first.input,signal,'source',0)).status).toBe('interpreted');
   await f.worker.prepareContext!(input,{snapshot:{...history([tail]),checkpoint},currentTurnId:'t'},signal,'source',1,0);
   expect(f.imports).toHaveLength(3); // Canonical window, trusted policy, one tail record.
   expect(f.processes()).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('rebuilds the owner when a newer checkpoint replaces the source window',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const checkpoint=(summary:string)=>parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:summary}]}})!;
 const tail:ConversationRecord={id:'tail',turnId:'t',kind:'user',atMs:1,text:'continue'};
 try{
   await f.worker.prepareContext!(input,{snapshot:{...history([tail]),checkpoint:checkpoint('first')},currentTurnId:'t'},signal,'source',0,0);
   await f.worker.prepareContext!(input,{snapshot:{...history([tail]),checkpoint:checkpoint('second')},currentTurnId:'t'},signal,'source',1,0);
   expect(f.processes()).toBe(2);
   expect(f.imports).toHaveLength(6);
   expect((f.imports[3] as any).items).toEqual(checkpoint('second').items);
   const receipts=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
   expect(receipts).not.toContain('encrypted_content');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('keeps current observation coverage consistent with the source snapshot',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const current:ObserverInput={...input,observation:{sequence:0,summaryThroughSequence:0,activeTimeKnown:true,historyComplete:true,currentAction:null,previousEstimate:null,omittedCategories:[]}};
 try{
   const snapshot=history([]);snapshot.coverage={complete:false,gaps:['unsupported_payload']};
   const prepared=await f.worker.prepareContext!(current,{snapshot,currentTurnId:'t'},signal,'source',0,0);
   expect(prepared.input.observation?.historyComplete).toBe(false);
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('imports identical tool text and output once without losing distinct content or mutating source',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const records:ConversationRecord[]=[
   {id:'a',turnId:'t',kind:'tool_result',atMs:1,text:'same result',output:'same result',outputComplete:false},
   {id:'b',turnId:'t',kind:'tool_result',atMs:2,text:'summary',output:'full result',outputComplete:true},
   {id:'c',turnId:'t',kind:'tool_result',atMs:3,output:'output only',outputComplete:true}
 ];
 try{
   await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'t'},signal,'source',0,0);
   const decoded=f.imports.map(raw=>{
     const p=raw as {items:{content:{text:string}[]}[]};
     return JSON.parse(JSON.parse(p.items[0]!.content[0]!.text).observedRecord.text);
   });
   expect(decoded[0]).toMatchObject({text:'same result',outputComplete:false});
   expect(decoded[0]).not.toHaveProperty('output');
   expect(decoded[1]).toMatchObject({text:'summary',output:'full result',outputComplete:true});
   expect(decoded[2]).toMatchObject({output:'output only',outputComplete:true});
   expect(records[0]!.output).toBe('same result');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('imports existing history once, then only new records across source turns',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const a:ConversationRecord={id:'local-id-a',turnId:'private-turn-a',kind:'user',atMs:1,text:'Original duration 100'};
 const b:ConversationRecord={id:'local-id-b',turnId:'private-turn-b',kind:'user',atMs:2,text:'Repeat the duration'};
 try{
   await f.worker.prepareContext!(input,{snapshot:history([a]),currentTurnId:a.turnId!},signal,'source',1,10);
   await f.worker.observe(input,signal,'source',1);await f.worker.release!();
   await f.worker.prepareContext!(input,{snapshot:history([a,b]),currentTurnId:b.turnId!},signal,'source',2,20);
   await f.worker.observe(input,signal,'source',2);
   expect(f.imports).toHaveLength(2);expect(f.processes()).toBe(1);
   expect(JSON.stringify(f.imports)).not.toContain('private-turn');expect(JSON.stringify(f.imports)).not.toContain('local-only-source');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('accepts the prepared current request while retaining separate session history coverage',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const a:ConversationRecord={id:'local-id-a',turnId:'private-turn-a',kind:'user',atMs:1,text:'Original duration 100'};
 const b:ConversationRecord={id:'local-id-b',turnId:'private-turn-b',kind:'assistant',atMs:2,text:'A prior response'};
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([a,b]),currentTurnId:a.turnId!},signal,'source',1,10);
   expect(prepared.input.messages).toHaveLength(1);
   expect(prepared.representation.originalRecords).toBe(1);
   expect(prepared.representation.sessionCoveredRecords).toBe(2);
   const result=await f.worker.observe(prepared.input,signal,'source',1);
   expect(result.status).toBe('interpreted');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('fails closed before compact dispatch when no finite history budget is trusted',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:128});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(100)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow('capacity_unknown');
   expect(f.notifications.some((value:any)=>value.method==='item/started'&&value.params?.item?.type==='contextCompaction')).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('reports policy-assumed import and confirmed compaction coverage',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget()});
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0);
   expect(prepared.representation).toMatchObject({compressionState:'confirmed',confirmedCompactions:1,residentBound:'policy_assumed',budgetStatus:'trusted',retainedSummaryReserveBytes:32,contextCapacityBytes:1056});
   expect(prepared.representation.importedEncodedBytes).toBeGreaterThan(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('stops a trusted replay at its finite compaction budget',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:{...controlledBudget(),maxCompactionOperations:2}});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(5000)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow('context_too_large:compaction_budget_exhausted');
   expect(f.notifications.filter((value:any)=>value.method==='item/started'&&value.params?.item?.type==='contextCompaction')).toHaveLength(2);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('stops before dispatch when the trusted encoded source-byte budget is exhausted',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:{...controlledBudget(),maxSourceBytes:1000}});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow('context_too_large:source_budget_exhausted');
   expect(f.notifications.some((value:any)=>value.method==='item/started'&&value.params?.item?.type==='contextCompaction')).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('rebuilds only after old process closes when the source epoch changes',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const record:ConversationRecord={id:'a',turnId:'t',kind:'user',atMs:1,text:'history'};
 try{
   await f.worker.prepareContext!(input,{snapshot:history([record]),currentTurnId:'t'},signal,'source',0,0);
   await f.worker.prepareContext!(input,{snapshot:history([record],1),currentTurnId:'t'},signal,'source',0,0);
   expect(f.processes()).toBe(2);expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('never retries an ambiguous durable settlement or returns its prediction',async()=>{
 const f=await fixture(true);try{
   const r=await f.worker.observe(input,new AbortController().signal,'source',0);
   expect(r.status).toBe('accounting_error');expect(r.interpretation).toBeNull();expect(f.settlementAttempts()).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('keeps process and model thread alive across settled calls without double-counting cumulative usage',async()=>{
 const f=await fixture();try{
   const stages:string[]=[];const a=await f.worker.observe(input,new AbortController().signal,'source',1,s=>stages.push(s));expect(a.status,JSON.stringify({a,stages,notifications:f.notifications,ledger:f.accounting.snapshot()})).toBe('interpreted');
   await f.worker.release!();
   const b=await f.worker.observe({...input,goalSummary:'next'},new AbortController().signal,'source',2);expect(b.status).toBe('interpreted');
   expect(f.processes()).toBe(1);expect(f.worker.status().active).toBe(false);
   expect(f.accounting.snapshot()).toMatchObject({starts:2,knownTokens:220,inFlight:0,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it('keeps owner, operation, process exit, and usage receipts independent',async()=>{
 const f=await fixture();
 try{await f.worker.observe(input,new AbortController().signal,'source',4);}
 finally{await f.worker.close();await f.accounting.close();}
 const lines=(await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
 expect(lines.some(line=>line.kind==='process_owner'&&line.fullPipelineVerified===false)).toBe(true);
 expect(lines.some(line=>line.kind==='operation'&&line.admissionId&&line.terminalState==='completed')).toBe(true);
 expect(lines.some(line=>line.kind==='operation'&&line.operationId&&line.usageCompleteness==='single_update')).toBe(true);
 expect(lines.some(line=>line.kind==='process_exit'&&line.processExitState==='closed')).toBe(true);
});
it('does not reserve or dispatch after authorization revocation',async()=>{
 const f=await fixture();try{
   f.revoke();const r=await f.worker.observe(input,new AbortController().signal,'source',0);
   expect(r.status).toBe('disabled');expect(f.accounting.snapshot().starts).toBe(0);expect(f.processes()).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('writes a cancelled terminal receipt when cancellation wins before compact request dispatch',async()=>{
 const controller=new AbortController();const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget(),abortOnUpdate:()=>controller.abort()});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},controller.signal,'source',0,0)).rejects.toThrow();
   const lines=(await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
   expect(lines.filter(line=>line.kind==='operation'&&line.operationKind==='context_compression'&&line.terminalState==='cancelled')).toHaveLength(1);
   expect(f.notifications.some((value:any)=>value.method==='item/started'&&value.params?.item?.type==='contextCompaction')).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('does not allow a worker to mix source conversations',async()=>{
 const f=await fixture();try{
   await f.worker.observe(input,new AbortController().signal,'a',0);
   const other=await f.worker.observe(input,new AbortController().signal,'b',0);
   expect(other.interpretation).toBeNull();expect(f.accounting.snapshot().starts).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('records an unconfirmed timed-out operation and leaves its admission unresolved',async()=>{
 const f=await fixture(false,{script:timeoutScript,sessionTimeoutMs:10});
 try{
   const r=await f.worker.observe(input,new AbortController().signal,'source',0);
   expect(r.status).toBe('process_error');expect(f.settlementAttempts()).toBe(0);
   expect(f.accounting.snapshot()).toMatchObject({inFlight:1,unresolved:1,unknown:0});
   expect(f.lastProcess()?.status().closed).toBe(true);
   const lines=(await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
   expect(lines.some(line=>line.kind==='operation'&&line.terminalState==='unconfirmed'&&line.turnId==='r1')).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('poisons on asynchronous usage receipt failure without settling its admission',async()=>{
 const f=await fixture(false,{receiptFailure:true});
 try{
   const r=await f.worker.observe(input,new AbortController().signal,'source',0);
   expect(r.status).toBe('accounting_error');expect(f.settlementAttempts()).toBe(0);
   expect(f.accounting.snapshot()).toMatchObject({inFlight:1,unresolved:1,unknown:0});
   expect(f.worker.status().poisoned).toBe(true);expect(f.lastProcess()?.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});

it('accounts runtime compaction as a separate context_compression operation before the next injection',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,retainedSummaryByteReserve:32,historyBudget:controlledBudget()});
 const signal=new AbortController().signal;
 const record:ConversationRecord={id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)};
 try{
   await f.worker.prepareContext!(input,{snapshot:history([record]),currentTurnId:'t'},signal,'source',0,0);
   const lines=(await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
   const compactions=lines.filter(line=>line.kind==='operation'&&line.operationKind==='context_compression'&&line.terminalState==='completed');
   expect(compactions.length).toBeGreaterThan(0);
   expect(f.accounting.snapshot()).toMatchObject({starts:compactions.length,unknown:compactions.length,inFlight:0});
   expect(lines.some(line=>line.kind==='operation'&&line.operationKind==='context_compression'&&line.terminalState==='completed')).toBe(true);
   expect(JSON.stringify(lines)).not.toContain('retainedBytes');
 }finally{await f.worker.close();await f.accounting.close();}
});

it('attests each model-capable compaction with the current session binding',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,retainedSummaryByteReserve:32,historyBudget:controlledBudget()});
 try{await f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0);expect(f.preparations()).toBeGreaterThan(1);}
 finally{await f.worker.close();await f.accounting.close();}
});

it('settles a failed compact as unknown usage after confirmed cleanup',async()=>{
 const f=await fixture(false,{script:failedCompactionScript,bootstrapBatchByteCapacity:1024,retainedSummaryByteReserve:32,historyBudget:controlledBudget()});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow();
   expect(f.accounting.snapshot()).toMatchObject({starts:1,unknown:1,inFlight:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it('records compaction close failure as unresolved cleanup instead of claiming safe closure',async()=>{
 const f=await fixture(false,{script:failedCompactionScript,compactionCloseFailure:true,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget()});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow();
   expect(f.worker.status().poisoned).toBe(true);
   expect(f.accounting.snapshot()).toMatchObject({unknown:1,inFlight:0});
 }finally{await f.worker.close().catch(()=>undefined);await f.accounting.close();}
});

it('poisons the worker when a compaction terminal receipt cannot be durably written',async()=>{
 const f=await fixture(false,{script:compactionScript,compactionReceiptFailure:true,bootstrapBatchByteCapacity:1024,retainedSummaryByteReserve:32,historyBudget:controlledBudget()});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow();
   expect(f.worker.status().poisoned).toBe(true);expect(f.accounting.snapshot()).toMatchObject({starts:1,inFlight:1,unresolved:1});
 }finally{await f.worker.close();await f.accounting.close();}
});
