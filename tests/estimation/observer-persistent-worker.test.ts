import {expect,it} from 'vitest';
import {nativePreservationInstructions} from '../../src/estimation/native-preservation.js';
import {transitionComparisonNativeState} from '../../src/evaluation/native-comparison-transition.js';
import {mkdtemp,mkdir,readFile,writeFile,readdir,unlink,rm} from 'node:fs/promises';
import {createNativeWorkerResources} from '../../src/estimation/native-worker-resources.js';
import {createNativeSourceSnapshot} from '../../src/observer/native-source-snapshot.js';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Script} from 'node:vm';
import {createPersistentObserverWorker,type PersistentHistoryBudget} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createPersistentReceiptJournal,preparationErrorCode} from '../../src/estimation/observer-persistent-receipt.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import {parseCodexCheckpoint} from '../../src/observer/codex-checkpoint.js';
import {verifyHistoryFallback} from '../../src/observer/verified-history-fallback.js';
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';
import {createNativeComparisonFixtures,createCompletedTurnComparisonFixtures} from '../../src/evaluation/native-comparison-fixture.js';
import {persistentHistoryPolicy} from '../../src/estimation/persistent-history-policy.js';
import {createSessionAccountReuseIssuer} from '../../src/estimation/session-account-reuse.js';
import {createNativeRetentionPermit} from '../../src/estimation/native-owner-retention.js';
import {createObserverProviderHost} from '../../src/desktop/observer-provider-host.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
import type {BoundNativeTurnSource} from '../../src/observer/native-source-request.js';
const input:ObserverInput={goalSummary:'current',runtime:'running',activeSeconds:10,messages:[{kind:'user',text:'current',truncated:false}],truncated:false};
it('provider host retains the native process and revokes it after releasing the outer lease',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 const directory=await mkdtemp(join(tmpdir(),'hud-native-provider-retention-'));
 const host=await createObserverProviderHost({dataDirectory:directory,autoStartSubscription:true,
  consentProtection:{protect:value=>value,unprotect:value=>value},
  openSubscription:async()=>({workers:[],inspect:async()=>({label:'synthetic',fingerprint:'synthetic'}),close:()=>f.worker.close(),
   workerSource:{acquire:()=>f.worker,all:()=>[f.worker],release:async(_key,permit)=>{await f.worker.release!(permit);},
    updateRetentionState:(_key,state)=>f.worker.updateRetentionState!(state)}})});
 try{
  await host.start(signal);host.workerSource!.acquire('source');
  await f.prepareAndObserve(1,signal);
  await host.workerSource!.release('source',createNativeRetentionPermit({...f.state,idleStartedAtMs:0,nextOrdinaryAtMs:300000}));
  expect(f.lastProcess()!.status().closed).toBe(false);
  host.workerSource!.acquire('source');await f.prepareAndObserve(2,signal);
  expect(f.processes()).toBe(1);
  await host.workerSource!.release('source',createNativeRetentionPermit({...f.state,idleStartedAtMs:0,nextOrdinaryAtMs:300000}));
  host.workerSource!.updateRetentionState?.('source',null);
  // Join asynchronous retirement without granting another keepalive permit.
  await f.worker.release!();
  expect(f.lastProcess()!.status().closed).toBe(true);
  expect(f.worker.status()).toMatchObject({nativeLifecycle:{retirementReason:'state_revoked'}});
  expect(f.accounting.snapshot()).toMatchObject({starts:2,unresolved:0});
 }finally{await host.close();await f.worker.close();await f.accounting.close();await rm(directory,{recursive:true,force:true});}
});
it('reports live preparation and inference phases to a request subscriber and detaches it safely',async()=>{
 const f=await fixture(false),signal=new AbortController().signal,phases:string[]=[];
 try{
  const worker=f.worker as typeof f.worker & {subscribeContextPhase?:(listener:(phase:string)=>void)=>()=>void};
  expect(typeof worker.subscribeContextPhase).toBe('function');
  const off=worker.subscribeContextPhase!(phase=>phases.push(phase));
  const prepared=await worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect((await worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(phases).toContain('accountProcessMs');expect(phases).toContain('inferenceMs');expect(phases).toContain('deliveryMs');
  off();const count=phases.length;
  expect((await worker.observe(input,signal,'source',0)).status).toBe('interpreted');
  expect(phases).toHaveLength(count);
 }finally{await f.worker.close();await f.accounting.close();}
});
type TestReuse={claim(signal:AbortSignal):Promise<{validate(signal:AbortSignal):Promise<boolean>;valid():boolean}|null>;invalidate():void};
function reusable(localValid=()=>true):TestReuse{
 let consumed=false,invalid=false;
 const valid=()=>!invalid&&localValid();
 return {invalidate(){invalid=true;},async claim(signal){if(consumed)return null;consumed=true;
  if(signal.aborted||!valid())return null;
  return {valid,validate:async s=>!s.aborted&&valid()};}};
}
it('reuses only the prepared request account check while dispatching and accounting one real child ETA',async()=>{
 const f=await fixture(false,{reuseFactory:()=>reusable()}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect((await f.worker.observe({...prepared.input},signal,'source',0)).status).toBe('invalid_input');
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.preparations()).toBe(1);
  expect(f.accounting.snapshot()).toMatchObject({starts:1,knownTokens:110,unresolved:0});
  // A second call cannot consume the prepared proof again.
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.preparations()).toBe(2);
  expect(f.preparationPolicies).toEqual([{accountCache:'allow'},{accountCache:'bypass'}]);
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([false,true])('rejects an account change at provider return while retaining usage (reuse=%s)',async(reuse)=>{
 const f=await fixture(false,{...(reuse?{reuseFactory:()=>reusable()}: {})}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  const result=await f.worker.observe(prepared.input,signal,'source',0,stage=>{if(stage==='provider_returned')f.changeBinding();});
  expect(result.status).toBe('process_error');expect(result.interpretation).toBeNull();
  expect(result.usage?.inputTokens).toBe(100);
  expect(f.accounting.snapshot()).toMatchObject({knownTokens:110,unknown:0,unresolved:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it('settles unknown usage when account binding changes after a usage-less terminal',async()=>{
 const f=await fixture(false,{script:script.replaceAll("method:'thread/tokenUsage/updated'","method:'diagnostic/unused'")}),signal=new AbortController().signal;
 try{
  let returned=false;
  const result=await f.worker.observe(input,signal,'source',0,stage=>{if(stage==='provider_returned'){returned=true;f.changeBinding();}});
  expect(returned).toBe(true);expect(result.status).toBe('process_error');expect(result.usage).toBeNull();
  expect(f.accounting.snapshot()).toMatchObject({knownTokens:0,unknown:1,unresolved:0,inFlight:0});
  const receipts=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
  expect(receipts).toContain('"usageCompleteness":"missing"');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('accepts a completed ETA after dispatch reuse expires when the account binding remains valid',async()=>{
 let clock=1000;const issuer=createSessionAccountReuseIssuer({now:()=>clock,monotonicNow:()=>clock});
 const f=await fixture(false,{reuseFactory:()=>issuer.issue({observedAt:clock,observedMonotonic:clock,expiresAt:clock+300000,validateLocal:async()=>true})}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  const result=await f.worker.observe(prepared.input,signal,'source',0,stage=>{if(stage==='provider_returned')clock+=45000;});
  expect(result.status).toBe('interpreted');expect(f.preparations()).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('attributes reused local guard time to account preparation rather than history import',async()=>{
 let phase='';const seen:string[]=[],issuer=createSessionAccountReuseIssuer({now:()=>1000,monotonicNow:()=>20});
 const f=await fixture(false,{onContextPhase:value=>{phase=value;},reuseFactory:()=>issuer.issue({observedAt:1000,observedMonotonic:20,
  expiresAt:301000,validateLocal:async()=>{seen.push(phase);return true;}})}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(seen).toEqual(['accountProcessMs','accountProcessMs']);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('falls back to one full check when a prepared reuse proof expired before admission',async()=>{
 let valid=true;const f=await fixture(false,{reuseFactory:()=>reusable(()=>valid)}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  valid=false;
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.preparations()).toBe(2);expect(f.accounting.snapshot().knownTokens).toBe(110);
  expect(f.preparationPolicies).toEqual([{accountCache:'allow'},{accountCache:'bypass'}]);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('cancels an admitted unsent ETA when reuse expires during the dispatch journal without retry',async()=>{
 let valid=true;const f=await fixture(false,{reuseFactory:()=>reusable(()=>valid),abortOnUpdate:()=>{valid=false;}}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('process_error');
  expect(f.preparations()).toBe(1);
  expect(f.accounting.snapshot()).toMatchObject({knownTokens:0,unknown:0,unresolved:0,inFlight:0});
  expect(f.notifications.filter((n:any)=>n.method==='turn/completed')).toHaveLength(0);
  const receipt=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
  expect(receipt).toContain('cancelled_before_dispatch');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('discards request reuse after release without closing a healthy history process',async()=>{
 let invalidations=0;
 const f=await fixture(false,{reuseFactory:()=>reusable(),invalidateSessionReuse:()=>{invalidations++;}}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  await f.worker.release!();
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.preparations()).toBe(2);expect(f.processes()).toBe(1);
  expect(invalidations).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('does not invalidate shared account evidence for a task cancelled before identity preparation',async()=>{
 let invalidations=0;
 const f=await fixture(false,{invalidateSessionReuse:()=>{invalidations++;}}),controller=new AbortController();
 controller.abort();
 try{
  await expect(f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},controller.signal,'source',0,0)).rejects.toThrow();
  expect(f.preparations()).toBe(0);expect(invalidations).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('does not reuse an ETA account check across an intervening compaction',async()=>{
 const f=await fixture(false,{reuseFactory:()=>reusable(),script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget()}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'long',kind:'tool_result',turnId:'t',atMs:2,text:'history '.repeat(240)}]),currentTurnId:'t'},signal,'source',0,0);
  const checks=f.preparations();expect(checks).toBeGreaterThan(1);
  expect(f.preparationPolicies[0]).toEqual({accountCache:'allow'});
  expect(f.preparationPolicies.slice(1)).toEqual(Array.from({length:checks-1},()=>({accountCache:'bypass'})));
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.preparations()).toBe(checks+1);expect(f.accounting.snapshot().unknown).toBeGreaterThan(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('invalidates reuse on an observed account event and removes its listener when closed',async()=>{
 let invalidations=0;
 const accountScript=script.replace("else emit({id:m.id,result:{}});","else if(m.method==='test/account_updated'){emit({method:'account/updated',params:{}});emit({id:m.id,result:{}});}else emit({id:m.id,result:{}});");
 const f=await fixture(false,{reuseFactory:()=>reusable(),script:accountScript,invalidateSessionReuse:()=>{invalidations++;}}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect(f.activeListeners()).toBe(1);
  await f.accountUpdated();expect(invalidations).toBe(1);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.preparations()).toBe(2);expect(f.activeListeners()).toBe(1);
  await f.worker.close();expect(f.activeListeners()).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('rechecks the proof after synchronous dispatch-stage listeners before sending to the child',async()=>{
 let valid=true;const f=await fixture(false,{reuseFactory:()=>reusable(()=>valid)}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0,stage=>{if(stage==='dispatch')valid=false;})).status).toBe('process_error');
  expect(f.accounting.snapshot()).toMatchObject({knownTokens:0,unknown:0,unresolved:0,inFlight:0});
  expect(f.notifications.filter((n:any)=>n.method==='turn/completed')).toHaveLength(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('does not let an older preparation or a concurrent observe share request reuse',async()=>{
 const f=await fixture(false,{reuseFactory:()=>reusable()}),signal=new AbortController().signal;
 try{
  const first=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  const second=await f.worker.prepareContext!(input,{snapshot:history([]),currentTurnId:'t'},signal,'source',0,0);
  const operation=f.worker.observe(second.input,signal,'source',0);
  expect((await f.worker.observe(second.input,signal,'source',0)).status).toBe('busy');
  expect((await operation).status).toBe('interpreted');expect(f.preparations()).toBe(2);
  expect((await f.worker.observe(first.input,signal,'source',0)).status).toBe('process_error');
  expect(f.accounting.snapshot().knownTokens).toBe(110);
 }finally{await f.worker.close();await f.accounting.close();}
});
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=','base64');
it('preserves the comparison fixture image through disk reader, worker and native RPC import without inference',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const sourceThreadId='77777777-7777-4777-8777-777777777777';
 const [source]=createNativeComparisonFixtures({sourceThreadId,cwd:process.cwd()});
 const sourceImage=source.rollout.trim().split('\n').map(line=>JSON.parse(line))
  .flatMap(row=>row.payload.content??[]).find(part=>part.type==='input_image').image_url;
 const root=join(f.receipts,'synthetic-source'),day=join(root,'2026','09','14');
 await mkdir(day,{recursive:true});await writeFile(join(day,`rollout-2026-09-14T12-00-00-${sourceThreadId}.jsonl`),source.rollout);
 const reader=createLocalSessionReader({root});
 try{
  const snapshot=await reader.snapshot(sourceThreadId,signal);
  await f.worker.prepareContext!(input,{snapshot,currentTurnId:source.currentTurnId},signal,'comparison-source',0,0);
  const items=f.imports.flatMap((request:any)=>request.items);
  const images=items.flatMap((item:any)=>item.content??[]).filter((part:any)=>part.type==='input_image');
  expect(images).toEqual([{type:'input_image',image_url:sourceImage}]);
  expect(JSON.stringify(items)).toContain('CERULEAN-7421');
  expect(JSON.stringify(items)).toContain('BIRCH-6193');
  expect(JSON.stringify(items)).toContain('CHECKPOINT-ALPHA');
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await reader.close();await f.worker.close();await f.accounting.close();}
});
it('reports preparation, compaction, inference and delivery phases without allowing telemetry to block work',async()=>{
 const phases:string[]=[],f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget(),
  onContextPhase:phase=>{phases.push(phase);throw Error('diagnostic listener failed');}}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'long',kind:'tool_result',turnId:'t',atMs:2,text:'history '.repeat(240)}]),currentTurnId:'t'},signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(phases).toContain('compactionMs');expect(phases[0]).toBe('accountProcessMs');
  expect(phases.indexOf('forkImportMs')).toBeLessThan(phases.indexOf('compactionMs'));
  expect(phases.indexOf('compactionMs')).toBeLessThan(phases.indexOf('inferenceMs'));
  expect(phases.at(-1)).toBe('deliveryMs');
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each(['process','binding'] as const)('requires history re-import after prepared %s replacement',async replacement=>{
 const f=await fixture(),signal=new AbortController().signal;
 const records:ConversationRecord[]=[{id:'image',kind:'user',turnId:'t',atMs:1,
   contentParts:[{type:'input_image',imageUrl:'data:image/png;base64,'+imageBytes.toString('base64')}]}];
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'t'},signal,'source',0,0);
   if(replacement==='process')await f.lastProcess()!.close();else f.changeBinding();
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).not.toBe('interpreted');
   expect(f.accounting.snapshot().starts).toBe(0);
   const rebuilt=await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'t'},signal,'source',0,0);
   expect((await f.worker.observe(rebuilt.input,signal,'source',0)).status).toBe('interpreted');
   expect(f.imports).toHaveLength(2);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('carries actual local post-checkpoint image bytes from source to RPC without receipt leakage',async()=>{
 const f=await fixture(),signal=new AbortController().signal,root=join(f.receipts,'source');
 await mkdir(root,{recursive:true});const path=join(root,'fixture.png');await writeFile(path,imageBytes);
 const thread='22222222-2222-4222-8222-222222222222';
 const directory=join(root,'2026','09','13');await mkdir(directory,{recursive:true});
 await writeFile(join(directory,`rollout-2026-09-13T00-00-00-${thread}.jsonl`),[
   {type:'session_meta',payload:{id:thread}},
   {type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'synthetic'}]}},
   {type:'event_msg',payload:{type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'image',content:[
     {type:'input_text',text:'before'},{type:'local_image',path},{type:'input_text',text:'after'}]}}}
 ].map(record=>JSON.stringify({timestamp:'2026-09-13T00:00:00Z',...record})).join('\n')+'\n');
 const reader=createLocalSessionReader({root});
 try{
   const snapshot=await reader.snapshot(thread,signal);
   const prepared=await f.worker.prepareContext!(input,{snapshot,currentTurnId:'t'},signal,'source',0,0);
   const imported=(f.imports.at(-1) as any).items[0].content;
   expect(imported.slice(1)).toEqual([{type:'input_text',text:'before'},
     {type:'input_image',image_url:'data:image/png;base64,'+imageBytes.toString('base64')},{type:'input_text',text:'after'}]);
   expect(JSON.stringify(f.imports)).not.toContain(path);
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
   const receipt=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
   expect(receipt).not.toContain(path);expect(receipt).not.toContain(imageBytes.toString('base64'));
 }finally{await reader.close();await f.worker.close();await f.accounting.close();}
});
it('preserves missing-image quality across compaction replay and a new turn until rebuilt',async()=>{
 const f=await fixture(false,{script:compactionScript,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget()}),signal=new AbortController().signal;
 const path=join(f.receipts,'restored.png');
 const records:ConversationRecord[]=[{id:'missing',kind:'user',turnId:'t',atMs:1,contentParts:[{type:'local_image',path}]},
   {id:'long',kind:'tool_result',turnId:'t',atMs:2,text:'history '.repeat(240)}];
 try{
   const first=await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'t'},signal,'source',0,0);
   expect(first.representation.confirmedCompactions).toBeGreaterThan(0);
   expect(first.representation.missingImages).toBe(1);
   const imports=f.imports.length;
   const replay=await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'t'},signal,'source',0,0);
   expect(f.imports).toHaveLength(imports);expect(replay.representation.missingImages).toBe(1);
   records.push({id:'next',kind:'user',turnId:'next',atMs:3,text:'continue'});
   const next=await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'next'},signal,'source',1,0);
   expect(next.representation).toMatchObject({sourceComplete:false,missingImages:1,inferenceEligible:true});
   expect((await f.worker.observe(next.input,signal,'source',1)).status).toBe('interpreted');
   await writeFile(path,imageBytes);
   await expect(f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'next'},signal,'source',1,0)).rejects.toThrow('SOURCE_REWRITE');
   const rebuilt=await f.worker.prepareContext!(input,{snapshot:history(records),currentTurnId:'next'},signal,'source',1,0);
   expect(rebuilt.representation).toMatchObject({sourceComplete:true,missingImages:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it('rejects changed same-path images before admitting a forecast',async()=>{
 const f=await fixture(),signal=new AbortController().signal,path=join(f.receipts,'image.png');
 await mkdir(f.receipts,{recursive:true});await writeFile(path,imageBytes);
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'image',kind:'user',turnId:'t',atMs:1,contentParts:[{type:'local_image',path}]}]),currentTurnId:'t'},signal,'source',0,0);
   await writeFile(path,Buffer.concat([imageBytes,Buffer.from([0])]));
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).not.toBe('interpreted');
   expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('rejects an image changed during inference but retains its actual token usage',async()=>{
 const f=await fixture(),signal=new AbortController().signal,path=join(f.receipts,'image.png');
 await mkdir(f.receipts,{recursive:true});await writeFile(path,imageBytes);
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'image',kind:'user',turnId:'t',atMs:1,contentParts:[{type:'local_image',path}]}]),currentTurnId:'t'},signal,'source',0,0);
   // Stage callback is before acceptance, after actual fake provider completion.
   const {writeFileSync}=await import('node:fs');
   const result=await f.worker.observe(prepared.input,signal,'source',0,stage=>{
     if(stage==='provider_returned')writeFileSync(path,Buffer.concat([imageBytes,Buffer.from([1])]));
   });
   expect(result.status).not.toBe('interpreted');expect(result.interpretation).toBeNull();
   expect(result.usage).toMatchObject({inputTokens:100,outputTokens:10});
   expect(f.accounting.snapshot().knownTokens).toBe(110);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('blocks unresolved image projections at the worker admission boundary',async()=>{
 const f=await fixture();try{
   expect((await f.worker.observe({...input,imageContextPending:true},new AbortController().signal,'source',0)).status).toBe('invalid_input');
   expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('settles known usage when cancellation wins after an image forecast returns',async()=>{
 const f=await fixture(),controller=new AbortController(),path=join(f.receipts,'image.png');
 await mkdir(f.receipts,{recursive:true});await writeFile(path,imageBytes);
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'image',kind:'user',turnId:'t',atMs:1,contentParts:[{type:'local_image',path}]}]),currentTurnId:'t'},controller.signal,'source',0,0);
   const result=await f.worker.observe(prepared.input,controller.signal,'source',0,stage=>{if(stage==='provider_returned')controller.abort();});
   expect(result.interpretation).toBeNull();expect(result.usage).toMatchObject({inputTokens:100,outputTokens:10});
   expect(f.accounting.snapshot().knownTokens).toBe(110);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('retains native owner across fresh forks and retires immediately after the third terminal',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  for(let i=0;i<3;i++){
   await f.prepareAndObserve(i+1,signal);
   await f.release();
   if(i<2){expect(f.lastProcess()!.status().alive).toBe(true);expect(f.lifecycle).not.toContain('snapshot-close');
    const receipt=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
    expect(receipt).not.toContain('"processExitState":"closed"');}
   f.advance(300000);
  }
  expect(f.processes()).toBe(1);expect(f.forks).toEqual(['fork-1','fork-2','fork-3']);
  expect(f.lastProcess()!.status().closed).toBe(true);
  expect(f.lifecycle.filter(v=>v==='snapshot-close')).toHaveLength(3);
  expect(f.accounting.snapshot()).toMatchObject({starts:3,knownTokens:330,inFlight:0,unresolved:0});
  expect(f.activeListeners()).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('reports anonymous lifecycle measurements without moving the retention deadline',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  expect(f.worker.status().nativeLifecycle).toMatchObject({generation:1,processStarts:1,reuses:0,requests:1,knownBytes:100,retained:true,idleRemainingMs:360000});
  f.advance(300000);
  expect(f.worker.status().nativeLifecycle?.idleRemainingMs).toBe(60000);
  await f.prepareAndObserve(2,signal);await f.release();
  expect(f.worker.status().nativeLifecycle).toMatchObject({generation:1,processStarts:1,reuses:1,requests:2,knownBytes:200});
  f.worker.updateRetentionState!({...f.state,running:false});await f.worker.release!();
  const status=f.worker.status().nativeLifecycle;
  expect(status).toMatchObject({retained:false,requests:0,knownBytes:0,idleRemainingMs:null,retirementReason:'state_revoked'});
  expect(JSON.stringify(status)).not.toMatch(/source|current|[A-Z]:|ownerUuid|accountFingerprint/);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('reclaims a retained native owner when waiting is reported without another request',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  f.worker.updateRetentionState!({...f.state,running:false});
  await f.worker.release!();
  expect(f.lastProcess()!.status().closed).toBe(true);expect(f.lifecycle).toContain('snapshot-close');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('disable alone drains retained native resources without a subsequent release or close',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  f.worker.disable();
  for(let i=0;i<100&&f.worker.status().cleanupPending;i++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(f.worker.status().cleanupPending).toBe(false);
  expect(f.lastProcess()!.status().closed).toBe(true);expect(f.lifecycle).toContain('snapshot-close');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('checks native idle expiry at acquisition even when the timer did not run',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  expect(f.lastProcess()!.status().alive).toBe(true);
  f.advance(360000);
  await f.worker.nativeSourceDestination!(signal);
  expect(f.lastProcess()!.status().closed).toBe(true);expect(f.lifecycle).toContain('snapshot-close');
  await f.prepareAndObserve(2,signal);
  expect(f.processes()).toBe(2);
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([300000,600000,900000,1800000])('preserves a healthy owner at the real policy interval %i',async(interval)=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release(interval);f.advance(interval);
  await f.prepareAndObserve(2,signal);
  expect(f.processes()).toBe(1);expect(f.forks).toEqual(['fork-1','fork-2']);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('does not retain after state was revoked during the asynchronous resource check',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);
  let unblock!:()=>void;f.checkUsage(async()=>{await new Promise<void>(resolve=>{unblock=resolve;});});
  const release=f.release();await new Promise<void>(resolve=>setImmediate(resolve));
  f.worker.updateRetentionState!({...f.state,running:false});unblock();await release;
  expect(f.lastProcess()!.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('retires instead of leaking a live owner if the clock reverses during release measurement',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  f.advance(1000);await f.prepareAndObserve(1,signal);f.checkUsage(async()=>{f.advance(-100);});
  await expect(f.release()).resolves.toBeUndefined();
  expect(f.lastProcess()!.status().closed).toBe(true);expect(f.worker.status().cleanupPending).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('reclaims when the permit expires exactly as the idle timer is being armed',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);let reads=0;
  f.onClock(()=>{if(++reads===3)f.advance(360000);});
  await f.release();
  expect(f.lastProcess()!.status().closed).toBe(true);expect(f.worker.status().cleanupPending).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('retires a retained owner on monotonic clock reversal',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  f.advance(1000);await f.prepareAndObserve(1,signal);await f.release();
  f.advance(-100);await f.worker.nativeSourceDestination!(signal);
  expect(f.lastProcess()!.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('denies model admission if owned resources cross the byte threshold during preparation',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  f.setBytes(64*1024*1024);
  const prepared=await f.prepare(1,signal);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('process_error');
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('an old idle callback cannot close a newly acquired native request',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  const old=f.timers[0]!;expect(old.delay).toBe(360000);
  f.advance(300000);await f.worker.nativeSourceDestination!(signal);
  old.run();await new Promise<void>(resolve=>setImmediate(resolve));
  expect(f.lastProcess()!.status().alive).toBe(true);
  await f.prepareAndObserve(2,signal);expect(f.processes()).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('a native timer reclaims at the deadline without an incoming request',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  f.advance(360000);f.timers[0]!.run();await f.worker.release!();
  expect(f.lastProcess()!.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('comparison transition joins asynchronous retirement before requesting the next destination',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  await f.prepareAndObserve(1,signal);await f.release();
  const next={...f.state,turnKey:'next',generation:1};
  f.worker.updateRetentionState!(next);
  await expect(f.worker.nativeSourceDestination!(signal)).rejects.toThrow('NATIVE_DESTINATION_UNAVAILABLE');
  await transitionComparisonNativeState({updateRetentionState:state=>f.worker.updateRetentionState!(state),
   release:()=>f.worker.release!()},f.state,next,signal);
  await expect(f.worker.nativeSourceDestination!(signal)).resolves.toMatchObject({sourceProfile:'codex-01534-legacy'});
  expect(f.lastProcess()!.status().closed).toBe(true);
  expect(f.lifecycle).toContain('snapshot-close');
  expect(f.accounting.snapshot().starts).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('revokes a prepared native request on source-turn replacement even with the same numeric generation',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const prepared=await f.prepare(1,signal);
  f.worker.updateRetentionState!({...f.state,turnKey:'next'});
  await f.worker.release!();
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).not.toBe('interpreted');
  expect(f.accounting.snapshot().starts).toBe(0);expect(f.lastProcess()!.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
async function retainedNativeFixture(onNativeTurnTiming?:(event:import('../../src/estimation/native-turn-timing.js').NativeTurnTiming)=>void,
 hooks:{reuseNativeTurnSession?:boolean;inlineCurrentTurnSupplement?:boolean;nativeRequestByteLimit?:number;onForkRecorded?:(id:string)=>void;beforeResourceRelease?:()=>void;transformScript?:(script:string)=>string}={}){
 let clock=0,requests=0,bytes:number|undefined,usageCheck=async()=>{},clockRead=()=>{};const lifecycle:string[]=[],forks:string[]=[];
 const nativeScript=script.replace("let b='',n=0;","let b='',n=0,f=0,t='';")
  .replace("if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});",
   "if(m.method==='thread/start'){t='clean-'+(++f);n=0;emit({id:m.id,result:{thread:{id:t}}});}else if(m.method==='thread/fork'){t='fork-'+(++f);n=0;emit({id:m.id,result:{thread:{id:t}}});}else if(m.method==='thread/goal/get')emit({id:m.id,result:{goal:null}});")
  .replaceAll("threadId:'t'","threadId:t");
 let baseAllocation=false;
 const nativeContext={
  destination:async(_signal:AbortSignal,role?:string)=>{baseAllocation=role==='base';return {sourceProfile:'codex-01534-legacy',destinationDirectory:'C:/protected',maxSourceBytes:10000,verifyDestination:async()=>{}};},
  usage:async()=>{await usageCheck();return {requests,knownBytes:bytes??requests*100};},
  claim:async()=>{if(!baseAllocation)requests++;baseAllocation=false;return {tag:'hud_native_6a0beb2d-8d08-436a-95ba-17f6b721c989',
   recordFork:async(id:string)=>{forks.push(id);hooks.onForkRecorded?.(id);},afterProcessClosed:async()=>{expect(f.lastProcess()!.status().closed).toBe(true);}};},
  claimChild:async()=>{requests++;return {tag:'hud_native_6a0beb2d-8d08-436a-95ba-17f6b721c989',recordFork:async(id:string)=>{forks.push(id);hooks.onForkRecorded?.(id);},afterProcessClosed:async()=>{expect(f.lastProcess()!.status().closed).toBe(true);}};},
  release:async()=>{hooks.beforeResourceRelease?.();requests=0;}
 };
 const timers:Array<{run:()=>void;delay:number;cancelled:boolean}>=[];
 const f=await fixture(false,{...{reuseNativeTurnSession:hooks.reuseNativeTurnSession},...(hooks.inlineCurrentTurnSupplement===undefined?{}:{inlineCurrentTurnSupplement:hooks.inlineCurrentTurnSupplement}),...(hooks.nativeRequestByteLimit===undefined?{}:{nativeRequestByteLimit:hooks.nativeRequestByteLimit}),...(onNativeTurnTiming?{onNativeTurnTiming}:{}),nativeContext,script:hooks.transformScript?.(nativeScript)??nativeScript,monotonicNow:()=>{clockRead();return clock;},reuseFactory:()=>reusable(),
  scheduleIdle:(run,delay)=>{const timer={run,delay,cancelled:false};timers.push(timer);return()=>{timer.cancelled=true;};}});
 const state={conversationKey:'source',turnKey:'current',generation:0,running:true};
 f.worker.updateRetentionState?.(state);
 const prepare=async(revision:number,signal:AbortSignal)=>{
   const snapshot={kind:'native' as const,sourceThreadId:'original',sourceTurnId:'current',sourceEpoch:1,revision,byteLength:100,
    path:'C:/protected/snapshot-'+revision,close:async()=>{expect(f.lastProcess()!.status().closed).toBe(true);lifecycle.push('snapshot-close');}};
   return f.worker.prepareNativeContext!(input,{snapshot,currentTurnId:'current'},signal,'source',0,0);
 };
 return {...f,state,forks,lifecycle,timers,prepare,advance:(delta:number)=>{clock+=delta;},checkUsage:(check:()=>Promise<void>)=>{usageCheck=check;},
  setBytes:(value:number)=>{bytes=value;},
  onClock:(read:()=>void)=>{clockRead=read;},
  release:(interval=300000)=>f.worker.release!(createNativeRetentionPermit({...state,idleStartedAtMs:clock,nextOrdinaryAtMs:clock+interval})),
  prepareAndObserve:async(revision:number,signal:AbortSignal)=>{const prepared=await prepare(revision,signal);
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');}};
}

function pairedSource(revision:number,onCopy:()=>void=()=>{},first=false){return {identity:'original-file',sourceEpoch:1,revision,currentTurnId:'current',turnKey:'current',baseKey:'original-previous-current',
  boundary:{currentTurnId:'current',currentStartOffset:first?0:100,watermark:100+revision*100,completed:first?null:{turnId:'previous',endOffset:100}},
  supplement:history(Array.from({length:revision},(_,i)=>({id:`record-${i}`,kind:'user' as const,text:`CURRENT-${i}`,turnId:'current',atMs:i}))),
  validate:async(s:AbortSignal)=>{s.throwIfAborted();},close:async()=>{},
  openBase:async()=>{onCopy();return {kind:'native' as const,sourceThreadId:'original',sourceTurnId:'previous',sourceEpoch:1,revision,byteLength:100,path:'C:/protected/base',close:async()=>{}};}};}

it.each(['source_revalidation','input_validation'] as const)('attributes post-import rejection to %s without admitting inference',async stage=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const source=pairedSource(1);let imported=false;
  const records=source.supplement.records.bind(source.supplement);
  source.supplement.records=async function*(s){yield* records(s);imported=true;};
  if(stage==='source_revalidation')source.validate=async()=>{if(imported)throw Object.assign(Error('PRIVATE_SOURCE_TEXT'),{code:'GOAL_TICKET_STALE'});};
  await expect(f.worker.prepareNativeTurnContext!(input,source,signal,'source',0,0,
   stage==='input_validation'?()=>({activeSeconds:-1,runtime:'running',requestActiveSeconds:0}):undefined)).rejects.toThrow();
  const raw=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
  const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.find(row=>row.kind==='preparation_failure')).toMatchObject({stage,code:stage==='source_revalidation'?'GOAL_TICKET_STALE':'INVALID_OBSERVER_INPUT'});
  expect(rows.some(row=>row.kind==='operation')).toBe(false);
  expect(raw).not.toContain('PRIVATE_SOURCE_TEXT');
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});

it('accepts an opaque route key when it differs from the native turn id',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const source=pairedSource(1);source.turnKey='turn_hmac_route_key';
  f.state.turnKey='turn_hmac_route_key';f.worker.updateRetentionState!({...f.state});
  const prepared=await f.worker.prepareNativeTurnContext!(input,source,signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
 }finally{await f.worker.close();await f.accounting.close();}
});

it('rejects a paired source bound to a different opaque route key',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const source=pairedSource(1);source.turnKey='turn_other_route';
  await expect(f.worker.prepareNativeTurnContext!(input,source,signal,'source',0,0)).rejects.toThrow('SOURCE_PREPARATION_STALE');
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});

it('fails closed when a paired source has no opaque route binding',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const {turnKey:_turnKey,...source}=pairedSource(1);
  await expect(f.worker.prepareNativeTurnContext!(input,source as unknown as BoundNativeTurnSource,signal,'source',0,0)).rejects.toThrow('SOURCE_PREPARATION_STALE');
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});

it.each(['missing retention state','wrong conversation binding'] as const)('fails closed with %s',async scenario=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  if(scenario==='missing retention state'){
   f.worker.updateRetentionState!(null);
   await new Promise<void>(resolve=>setImmediate(resolve));
  }
  else {f.state.conversationKey='other';f.worker.updateRetentionState!({...f.state});}
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0)).rejects.toThrow('SOURCE_PREPARATION_STALE');
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});

it.each(['thread/fork','thread/inject_items'])('captures unadmitted model work during %s and never enters ETA',async(method)=>{
 const f=await retainedNativeFixture(undefined,{transformScript:text=>text.replace("if(!m.id)continue;",`if(!m.id)continue;if(m.method===${JSON.stringify(method)})emit({method:'turn/started',params:{threadId:'unexpected',turn:{id:'unadmitted'}}});`)}),signal=new AbortController().signal;
 try{
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0)).rejects.toThrow();
  expect(f.worker.status().poisoned).toBe(true);
  expect(f.accounting.snapshot()).toMatchObject({starts:0,unknown:1,unresolved:0});
  expect(f.lastProcess()!.status().closed).toBe(true);
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(2),signal,'source',0,0)).rejects.toThrow();
  expect(f.accounting.snapshot().unknown).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('fails closed when unexpected-model evidence cannot be persisted',async()=>{
 const f=await retainedNativeFixture(undefined,{transformScript:text=>text.replace("if(!m.id)continue;","if(!m.id)continue;if(m.method==='thread/fork')emit({method:'turn/started',params:{threadId:'unexpected',turn:{id:'unadmitted'}}});")}),signal=new AbortController().signal;
 f.accounting.recordUnexpectedOperation=async()=>{throw Error('SIMULATED_PERSISTENCE_FAILURE');};
 try{
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0)).rejects.toThrow();
  expect(f.worker.status().poisoned).toBe(true);expect(f.lastProcess()!.status().closed).toBe(true);
  expect(f.accounting.snapshot().starts).toBe(0);
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(2),signal,'source',0,0)).rejects.toThrow();
  const receipts=await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8');
  expect(receipts).toContain('"kind":"process_owner"');
  await expect(f.worker.close()).rejects.toThrow();
 }finally{await f.worker.close().catch(()=>undefined);await f.accounting.close();}
});
it('batches the whole short current-turn supplement into one child RPC',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(3),signal,'source',0,0);
  expect(p.representation.sessionCoveredRecords).toBe(3);
  const imports=(f.imports as Array<{threadId:string;items:any[]}>).filter(row=>row.threadId==='fork-2');
  expect(imports).toHaveLength(1);
  expect(imports[0]!.items.map(item=>JSON.parse(JSON.parse(item.content[0].text).observedRecord.text).text)).toEqual(['CURRENT-0','CURRENT-1','CURRENT-2']);
  expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('submits the complete native supplement with ETA without pre-injection or false imported coverage',async()=>{
 const f=await retainedNativeFixture(undefined,{inlineCurrentTurnSupplement:true}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(3),signal,'source',0,0);
  expect(p.representation).toMatchObject({sessionCoveredRecords:3,importedRecords:0,importedThroughOrdinal:null,stagedRecords:3,stagedThroughOrdinal:2});
  expect(f.imports).toHaveLength(0);expect(f.accounting.snapshot().starts).toBe(0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');
  const rows=(f.modelInputs[0] as any).input;
  expect(rows.slice(0,-1).map((row:any)=>JSON.parse(JSON.parse(row.text).observedRecord.text).text)).toEqual(['CURRENT-0','CURRENT-1','CURRENT-2']);
  expect(f.imports).toHaveLength(0);expect(f.accounting.snapshot()).toMatchObject({starts:1,knownTokens:110,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([false,true])('combines initial inline source with retained delta injection (first=%s)',async first=>{
 const f=await retainedNativeFixture(undefined,{inlineCurrentTurnSupplement:true,reuseNativeTurnSession:true}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(2,()=>{},first),signal,'source',0,0);
  expect(p.representation).toMatchObject({stagedRecords:2,importedRecords:0});expect(f.imports).toHaveLength(0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  const q=await f.worker.prepareNativeTurnContext!(input,pairedSource(3,()=>{},first),signal,'source',0,0);
  expect(q.representation).toMatchObject({stagedRecords:0,importedRecords:1,acceptedThroughOrdinal:2});
  expect(f.imports).toHaveLength(1);expect(JSON.stringify(f.imports)).toContain('CURRENT-2');expect(JSON.stringify(f.imports)).not.toContain('CURRENT-0');
  expect((await f.worker.observe(q.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  if(first)expect(f.worker.status().nativeLifecycle?.knownBytes).toBe(p.input.representation!.stagedEncodedBytes!+q.representation.importedEncodedBytes!);
  expect(new Set((f.modelInputs as any[]).map(row=>row.threadId)).size).toBe(1);
  expect(f.processes()).toBe(1);expect(f.forks).toHaveLength(first?0:2);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('rejects a locally oversized final request before ETA admission without unknown usage',async()=>{
 const f=await retainedNativeFixture(undefined,{inlineCurrentTurnSupplement:true,nativeRequestByteLimit:5000}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!({...input,messages:[{kind:'user',text:'x'.repeat(5500),truncated:false}]},pairedSource(1),signal,'source',0,0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('process_error');
  expect(f.modelInputs).toHaveLength(0);expect(f.accounting.snapshot()).toMatchObject({starts:0,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([false,true])('falls back to complete import if the final request fits only without inline supplement (reuse=%s)',async reuse=>{
 const f=await retainedNativeFixture(undefined,{inlineCurrentTurnSupplement:true,reuseNativeTurnSession:reuse,nativeRequestByteLimit:5000}),signal=new AbortController().signal;
 try{
  const source=pairedSource(1);source.supplement=history([{id:'u',kind:'user',text:'é'.repeat(1300),turnId:'current',atMs:0}]);
  const p=await f.worker.prepareNativeTurnContext!({...input,messages:[{kind:'user',text:'o'.repeat(1600),truncated:false}]},source,signal,'source',0,0);
  expect(p.representation).toMatchObject({stagedRecords:1,importedRecords:0});
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.imports).toHaveLength(1);
  const imported=(f.imports[0] as any).items[0].content[0].text;
  expect(JSON.parse(JSON.parse(imported).observedRecord.text).text).toBe('é'.repeat(1300));
  const payload=(f.modelInputs[0] as any).input;expect(payload).toHaveLength(1);
  expect(JSON.parse(payload[0].text).currentObservation.representation).toMatchObject({stagedRecords:0,importedRecords:1,importedThroughOrdinal:0});
  if(reuse)expect(JSON.parse(payload[0].text).currentObservation.representation.acceptedThroughOrdinal).toBe(0);
  expect(f.accounting.snapshot()).toMatchObject({starts:1,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([false,true])('falls back without losing the staged prefix when a later record has image content (reuse=%s)',async reuse=>{
 const f=await retainedNativeFixture(undefined,{inlineCurrentTurnSupplement:true,reuseNativeTurnSession:reuse}),signal=new AbortController().signal;
 try{
  const source=pairedSource(1);source.supplement=history([{id:'u0',kind:'user',text:'prefix',turnId:'current',atMs:0},
   {id:'u1',kind:'user',text:'image',turnId:'current',atMs:1,contentParts:[{type:'text',text:'image description'},
    {type:'input_image',imageUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII='}]}]);
  const p=await f.worker.prepareNativeTurnContext!(input,source,signal,'source',0,0);
  expect(p.representation).toMatchObject({stagedRecords:0,importedRecords:2});
  expect(JSON.stringify(f.imports)).toContain('prefix');expect(JSON.stringify(f.imports)).toContain('image description');
  expect((f.imports as any[]).flatMap(row=>row.items).flatMap(item=>item.content).some(part=>part.type==='input_image')).toBe(true);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');
  expect((f.modelInputs[0] as any).input).toHaveLength(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('keeps inline context request-scoped across fresh ETA children including a clean first turn',async()=>{
 const f=await retainedNativeFixture(undefined,{inlineCurrentTurnSupplement:true}),signal=new AbortController().signal;
 try{
  for(let n=1;n<=2;n++){
   const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(n,()=>{},true),signal,'source',0,0);
   expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  }
  const requests=f.modelInputs as any[];expect(requests.map(r=>r.threadId)).toEqual(['clean-1','clean-2']);
  expect(requests.map(r=>r.input.slice(0,-1).map((row:any)=>JSON.parse(JSON.parse(row.text).observedRecord.text).text))).toEqual([['CURRENT-0'],['CURRENT-0','CURRENT-1']]);
  expect(f.imports).toHaveLength(0);expect(f.accounting.snapshot()).toMatchObject({starts:2,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([false,true])('reuses one candidate child with verified deltas and independent estimation calls (first=%s)',async first=>{
 const f=await retainedNativeFixture(undefined,{reuseNativeTurnSession:true}),signal=new AbortController().signal;
 try{
  for(let n=1;n<=2;n++){
   const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(n,()=>{},first),signal,'source',0,0);
   expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  }
  expect(f.forks).toEqual(first?[]:['fork-1','fork-2']);
  expect((f.modelInputs as any[]).map(p=>p.threadId)).toEqual(first?['clean-1','clean-1']:['fork-2','fork-2']);
  expect(JSON.stringify(f.imports).match(/CURRENT-0/g)).toHaveLength(1);
  expect(JSON.stringify(f.imports).match(/CURRENT-1/g)).toHaveLength(1);
  expect(f.accounting.snapshot()).toMatchObject({starts:2,knownTokens:220,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});
it('does not reuse a candidate after source cancellation revokes its retained owner',async()=>{
 const f=await retainedNativeFixture(undefined,{reuseNativeTurnSession:true}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  await f.worker.observe(p.input,signal,'source',0);await f.release();
  const process=f.lastProcess()!;
  f.worker.updateRetentionState!({...f.state,running:false,idleEligible:false});
  await f.worker.release!();
  expect(process.status().closed).toBe(true);
  expect(f.modelInputs).toHaveLength(1);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('reuses only the completed-turn base and imports the whole current prefix into fresh ETA children',async()=>{
 const timings:import('../../src/estimation/native-turn-timing.js').NativeTurnTiming[]=[];
 const f=await retainedNativeFixture(event=>timings.push(event)),signal=new AbortController().signal;let copies=0;
 const source=(revision:number)=>pairedSource(revision,()=>{copies++;});
 try{
  const a=await f.worker.prepareNativeTurnContext!(input,source(1),signal,'source',0,0);
  expect((await f.worker.observe(a.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  const b=await f.worker.prepareNativeTurnContext!(input,source(2),signal,'source',0,0);
  expect((await f.worker.observe(b.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  expect(copies).toBe(1);expect(f.forks).toEqual(['fork-1','fork-2','fork-3']);expect(f.processes()).toBe(1);
  const imports=f.imports as Array<{threadId:string;items:unknown[]}>;
  expect(imports.some(value=>value.threadId==='fork-1')).toBe(false);
  expect(JSON.stringify(imports.filter(value=>value.threadId==='fork-2'))).toContain('CURRENT-0');
  const later=JSON.stringify(imports.filter(value=>value.threadId==='fork-3'));
  expect(later).toContain('CURRENT-0');expect(later).toContain('CURRENT-1');
  expect(f.worker.status().nativeLifecycle?.requests).toBe(2);
  expect(timings.filter(value=>value.phase==='base_copy')).toHaveLength(1);
  expect(timings.filter(value=>value.phase==='child_fork')).toHaveLength(2);
  expect(timings.filter(value=>value.phase==='base_acquire').map(value=>value.baseState)).toEqual(['cold','warm']);
  expect(timings.filter(value=>value.phase==='preparation_total')).toHaveLength(2);
 }finally{await f.worker.close();}
});
it('attributes retained same-turn preparation without conflating account handoff and base validation',async()=>{
 const events:import('../../src/estimation/native-turn-timing.js').NativeTurnTiming[]=[];
 const f=await retainedNativeFixture(event=>events.push(event),{reuseNativeTurnSession:true}),signal=new AbortController().signal;
 try{
  const first=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  expect((await f.worker.observe(first.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  events.length=0;
  await f.worker.prepareNativeTurnContext!(input,pairedSource(2),signal,'source',0,0);
  const names=events.map(event=>event.phase as string);
  expect(names).toContain('native_acquisition');
  expect(names).toContain('session_preparation');
  expect(names).toContain('base_reuse_validation');
  expect(names).toContain('session_ensure');
  expect(names.indexOf('session_preparation')).toBeLessThan(names.indexOf('base_reuse_validation'));
  expect(names.indexOf('base_reuse_validation')).toBeLessThan(names.indexOf('session_ensure'));
  expect(names.at(-1)).toBe('preparation_total');
  expect(events.every(event=>event.outcome==='ok'&&event.elapsedMs!==null&&event.elapsedMs>=0)).toBe(true);
  expect(f.forks).toEqual(['fork-1','fork-2']);
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each(['shorter','rewrite','revision','base','account','cancel'] as const)('rejects candidate reuse after %s without another model call',async change=>{
 const f=await retainedNativeFixture(undefined,{reuseNativeTurnSession:true}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(2),signal,'source',0,0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  const process=f.lastProcess()!,next=pairedSource(3),controller=new AbortController();
  if(change==='shorter')next.supplement=pairedSource(1).supplement;
  if(change==='rewrite')next.supplement=history([{id:'changed',kind:'user',text:'changed',turnId:'current',atMs:0}]);
  if(change==='revision')next.revision=1;
  if(change==='base')next.baseKey='changed-base';
  if(change==='account')f.changeBinding();
  if(change==='cancel'){const validate=next.validate;next.validate=async(signal)=>{await validate(signal);controller.abort();};}
  await expect(f.worker.prepareNativeTurnContext!(input,next,controller.signal,'source',0,0)).rejects.toThrow();
  expect(f.modelInputs).toHaveLength(1);expect(process.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
it.each([false,true])('starts a new candidate child for a new source turn without observer history inheritance (inline=%s)',async inline=>{
 const f=await retainedNativeFixture(undefined,{reuseNativeTurnSession:true,inlineCurrentTurnSupplement:inline}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  await f.worker.observe(p.input,signal,'source',0);await f.release();
  f.state.turnKey='next';f.state.generation=1;f.worker.updateRetentionState!({...f.state});
  const next=pairedSource(1);next.currentTurnId='next';next.turnKey='next';next.baseKey='next-base';
  next.boundary={currentTurnId:'next',currentStartOffset:300,watermark:400,completed:{turnId:'current',endOffset:300}};
  next.supplement=history([{id:'next',kind:'user',text:'NEXT-ONLY',turnId:'next',atMs:10}]);
  const open=next.openBase;next.openBase=async()=>({...await open(),sourceTurnId:'current'});
  const q=await f.worker.prepareNativeTurnContext!(input,next,signal,'source',1,0);
  expect((await f.worker.observe(q.input,signal,'source',1)).status).toBe('interpreted');
  expect(f.forks).toEqual(['fork-1','fork-2','fork-3','fork-4']);
  expect((f.modelInputs as any[]).map(p=>p.threadId)).toEqual(['fork-2','fork-4']);
  expect(JSON.stringify(inline?f.modelInputs.at(-1):f.imports.at(-1))).not.toContain('CURRENT-0');
 }finally{await f.worker.close();await f.accounting.close();}
});

it('uses fresh clean sessions for a first turn without a snapshot or historical fork and still counts requests',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;let copies=0;
 try{
  for(let revision=1;revision<=2;revision++){
   const prepared=await f.worker.prepareNativeTurnContext!(input,pairedSource(revision,()=>{copies++;},true),signal,'source',0,0);
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  }
  expect(copies).toBe(0);expect(f.forks).toEqual([]);expect(f.worker.status().nativeLifecycle?.requests).toBe(2);
  expect(f.processes()).toBe(1);
  expect(new Set((f.imports as Array<{threadId:string}>).map(value=>value.threadId))).toEqual(new Set(['clean-1','clean-2']));
 }finally{await f.worker.close();}
});

it('retains the healthy runtime across normal turn-end idle but creates a new base before next-turn ETA',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;let copies=0;
 try{
  const first=await f.worker.prepareNativeTurnContext!(input,pairedSource(1,()=>copies++),signal,'source',0,0);
  expect((await f.worker.observe(first.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  const previousProcess=f.lastProcess();
  f.worker.updateRetentionState!({...f.state,running:false,idleEligible:true});
  expect(previousProcess!.status().alive).toBe(true);
  f.state.turnKey='next';f.state.generation=1;f.worker.updateRetentionState!({...f.state});
  const next=pairedSource(1,()=>copies++);next.currentTurnId='next';next.turnKey='next';next.baseKey='original-current-next';
  next.boundary={currentTurnId:'next',currentStartOffset:300,watermark:400,completed:{turnId:'current',endOffset:300}};
  next.supplement=history([{id:'next-u',kind:'user',turnId:'next',atMs:10,text:'NEXT-ONLY'}]);
  const base=next.openBase;next.openBase=async()=>({...await base(),sourceTurnId:'current'});
  const prepared=await f.worker.prepareNativeTurnContext!(input,next,signal,'source',1,0);
  expect((await f.worker.observe(prepared.input,signal,'source',1)).status).toBe('interpreted');
  expect(copies).toBe(2);expect(f.processes()).toBe(1);expect(f.accounting.snapshot().knownTokens).toBe(220);
  expect(f.forks).toEqual(['fork-1','fork-2','fork-3','fork-4']);
  expect(f.lastProcess()).toBe(previousProcess);
  expect(JSON.stringify(f.imports.at(-1))).toContain('NEXT-ONLY');
  expect(JSON.stringify(f.imports.at(-1))).not.toContain('CURRENT-0');
  await f.release();
  expect(f.worker.status().nativeLifecycle?.requests).toBe(2);
  const third=await f.worker.prepareNativeTurnContext!(input,next,signal,'source',1,0);
  expect((await f.worker.observe(third.input,signal,'source',1)).status).toBe('interpreted');
  await f.release();
  expect(previousProcess!.status().closed).toBe(true);
  expect(f.processes()).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});

it('never dispatches a new paired preparation during retained normal idle',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  f.worker.updateRetentionState!({...f.state,running:false,idleEligible:true});
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(2),signal,'source',0,0)).rejects.toThrow('SOURCE_PREPARATION_STALE');
  expect(f.accounting.snapshot().starts).toBe(1);
  expect(f.lastProcess()!.status().alive).toBe(true);
  f.advance(360000);f.timers.at(-1)!.run();await f.worker.release!();
  expect(f.lastProcess()!.status().closed).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});

it.each(['account','source-epoch'] as const)('rejects a changed %s before a cross-turn model call and closes the retained process',async(change)=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  const process=f.lastProcess();
  f.state.turnKey='next';f.state.generation=1;f.worker.updateRetentionState!({...f.state});
  const next=pairedSource(1);next.currentTurnId='next';next.turnKey='next';next.baseKey='next-base';
  next.boundary={currentTurnId:'next',currentStartOffset:300,watermark:400,completed:{turnId:'current',endOffset:300}};
  if(change==='account')f.changeBinding();else next.sourceEpoch=2;
  await expect(f.worker.prepareNativeTurnContext!(input,next,signal,'source',1,0)).rejects.toThrow(change==='account'?'SESSION_BINDING_CHANGED':'NATIVE_SOURCE_GENERATION_CHANGED');
  expect(process!.status().closed).toBe(true);expect(f.accounting.snapshot().starts).toBe(1);
 }finally{await f.worker.close();await f.accounting.close();}
});

it('allows two paired workers concurrently without cross-conversation imports or retirement',async()=>{
 const a=await retainedNativeFixture(),b=await retainedNativeFixture(),signal=new AbortController().signal;
 b.state.conversationKey='second';b.worker.updateRetentionState!({...b.state});
 const right=pairedSource(1);right.identity='second-file';right.baseKey='second-base';
 right.supplement=history([{id:'b',kind:'user',turnId:'current',atMs:1,text:'SECOND-PRIVATE-MARKER'}]);
 try{
  const [ap,bp]=await Promise.all([a.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0),b.worker.prepareNativeTurnContext!(input,right,signal,'second',0,0)]);
  const results=await Promise.all([a.worker.observe(ap.input,signal,'source',0),b.worker.observe(bp.input,signal,'second',0)]);
  expect(results.map(x=>x.status)).toEqual(['interpreted','interpreted']);
  await Promise.all([a.release(),b.release()]);
  expect(JSON.stringify(a.imports)).not.toContain('SECOND-PRIVATE-MARKER');expect(JSON.stringify(b.imports)).not.toContain('CURRENT-0');
  a.worker.updateRetentionState!({...a.state,running:false});await a.worker.release!();
  expect(a.lastProcess()!.status().closed).toBe(true);expect(b.lastProcess()!.status().alive).toBe(true);
 }finally{await a.worker.close();await b.worker.close();await a.accounting.close();await b.accounting.close();}
});

it('records a late child fork before cancellation and never admits its ETA',async()=>{
 const controller=new AbortController();
 const f=await retainedNativeFixture(undefined,{onForkRecorded:id=>{if(id==='fork-2')controller.abort();}});
 try{
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(1),controller.signal,'source',0,0)).rejects.toThrow();
  expect(f.forks).toEqual(['fork-1','fork-2']);expect(f.accounting.snapshot().starts).toBe(0);
  await f.worker.close();expect(f.lastProcess()!.status().closed).toBe(true);expect(f.worker.status().cleanupPending).toBe(false);
 }finally{await f.worker.close();await f.accounting.close();}
});

it('preserves unresolved paired resources after cleanup failure and denies further preparation',async()=>{
 let failCleanup=false;const f=await retainedNativeFixture(undefined,{beforeResourceRelease:()=>{if(failCleanup)throw Error('SYNTHETIC_CLEANUP_FAILURE');}}),signal=new AbortController().signal;
 try{
  const p=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  expect((await f.worker.observe(p.input,signal,'source',0)).status).toBe('interpreted');await f.release();
  failCleanup=true;f.worker.updateRetentionState!({...f.state,running:false});
  await expect(f.worker.release!()).rejects.toThrow();
  expect(f.lastProcess()!.status().closed).toBe(true);expect(f.worker.status().cleanupPending).toBe(true);
  await expect(f.worker.prepareNativeTurnContext!(input,pairedSource(2),signal,'source',0,0)).rejects.toThrow();
  expect(f.accounting.snapshot().knownTokens).toBe(110);
 }finally{failCleanup=false;await f.worker.close();await f.accounting.close();}
});

it('rejects a paired source that changes after preparation without dispatching ETA',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal,source=pairedSource(1);let valid=true;
 source.validate=async()=>{if(!valid)throw Error('SOURCE_CHANGED');};
 try{
  const prepared=await f.worker.prepareNativeTurnContext!(input,source,signal,'source',0,0);valid=false;
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('process_error');
  expect(f.notifications.some(value=>(value as {method:string}).method==='thread/tokenUsage/updated')).toBe(false);
 }finally{await f.worker.close();}
});

it('never runs a second ETA on the same prepared child, even before release',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareNativeTurnContext!(input,pairedSource(1),signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('invalid_input');
  expect(f.accounting.snapshot().knownTokens).toBe(110);
 }finally{await f.worker.close();}
});

it('rejects raw history before starting a checkpoint-only recovery session',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const snapshot=history([{id:'all',kind:'user',atMs:0,turnId:'current',text:'RAW-HISTORY'}]);
  await expect(f.worker.prepareNativeHistoryFallback!(input,{snapshot,currentTurnId:'current',validate:async()=>{}},
   signal,'source',0,0,undefined,{checkpointOnly:true})).rejects.toThrow('CHECKPOINT_REQUIRED');
  expect(f.processes()).toBe(0);expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});

it.each(['before-prepare','before-observe'] as const)('denies checkpoint recovery after an interior file rewrite: %s',async phase=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 const root=join(f.receipts,'source'),directory=join(root,'2026','09','18');await mkdir(directory,{recursive:true});
 const id='22222222-2222-4222-8222-222222222222',path=join(directory,`rollout-2026-09-18-${id}.jsonl`);
 const original=[{type:'session_meta',payload:{id}},
  {type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'opaque'},
   {type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(2*1024*1024)}]}]}},
  {type:'response_item',payload:{type:'message',role:'user',turn_id:'current',content:[{type:'input_text',text:'current request'}]}}
 ].map(row=>JSON.stringify({timestamp:'2026-09-18T00:00:00Z',...row})).join('\n')+'\n';
 await writeFile(path,original);const reader=createLocalSessionReader({root});let snapshot;
 const mutate=()=>writeFile(path,original.slice(0,1024*1024)+'y'+original.slice(1024*1024+1));
 try{
  snapshot=await reader.snapshot(id,signal);
  const verified=await verifyHistoryFallback({snapshot,currentTurnId:'current'},signal,async s=>s.throwIfAborted());
  if(phase==='before-prepare'){
   await mutate();
   await expect(f.worker.prepareNativeHistoryFallback!(input,verified,signal,'source',0,0,undefined,{checkpointOnly:true})).rejects.toMatchObject({code:'source_identity_mismatch'});
   expect(f.processes()).toBe(0);
  }else{
   const prepared=await f.worker.prepareNativeHistoryFallback!(input,verified,signal,'source',0,0,undefined,{checkpointOnly:true});
   await mutate();expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('process_error');
  }
  expect(f.modelInputs).toHaveLength(0);expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await snapshot?.close();await reader.close();await f.worker.close();await f.accounting.close();}
});

it('imports a checkpoint and a large complete suffix without running compression',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;
 try{
  const text='CURRENT-DELTA-'.repeat(16000);
  const snapshot=history([{id:'all',kind:'user',atMs:0,turnId:'current',text}]);
  snapshot.checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[
   {type:'compaction',encrypted_content:'opaque-checkpoint'},
   {type:'message',role:'user',content:[{type:'input_text',text:'HISTORICAL-FACT'}]}]}})!;
  const prepared=await f.worker.prepareNativeHistoryFallback!(input,{snapshot,currentTurnId:'current',validate:async()=>{}},
   signal,'source',0,0,undefined,{checkpointOnly:true});
  expect(prepared.representation).toMatchObject({checkpointBootstrapped:true,confirmedCompactions:0,sourceComplete:true});
  const imported=(f.imports as Array<{items:Array<{type:string;encrypted_content?:string;content?:Array<{text?:string}>}>}>).flatMap(call=>call.items);
  expect(imported.some(item=>item.type==='compaction'&&item.encrypted_content==='opaque-checkpoint')).toBe(true);
  expect(JSON.stringify(imported)).toContain('HISTORICAL-FACT');
  const fragments=imported.flatMap(item=>item.content??[]).flatMap(part=>{
   try{const data=JSON.parse(part.text??'');return data.observedRecord?[data.observedRecord.text]:[];}catch{return [];}
  }).join('');
  expect(JSON.parse(fragments).text).toBe(text);
  expect(f.accounting.snapshot().starts).toBe(0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.accounting.snapshot()).toMatchObject({starts:1,knownTokens:110,unknown:0});
 }finally{await f.worker.close();await f.accounting.close();}
});

it('prepares verified fallback history in a clean accounted session, never a failed native child',async()=>{
 const f=await retainedNativeFixture(),signal=new AbortController().signal;let valid=true;
 try{
  const snapshot=history([{id:'all',kind:'user',atMs:0,turnId:'current',text:'COMPLETE-HISTORY'}]);
  const prepared=await f.worker.prepareNativeHistoryFallback!(input,{snapshot,currentTurnId:'current',validate:async()=>{if(!valid)throw Error('STALE');}},signal,'source',0,0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.accounting.snapshot().knownTokens).toBe(110);expect(f.forks).toEqual([]);
  expect(JSON.stringify(f.imports)).toContain('COMPLETE-HISTORY');
  await f.release();expect(f.worker.status().nativeLifecycle?.requests).toBe(1);
  valid=false;
  await expect(f.worker.prepareNativeHistoryFallback!(input,{snapshot,currentTurnId:'current',validate:async()=>{if(!valid)throw Error('STALE');}},signal,'source',0,0)).rejects.toThrow('STALE');
  expect(f.accounting.snapshot().knownTokens).toBe(110);
 }finally{await f.worker.close();}
});

it.each([false,true])('joins real snapshot custody and worker lifecycle through three requests (crossTurn=%s)',async(crossTurn)=>{
 const root=await mkdtemp(join(tmpdir(),'hud-combined-native-')),runtimeHome=join(root,'observer-auth');
 const snapshots=join(runtimeHome,'hud-native','snapshots'),custody=join(runtimeHome,'hud-native','custody'),sessions=join(runtimeHome,'sessions');
 await mkdir(snapshots,{recursive:true});await mkdir(custody);await mkdir(sessions);
 const sourcePath=join(root,'source.jsonl'),sourceId='11111111-1111-4111-8111-111111111111';
 const original=JSON.stringify({type:'session_meta',payload:{id:sourceId,cli_version:'0.153.4'}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'previous'}})+'\n';
 await writeFile(sourcePath,original);
 let f:Awaited<ReturnType<typeof fixture>>|undefined,copies=0;const deleted:string[]=[];
 const invocation={executable:process.execPath,cwd:root,args:[],env:{CODEX_HOME:runtimeHome},input:''};
 const resources=createNativeWorkerResources({runtimeHome,maxSourceBytes:10000,
  storage:{prepare:async()=>({snapshots,custody}),verify:async()=>{}},captureController:async()=>({pid:100,creationIdentity:'controller'}),
  isExited:async identity=>identity.pid!==100&&f?.lastProcess()?.status().closed===true,
  prepareCleanupInvocation:async()=>invocation,
  cleanupProcessFactory:()=>({start:async()=>({rpc:{subscribe:()=>()=>{},notify:()=>{},call:async(method:string,params:unknown)=>{
   if(method==='initialize')return {};if(method!=='thread/delete')throw Error('UNEXPECTED_CLEANUP_RPC');
   const id=(params as {threadId:string}).threadId;if(!/^fork-[1-5]$/.test(id))throw Error('UNOWNED_DELETE');
   deleted.push(id);await unlink(join(sessions,id+'.jsonl'));return {};
  }}}),disable:()=>{},close:async()=>{}})});
 const nativeScript="const fs=require('node:fs'),path=require('node:path');"+script
  .replace("let b='',n=0;","let b='',n=0,f=0,t='';")
  .replace("if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});",
   "if(m.method==='thread/fork'){t='fork-'+(++f);n=0;const old=fs.readFileSync(m.params.path||path.join(process.env.CODEX_HOME,'sessions',m.params.threadId+'.jsonl'),'utf8');fs.writeFileSync(path.join(process.env.CODEX_HOME,'sessions',t+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:t,thread_source:m.params.threadSource}})+'\\n'+old.slice(old.indexOf('\\n')+1));emit({id:m.id,result:{thread:{id:t}}});}else if(m.method==='thread/goal/get')emit({id:m.id,result:{goal:null}});")
  .replaceAll("threadId:'t'","threadId:t");
 try{
  f=await fixture(false,{nativeContext:resources,script:nativeScript,sessionEnvironment:{...process.env,CODEX_HOME:runtimeHome},monotonicNow:()=>0,reuseFactory:()=>reusable(),scheduleIdle:()=>()=>{}});
  const state={conversationKey:'source',turnKey:'current',generation:0,running:true};f.worker.updateRetentionState!(state);
  const signal=new AbortController().signal;
  let expectedSource=original;
  for(let revision=1;revision<=3;revision++){
   if(crossTurn&&revision===3){
    f.worker.updateRetentionState!({...state,running:false,idleEligible:true});
    state.turnKey='next';state.generation=1;f.worker.updateRetentionState!(state);
    expectedSource+=JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'current'}})+'\n';
    await writeFile(sourcePath,expectedSource);
   }
   const lastTurnId=crossTurn&&revision===3?'current':'previous';
   const source={...pairedSource(revision),openBase:async(destination:import('../../src/observer/native-source-request.js').NativeSourceDestination,s:AbortSignal)=>{
    copies++;const snapshot=await createNativeSourceSnapshot({...destination,sourcePath,sourceRoot:root,sourceThreadId:sourceId,sourceEpoch:1,revision,signal:s});
    return {...snapshot,sourceTurnId:lastTurnId};
   }};
   if(crossTurn&&revision===3){
    source.currentTurnId='next';source.turnKey='next';source.baseKey='next-base';
    source.boundary={currentTurnId:'next',currentStartOffset:Buffer.byteLength(expectedSource),watermark:Buffer.byteLength(expectedSource)+100,completed:{turnId:'current',endOffset:Buffer.byteLength(expectedSource)}};
    source.supplement=history([{id:'new',kind:'user',turnId:'next',atMs:3,text:'NEW-TURN-ONLY'}]);
   }
   const prepared=await f.worker.prepareNativeTurnContext!(input,source,signal,'source',state.generation,0);
   expect((await f.worker.observe(prepared.input,signal,'source',state.generation)).status).toBe('interpreted');
   expect((await resources.usage()).requests).toBe(revision);
   if(revision<3){expect(await readdir(custody)).toHaveLength(revision+1);expect(deleted).toEqual([]);}
   await f.worker.release!(createNativeRetentionPermit({...state,idleStartedAtMs:0,nextOrdinaryAtMs:300000}));
  }
  expect(copies).toBe(crossTurn?2:1);expect(f.processes()).toBe(1);expect(deleted.sort()).toEqual(crossTurn?['fork-1','fork-2','fork-3','fork-4','fork-5']:['fork-1','fork-2','fork-3','fork-4']);
  expect(await readdir(snapshots)).toEqual([]);expect(await readdir(custody)).toEqual([]);expect(await readFile(sourcePath,'utf8')).toBe(expectedSource);
  expect(f.accounting.snapshot().knownTokens).toBe(330);expect(f.lastProcess()!.status().closed).toBe(true);
 }finally{
  await f?.worker.close();await f?.accounting.close();
  if(!root.startsWith(join(tmpdir(),'hud-combined-native-')))throw Error('UNSAFE_TEST_CLEANUP');await rm(root,{recursive:true,force:true});
 }
});
const controlledBudget=(batch=1024,reserve=32):PersistentHistoryBudget=>({trusted:true,maxSourceBytes:256*1024,maxCompactionOperations:4,contextCapacityBytes:batch+reserve,retainedSummaryReserveBytes:reserve});
const script=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){const id='r'+(++n);emit({id:m.id,result:{turn:{id}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{inputTokens:100*n,outputTokens:10*n,totalTokens:110*n,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const timeoutScript=`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'r1'}}});emit({method:'item/completed',params:{threadId:'t',turnId:'r1',item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const compactionScript=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='thread/compact/start'){const id='c'+(++n);emit({id:m.id,result:{}});emit({method:'item/started',params:{threadId:'t',turnId:id,item:{type:'contextCompaction',id:'ci'}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'contextCompaction',id:'ci'}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else if(m.method==='turn/start'){const id='r'+(++n);emit({id:m.id,result:{turn:{id}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{inputTokens:100*n,outputTokens:10*n,totalTokens:110*n,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
const failedCompactionScript=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='thread/compact/start'){const id='c'+(++n);emit({id:m.id,result:{}});emit({method:'item/started',params:{threadId:'t',turnId:id,item:{type:'contextCompaction',id:'ci'}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'failed'}}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
async function fixture(failSettlement=false,options:{inlineCurrentTurnSupplement?:boolean;nativeRequestByteLimit?:number;sessionEnvironment?:NodeJS.ProcessEnv;onNativeTurnTiming?:(event:import('../../src/estimation/native-turn-timing.js').NativeTurnTiming)=>void;scheduleIdle?:(callback:()=>void,delay:number)=>()=>void;monotonicNow?:()=>number;reuseFactory?:()=>TestReuse;invalidateSessionReuse?:()=>void;onContextPhase?:(phase:string)=>void;nativeContext?:unknown;script?:string;sessionTimeoutMs?:number;receiptFailure?:boolean;compactionReceiptFailure?:boolean;compactionCloseFailure?:boolean;abortOnUpdate?:()=>void;bootstrapBatchByteCapacity?:number;retainedSummaryReserveBytes?:number;retainedSummaryByteReserve?:number;historyBudget?:PersistentHistoryBudget}={}){
 let accountFingerprint='a'.repeat(64);
 const preparationPolicies:unknown[]=[];
 new Script(script);
 const dir=await mkdtemp(join(tmpdir(),'hud-persistent-worker-'));await mkdir(join(dir,'ledger'));
 const accounting=await openReleaseAccounting(join(dir,'ledger'),Date.now);let processes=0,preparations=0,authorized=true,settlementAttempts=0,activeListeners=0;const notifications:unknown[]=[];const imports:unknown[]=[];const modelInputs:unknown[]=[];let lastProcess:ReturnType<typeof createObserverSessionProcess>|undefined;
 let accountUpdated=async()=>{};
 if(failSettlement){const original=accounting.forConversation.bind(accounting);accounting.forConversation=key=>{const v=original(key);return {...v,settle:async()=>{settlementAttempts++;throw Error('simulated storage failure');}};};}
 if(options.abortOnUpdate){const original=accounting.forConversation.bind(accounting);accounting.forConversation=key=>{const v=original(key);const update=v.updateInvocation as ((...args:any[])=>Promise<unknown>)|undefined;return {...v,updateInvocation:async(...args:any[])=>{options.abortOnUpdate?.();return update?.(...args);}} as any;};}
 const baseJournal=createPersistentReceiptJournal(join(dir,'receipts'));
 const receiptJournalFactory=options.receiptFailure?()=>({...baseJournal,usageSnapshot:async()=>{throw Error('private journal detail');}}):options.compactionReceiptFailure?()=>({...baseJournal,operationTerminal:async()=>{throw Error('private journal detail');}}):undefined;
 const worker=createPersistentObserverWorker({...({nativeInstructions:'trusted full observer policy',onContextPhase:options.onContextPhase,nativeContext:options.nativeContext,accounting,authorize:()=>authorized,now:Date.now,outputSchema:{type:'object'},receiptDirectory:join(dir,'receipts'),sessionTimeoutMs:options.sessionTimeoutMs,bootstrapBatchByteCapacity:options.bootstrapBatchByteCapacity,retainedSummaryByteReserve:options.retainedSummaryByteReserve,historyBudget:options.historyBudget,receiptJournalFactory,
   completedTurnContext:true,reuseNativeTurnSession:Reflect.get(options,'reuseNativeTurnSession'),inlineCurrentTurnSupplement:options.inlineCurrentTurnSupplement,nativeRequestByteLimit:options.nativeRequestByteLimit,onNativeTurnTiming:options.onNativeTurnTiming,invalidateSessionReuse:options.invalidateSessionReuse,monotonicNow:options.monotonicNow,scheduleIdle:options.scheduleIdle,
   prepareSession:async(_signal:AbortSignal,policy:unknown)=>{preparations++;preparationPolicies.push(policy);const expectedAccount=accountFingerprint;return {validateAcceptance:async()=>accountFingerprint===expectedAccount,reuse:options.reuseFactory?.(),invocation:{executable:process.execPath,cwd:process.cwd(),env:options.sessionEnvironment??process.env,args:['-e',options.script??script],input:''},binding:{accountFingerprint,routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)}};},
   processFactory:()=>{processes++;const p=createObserverSessionProcess({captureIdentity:async()=> '123'});lastProcess=p;const start=p.start;const close=p.close;return {...p,start:async(i:any)=>{const r=await start(i);r.rpc.subscribe(n=>notifications.push(n));const subscribe=r.rpc.subscribe;r.rpc.subscribe=listener=>{activeListeners++;const stop=subscribe(listener);let stopped=false;return()=>{if(!stopped){stopped=true;activeListeners--;stop();}};};const call=r.rpc.call;accountUpdated=async()=>{await call('test/account_updated',{});};r.rpc.call=(m,p)=>{if(m==='thread/inject_items')imports.push(p);if(m==='turn/start')modelInputs.push(p);return call(m,p);};return r;},close:async()=>{if(options.compactionCloseFailure&&preparations>1)throw Error('simulated close failure');return close();}};}} as any)});
 return {accounting,worker,notifications,imports,modelInputs,preparationPolicies,accountUpdated:()=>accountUpdated(),activeListeners:()=>activeListeners,changeBinding:()=>{accountFingerprint='d'.repeat(64);},settlementAttempts:()=>settlementAttempts,preparations:()=>preparations,processes:()=>processes,lastProcess:()=>lastProcess,receipts:join(dir,'receipts'),revoke:()=>{authorized=false;}};
}
function history(records:ConversationRecord[],epoch=0):HistorySnapshot{
 return {identity:'local-only-source-identity',sourceEpoch:epoch,revision:records.length,coverage:{complete:true,gaps:[]},
   async *records(){for(const [ordinal,record]of records.entries())yield {ordinal,record};},close:async()=>{}};
}
it('uses native fork preparation with existing accounting and cleans only after owned process exit',async()=>{
 const lifecycle:string[]=[];
 const nativeScript=script.replace("m.method==='thread/start'","m.method==='thread/fork'")
  .replace("const m=JSON.parse(b.slice(0,i));",`const m=JSON.parse(b.slice(0,i));if(m.method==='thread/fork'&&m.params.baseInstructions!==${JSON.stringify('trusted full observer policy'+'\n'+nativePreservationInstructions)})process.exit(42);`)
  .replace("else if(m.method==='turn/start')","else if(m.method==='thread/goal/get')emit({id:m.id,result:{goal:null}});else if(m.method==='turn/start')");
 const nativeContext={destination:async()=>({destinationDirectory:'C:/protected',maxSourceBytes:10000,verifyDestination:async()=>{}}),
  claim:async()=>({tag:'hud_native_6a0beb2d-8d08-436a-95ba-17f6b721c989',recordFork:async(id:string)=>{lifecycle.push(`fork:${id}`);},
   afterProcessClosed:async()=>{expect(f.lastProcess()!.status().closed).toBe(true);lifecycle.push('cleanup');}})};
 let localGuards=0;
 const issuer=createSessionAccountReuseIssuer({now:()=>1000,monotonicNow:()=>20});
 const f=await fixture(false,{script:nativeScript,nativeContext,reuseFactory:()=>issuer.issue({observedAt:1000,observedMonotonic:20,
  expiresAt:301000,validateLocal:async()=>{localGuards++;return true;}})}),signal=new AbortController().signal;
 const snapshot={kind:'native' as const,sourceThreadId:'original',sourceTurnId:'current',sourceEpoch:1,revision:2,byteLength:100,
  path:'C:/protected/snapshot',close:async()=>{expect(f.lastProcess()!.status().closed).toBe(true);lifecycle.push('snapshot-close');}};
 try{
  let samples=0;
  const prepared=await f.worker.prepareNativeContext!(input,{snapshot,currentTurnId:'current'},signal,'source',0,0,()=>{
   expect(lifecycle).toEqual(['fork:t']);samples++;
   return {activeSeconds:40,runtime:'running',requestActiveSeconds:10};
  });
  expect(samples).toBe(1);expect(prepared.input).toMatchObject({activeSeconds:40,nativeTiming:{requestActiveSeconds:10}});
  expect(f.imports).toEqual([]);expect(f.accounting.snapshot().starts).toBe(0);
  expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
  expect(f.accounting.snapshot()).toMatchObject({starts:1,knownTokens:110});
  expect(f.preparations()).toBe(1);expect(localGuards).toBe(2);
  expect(f.preparationPolicies).toEqual([{accountCache:'allow'}]);
  expect(lifecycle).toEqual(['fork:t']);
  await f.worker.release!();expect(lifecycle).toEqual(['fork:t','cleanup','snapshot-close']);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('cannot silently start a history session after native prepared account binding changes',async()=>{
 const nativeScript=script.replace("m.method==='thread/start'","m.method==='thread/fork'")
  .replace("else if(m.method==='turn/start')","else if(m.method==='thread/goal/get')emit({id:m.id,result:{goal:null}});else if(m.method==='turn/start')");
 const nativeContext={destination:async()=>({destinationDirectory:'C:/protected',maxSourceBytes:10000,verifyDestination:async()=>{}}),
  claim:async()=>({tag:'hud_native_6a0beb2d-8d08-436a-95ba-17f6b721c989',recordFork:async()=>{},afterProcessClosed:async()=>{}})};
 const f=await fixture(false,{script:nativeScript,nativeContext}),signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareNativeContext!(input,{snapshot:{kind:'native',sourceThreadId:'original',sourceTurnId:'current',sourceEpoch:1,revision:2,
   byteLength:100,path:'C:/protected/snapshot',close:async()=>{}},currentTurnId:'current'},signal,'source',0,0);
  f.changeBinding();expect((await f.worker.observe(prepared.input,signal,'source',0)).status).not.toBe('interpreted');
  expect(f.processes()).toBe(1);expect(f.accounting.snapshot().starts).toBe(0);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('holds the worker busy until native destination resources are released even before a fork',async()=>{
 let finish!:()=>void,releaseCount=0;
 const nativeContext={destination:async()=>({destinationDirectory:'C:/protected',maxSourceBytes:10000,verifyDestination:async()=>{}}),
  claim:async()=>{throw Error('UNEXPECTED_FORK');},release:async()=>{releaseCount++;if(releaseCount===1)await new Promise<void>(resolve=>{finish=resolve;});}};
 const f=await fixture(false,{nativeContext}),signal=new AbortController().signal;
 try{
  await f.worker.nativeSourceDestination!(signal);
  const releasing=f.worker.release!();await new Promise<void>(resolve=>setImmediate(resolve));
  expect(releaseCount).toBe(1);expect(f.worker.status().active).toBe(true);
  expect((await f.worker.observe(input,signal,'source',0)).status).toBe('busy');
  const joined=f.worker.release!();finish();await Promise.all([releasing,joined]);
  expect(releaseCount).toBe(1);expect(f.worker.status().active).toBe(false);expect(f.processes()).toBe(0);
 }finally{finish?.();await f.worker.close();await f.accounting.close();}
});
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
 ['IMAGE_PATH_REJECTED','IMAGE_PATH_REJECTED'],
 ['IMAGE_READ_FAILED','IMAGE_READ_FAILED'],
 ['IMAGE_FORMAT_UNSUPPORTED','IMAGE_FORMAT_UNSUPPORTED'],
 ['IMAGE_CAPACITY_EXCEEDED','IMAGE_CAPACITY_EXCEEDED'],
 ['NATIVE_REQUEST_TOO_LARGE','NATIVE_REQUEST_TOO_LARGE'],
 ['APP_SERVER_RPC_ERROR private payload','PREPARATION_UNKNOWN'],
 ['context_too_large:private payload','context_too_large'],
 ['private credentials','PREPARATION_UNKNOWN'],
])('records only allowlisted preparation errors: %s',(message,expected)=>{
 expect(preparationErrorCode(Error(message))).toBe(expected);
});
it.each([85*1024,1024*1024].flatMap(targetBytes=>[0,1,2].flatMap(index=>['fresh-history','supplement-only'].map(mode=>({targetBytes,index,mode})))))('characterizes complete comparison imports without a remote model ($targetBytes bytes, point $index, $mode)',async({targetBytes,index,mode})=>{
 const policy=persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:null,source:'configured'});
 const f=await fixture(false,{script:compactionScript,...policy}),signal=new AbortController().signal;
 const sourceThreadId='77777777-7777-4777-8777-777777777777';
 const source=createCompletedTurnComparisonFixtures({sourceThreadId,cwd:process.cwd(),targetBytes})[index]!;
 const root=join(f.receipts,'synthetic-source'),day=join(root,'2026','09','14');
 await mkdir(day,{recursive:true});await writeFile(join(day,`rollout-2026-09-14T12-00-00-${sourceThreadId}.jsonl`),source.rollout);
 const reader=createLocalSessionReader({root});
 let snapshot:HistorySnapshot|undefined;
 let paired:Awaited<ReturnType<typeof reader.openNativeTurn>>|undefined;
 try{
  if(mode==='supplement-only'){
   await reader.read(sourceThreadId,signal);
   paired=await reader.openNativeTurn(sourceThreadId,signal);
   expect(paired.boundary.completed?.turnId).toBe(source.lastCompletedTurnId);
   snapshot=paired.supplement;
  }else snapshot=await reader.snapshot(sourceThreadId,signal);
  let expectedRecords=0;for await(const row of snapshot.records(signal))expectedRecords++;
  const prepared=await f.worker.prepareContext!(input,{snapshot,currentTurnId:source.currentTurnId},signal,'comparison-import',0,0);
  expect(prepared.representation.sourceComplete).toBe(true);
  expect(prepared.representation.importedRecords).toBe(expectedRecords);
  const compactions=prepared.representation.confirmedCompactions!;
  expect(compactions).toBeLessThanOrEqual(16);
  expect(f.accounting.snapshot()).toMatchObject({knownTokens:0,unknown:compactions,unresolved:0});
  const receipts=(await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(receipts.filter(row=>row.kind==='operation'&&row.operationKind!=='context_compression')).toEqual([]);
  process.stdout.write('LOCAL_IMPORT_SIZING '+JSON.stringify({targetBytes,index,mode,records:expectedRecords,compactions,importedEncodedBytes:prepared.representation.importedEncodedBytes,remoteCalls:0})+'\n');
 }finally{if(paired)await paired.close();else await snapshot?.close();await reader.close();await f.worker.close();await f.accounting.close();}
},30000);
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
it('continues after completed compressions with unverifiable runtime placeholder usage',async()=>{
 const zero={totalTokens:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0};
 const notification={method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:'c1',tokenUsage:{total:zero,last:{...zero,totalTokens:102241}}}};
 const simulated=compactionScript.replace("const id='c'+(++n);",`const id='c'+(++n);const notice=${JSON.stringify(notification)};notice.params.turnId=id;emit(notice);`);
 const policy=persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:null,source:'configured'});
 const f=await fixture(false,{script:simulated,...policy}),signal=new AbortController().signal;
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'tail',turnId:'t',kind:'user',atMs:1,text:'retained history '.repeat(40000)}]),currentTurnId:'t'},signal,'source',0,0);
   expect(prepared.representation.confirmedCompactions).toBeGreaterThanOrEqual(4);
   expect(f.accounting.snapshot().knownTokens).toBe(0);
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
   expect(f.accounting.snapshot().unknown).toBeGreaterThanOrEqual(4);
   const receipts=(await readFile(join(f.receipts,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   expect(receipts.some(row=>row.kind==='usage_snapshot'&&row.last.totalTokens===102241)).toBe(true);
 }finally{await f.worker.close();await f.accounting.close();}
});
it('continues with a missing-image marker and honest incomplete representation',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const record:ConversationRecord={id:'missing',turnId:'t',kind:'user',atMs:1,text:'inspect',contentParts:[
   {type:'text',text:'inspect'},{type:'local_image',path:join(f.receipts,'absent-image.png')}]};
 try{
   const prepared=await f.worker.prepareContext!(input,{snapshot:history([record]),currentTurnId:'t'},signal,'source',0,0);
   expect(prepared.representation).toMatchObject({sourceComplete:false,mode:'incomplete',missingImages:1,inferenceEligible:true,sourceGaps:['missing_image']});
   const imported=f.imports.at(-1) as any;
   expect(imported.items[0].content.at(-1).text).toContain('image content unavailable');
   expect(JSON.stringify(imported)).not.toContain('absent-image.png');
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('interpreted');
 }finally{await f.worker.close();await f.accounting.close();}
});
it('delivers post-checkpoint embedded image content natively without duplicate text projection',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const imageUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=';
 const record:ConversationRecord={id:'image',turnId:'t',kind:'user',atMs:1,text:'beforeafter',contentParts:[
   {type:'text',text:'before'},{type:'input_image',imageUrl},{type:'text',text:'after'}]};
 const checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'synthetic-checkpoint'}]}})!;
 try{
   await f.worker.prepareContext!(input,{snapshot:{...history([record]),checkpoint},currentTurnId:'t'},signal,'source',0,0);
   const imported=f.imports.at(-1) as any;
   expect(imported.items[0].content.slice(1)).toEqual([
     {type:'input_text',text:'before'},{type:'input_image',image_url:imageUrl},{type:'input_text',text:'after'}]);
   expect(imported.items[0].content[0].text).not.toContain('beforeafter');
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
   expect((await f.worker.observe(prepared.input,signal,'source',0)).status).toBe('invalid_input');
   expect(f.accounting.snapshot().starts).toBe(0);
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

it('keeps all estimated-compaction usage unknown while accounting only the following ETA from a zero cumulative sample',async()=>{
 const peer=compactionScript.replace("emit({method:'item/completed'",
  "emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{totalTokens:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{totalTokens:52505,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'item/completed'")
  .replaceAll('100*n','100').replaceAll('10*n','10').replaceAll('110*n','110');
 const f=await fixture(false,{script:peer,bootstrapBatchByteCapacity:1024,retainedSummaryByteReserve:32,historyBudget:controlledBudget()});
 const signal=new AbortController().signal;
 try{
  const prepared=await f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},signal,'source',0,0);
  const before=f.accounting.snapshot();expect(before.unknown).toBeGreaterThan(0);expect(before.knownTokens).toBe(0);
  const result=await f.worker.observe(prepared.input,signal,'source',0);
  expect(result.status).toBe('interpreted');expect(result.usage).toMatchObject({inputTokens:100,outputTokens:10});
  expect(f.accounting.snapshot()).toMatchObject({knownTokens:110,unknown:before.unknown,starts:before.starts+1,inFlight:0,unresolved:0});
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
 let invalidations=0;
 const f=await fixture(false,{script:failedCompactionScript,compactionCloseFailure:true,bootstrapBatchByteCapacity:1024,historyBudget:controlledBudget(),invalidateSessionReuse:()=>{invalidations++;}});
 try{
   await expect(f.worker.prepareContext!(input,{snapshot:history([{id:'large',turnId:'t',kind:'user',atMs:1,text:'history '.repeat(180)}]),currentTurnId:'t'},new AbortController().signal,'source',0,0)).rejects.toThrow();
   expect(f.worker.status().poisoned).toBe(true);
   expect(invalidations).toBeGreaterThan(0);
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
