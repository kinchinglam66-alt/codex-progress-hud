import {expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Script} from 'node:vm';
import {createPersistentObserverWorker} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createPersistentReceiptJournal} from '../../src/estimation/observer-persistent-receipt.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
const input:ObserverInput={goalSummary:'current',runtime:'running',activeSeconds:10,messages:[{kind:'user',text:'current',truncated:false}],truncated:false};
const script=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){const id='r'+(++n);emit({id:m.id,result:{turn:{id}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{inputTokens:100*n,outputTokens:10*n,totalTokens:110*n,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const timeoutScript=`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'r1'}}});emit({method:'item/completed',params:{threadId:'t',turnId:'r1',item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
async function fixture(failSettlement=false,options:{script?:string;sessionTimeoutMs?:number;receiptFailure?:boolean}={}){
 new Script(script);
 const dir=await mkdtemp(join(tmpdir(),'hud-persistent-worker-'));await mkdir(join(dir,'ledger'));
 const accounting=await openReleaseAccounting(join(dir,'ledger'),Date.now);let processes=0,authorized=true,settlementAttempts=0;const notifications:unknown[]=[];const imports:unknown[]=[];let lastProcess:ReturnType<typeof createObserverSessionProcess>|undefined;
 if(failSettlement){const original=accounting.forConversation.bind(accounting);accounting.forConversation=key=>{const v=original(key);return {...v,settle:async()=>{settlementAttempts++;throw Error('simulated storage failure');}};};}
 const baseJournal=createPersistentReceiptJournal(join(dir,'receipts'));
 const receiptJournalFactory=options.receiptFailure?()=>({...baseJournal,usageSnapshot:async()=>{throw Error('private journal detail');}}):undefined;
 const worker=createPersistentObserverWorker({...({accounting,authorize:()=>authorized,now:Date.now,outputSchema:{type:'object'},receiptDirectory:join(dir,'receipts'),sessionTimeoutMs:options.sessionTimeoutMs,receiptJournalFactory,
   prepareSession:async()=>({invocation:{executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',options.script??script],input:''},binding:{accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)}}),
   processFactory:()=>{processes++;const p=createObserverSessionProcess({captureIdentity:async()=> '123'});lastProcess=p;const start=p.start;return {...p,start:async(i:any)=>{const r=await start(i);r.rpc.subscribe(n=>notifications.push(n));const call=r.rpc.call;r.rpc.call=(m,p)=>{if(m==='thread/inject_items')imports.push(p);return call(m,p);};return r;}};}} as any)});
 return {accounting,worker,notifications,imports,settlementAttempts:()=>settlementAttempts,processes:()=>processes,lastProcess:()=>lastProcess,receipts:join(dir,'receipts'),revoke:()=>{authorized=false;}};
}
function history(records:ConversationRecord[],epoch=0):HistorySnapshot{
 return {identity:'local-only-source-identity',sourceEpoch:epoch,revision:records.length,coverage:{complete:true,gaps:[]},
   async *records(){for(const [ordinal,record]of records.entries())yield {ordinal,record};},close:async()=>{}};
}
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
