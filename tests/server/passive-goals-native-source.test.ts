import {expect,it} from 'vitest';
import {PassiveGoals,type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {OpenNativeSourceResult,BoundNativeTurnSource} from '../../src/observer/native-source-request.js';

const destination={destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}};
function fixture(userFingerprint?:string,withMeasurement=false){
 let epoch=1,measurementEpoch=1,closed=0,opens=0;
 let resolve!:(value:OpenNativeSourceResult)=>void;
 const contexts=new PassiveContextStore();
 const source:GoalContextSource={epoch:()=>epoch,...(withMeasurement?{measurementEpoch:()=>measurementEpoch}:{}),read:()=>({epoch,revision:1,currentActionId:null,finalAvailable:false,...(userFingerprint===undefined?{}:{userFingerprint}),
  input:{goalSummary:null,activeSeconds:0,runtime:'running',truncated:false,messages:[{kind:'user',text:'synthetic task',truncated:false}]}}),
  openHistory:async()=>{throw Error('PARSED_HISTORY_FORBIDDEN');},
  openNativeSource:async(_key,_turn,_signal,target)=>{
   expect(target).toBe(destination);opens++;return new Promise<OpenNativeSourceResult>(r=>{resolve=r;});
  }};
 const goals=new PassiveGoals(contexts,source);
 const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'one'},0,'protected-native-source-key-1234567890').envelope;
 envelope.content={kind:'user',text:'synthetic task',truncated:false};
 contexts.ingest(envelope,0);goals.observe(envelope,true,0);
 const request=goals.request(envelope.sessionKey,1000)!;
 const result:OpenNativeSourceResult={currentTurnId:'one',snapshot:{kind:'native',sourceThreadId:'source',sourceEpoch:1,revision:1,
  path:'C:/owned/native',byteLength:100,close:async()=>{closed++;}}};
 return {goals,contexts,source,envelope,request,result,resolve:()=>resolve(result),changeEpoch:()=>{epoch++;},changeMeasurement:()=>{measurementEpoch++;},
  counts:()=>({closed,opens}),pause:()=>goals.runtime(envelope.sessionKey,envelope.turnKey!,'paused',1100)};
}

function pairedSource(validate=async()=>{}):BoundNativeTurnSource {
 return {identity:'source',sourceEpoch:1,revision:1,currentTurnId:'one',turnKey:'one',baseKey:'base',
  boundary:{currentTurnId:'one',currentStartOffset:0,watermark:100,completed:null},
  supplement:{identity:'source',sourceEpoch:1,revision:1,coverage:{complete:true,gaps:[]},async *records(){},close:async()=>{}},
  validate,openBase:async()=>null,close:async()=>{}};
}
const numericAnswer={relation:'replace',status:'running',summary:'task',estimate:{remainingSeconds:60,errorPercent:30}};

it('raw validation re-attests a display/pace epoch change without weakening turn or file identity',async()=>{
 const f=fixture('same-user',true),signal=new AbortController().signal;
 let validations=0;f.source.openNativeTurn=async()=>pairedSource(async()=>{validations++;});
 const capture=await f.goals.openNativeTurn(f.request.ticket,signal);
 await capture!.validate(signal);f.changeMeasurement();
 expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(false);
 await capture!.validate(signal);
 expect(validations).toBe(2);expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(true);
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(true);
});

it.each(['without-validation','changed-again'] as const)('does not accept projection changes %s',async mode=>{
 const f=fixture('same-user',true),signal=new AbortController().signal;
 f.source.openNativeTurn=async()=>pairedSource();const capture=await f.goals.openNativeTurn(f.request.ticket,signal);
 f.changeMeasurement();if(mode==='changed-again'){await capture!.validate(signal);f.changeMeasurement();}
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
 expect(f.goals.rejectionReason(f.request.ticket)).toBe('measurement_epoch_changed');
});

it('parsed-only requests remain fenced by projection measurement epoch',()=>{
 const f=fixture('same-user',true);f.changeMeasurement();
 expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(false);
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
 expect(f.goals.rejectionReason(f.request.ticket)).toBe('measurement_epoch_changed');
});

it.each([false,true])('missing measurement provenance is not equality with missing native proof: native=%s',async native=>{
 const f=fixture('same-user',true);
 if(native){f.source.openNativeTurn=async()=>pairedSource();await f.goals.openNativeTurn(f.request.ticket,new AbortController().signal);}
 delete f.source.measurementEpoch;
 expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(false);
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
 expect(f.goals.rejectionReason(f.request.ticket)).toBe('measurement_epoch_changed');
});

it.each([false,true])('cannot replace an aborted acquisition signal with a fresh validation signal: projectionChanged=%s',async projectionChanged=>{
 const f=fixture('same-user',true),acquisition=new AbortController();let validations=0;
 f.source.openNativeTurn=async()=>pairedSource(async()=>{validations++;});
 const capture=await f.goals.openNativeTurn(f.request.ticket,acquisition.signal);
 await capture!.validate(new AbortController().signal);if(projectionChanged)f.changeMeasurement();acquisition.abort();
 await expect(capture!.validate(new AbortController().signal)).rejects.toMatchObject({name:'AbortError'});
 expect(validations).toBe(1);expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
});

it.each([false,true])('failed revalidation revokes the prior native proof: projectionChanged=%s',async projectionChanged=>{
 const f=fixture('same-user',true),signal=new AbortController().signal;let invalid=false;
 f.source.openNativeTurn=async()=>pairedSource(async()=>{if(invalid)throw Object.assign(Error('bad bytes'),{code:'source_identity_mismatch'});});
 const capture=await f.goals.openNativeTurn(f.request.ticket,signal);if(projectionChanged)f.changeMeasurement();await capture!.validate(signal);invalid=true;
 await expect(capture!.validate(signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
 expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(false);
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
});

it('first validation failure invalidates only its ticket and permits a fresh validated request',async()=>{
 const f=fixture('same-user',true),signal=new AbortController().signal;let invalid=true;
 f.source.openNativeTurn=async()=>pairedSource(async()=>{if(invalid)throw Object.assign(Error('bad bytes'),{code:'source_identity_mismatch'});});
 const capture=await f.goals.openNativeTurn(f.request.ticket,signal);
 await expect(capture!.validate(signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
 expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(false);
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
 expect(f.goals.rejectionReason(f.request.ticket)).toBe('source_not_ready');
 invalid=false;
 const fresh=f.goals.request(f.envelope.sessionKey,3000);expect(fresh).not.toBeNull();
 const next=await f.goals.openNativeTurn(fresh!.ticket,signal);await next!.validate(signal);
 expect(f.goals.isTicketValid(fresh!.ticket,4000)).toBe(true);
 expect(f.goals.settle(fresh!.ticket,numericAnswer,4000)).toBe(true);
 await capture!.close();await next!.close();
});

it.each([false,true])('older successful validation cannot resurrect a failed ticket: projectionChanged=%s',async projectionChanged=>{
 const f=fixture('same-user',true),signal=new AbortController().signal;
 let mode:'valid'|'pending'|'invalid'='valid',release!:()=>void;
 f.source.openNativeTurn=async()=>pairedSource(async()=>{
  if(mode==='invalid')throw Object.assign(Error('bad bytes'),{code:'source_identity_mismatch'});
  if(mode==='pending')await new Promise<void>(resolve=>{release=resolve;});
 });
 const capture=await f.goals.openNativeTurn(f.request.ticket,signal);
 if(projectionChanged)f.changeMeasurement();await capture!.validate(signal);
 mode='pending';const older=capture!.validate(signal);
 mode='invalid';await expect(capture!.validate(signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
 release();await expect(older).rejects.toMatchObject({code:'GOAL_TICKET_STALE'});
 expect(f.goals.isTicketValid(f.request.ticket,2000)).toBe(false);
 expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
 await capture!.close();
});

it.each(['source','pause','abort','foreign-turn'] as const)('raw proof cannot cross %s boundary',async boundary=>{
 const f=fixture('same-user',true),controller=new AbortController();f.source.openNativeTurn=async()=>pairedSource();
 const capture=await f.goals.openNativeTurn(f.request.ticket,controller.signal);f.changeMeasurement();
 if(boundary==='source')f.changeEpoch();else if(boundary==='pause')f.pause();else if(boundary==='abort')controller.abort();
 else {const e=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'two'},1500,'protected-native-source-key-1234567890').envelope;e.content={kind:'user',text:'different task',truncated:false};f.contexts.ingest(e,1500);f.goals.observe(e,true,1500);}
 await expect(capture!.validate(controller.signal)).rejects.toBeDefined();expect(f.goals.settle(f.request.ticket,numericAnswer,2000)).toBe(false);
});

it('opens native input only for a current opaque goal ticket',async()=>{
 const f=fixture();
 await expect(f.goals.openNativeSource({},new AbortController().signal,destination)).rejects.toMatchObject({code:'GOAL_TICKET_STALE'});
 expect(f.counts().opens).toBe(0);
 const pending=f.goals.openNativeSource(f.request.ticket,new AbortController().signal,destination);
 f.resolve();expect(await pending).toBe(f.result);expect(f.counts()).toEqual({closed:0,opens:1});
});

it.each(['waiting','paused'] as const)('paired validation rejects %s after acquisition',async runtime=>{
 const f=fixture(),signal=new AbortController().signal;
 const source:BoundNativeTurnSource={identity:'source',sourceEpoch:1,revision:1,currentTurnId:'one',turnKey:'one',baseKey:'base',
  boundary:{currentTurnId:'one',currentStartOffset:0,watermark:100,completed:null},
  supplement:{identity:'source',sourceEpoch:1,revision:1,coverage:{complete:true,gaps:[]},async *records(){},close:async()=>{}},
  validate:async()=>{},openBase:async()=>null,close:async()=>{}};
 f.source.openNativeTurn=async()=>source;
 const capture=await f.goals.openNativeTurn(f.request.ticket,signal);expect(capture).not.toBeNull();
 await capture!.validate(signal);
 f.goals.runtime(f.envelope.sessionKey,f.envelope.turnKey!,runtime,1100);
 await expect(capture!.validate(signal)).rejects.toMatchObject({code:'GOAL_TICKET_STALE'});
});

it.each(['epoch','pause','abort'] as const)('disposes native input invalidated during copy: %s',async invalidation=>{
 const f=fixture(),controller=new AbortController();
 const pending=f.goals.openNativeSource(f.request.ticket,controller.signal,destination);
 if(invalidation==='epoch')f.changeEpoch();else if(invalidation==='pause')f.pause();else controller.abort();
 f.resolve();await expect(pending).rejects.toMatchObject({code:'GOAL_TICKET_STALE'});
 expect(f.counts()).toEqual({closed:1,opens:1});
});

it('samples the native clock once before inference, not at result arrival',async()=>{
 const f=fixture();const pending=f.goals.openNativeSource(f.request.ticket,new AbortController().signal,destination);
 f.resolve();await pending;
 expect(f.goals.refreshNativeObservation(f.request.ticket,21000)).toEqual({activeSeconds:21,runtime:'running',requestActiveSeconds:1});
 expect(f.goals.refreshNativeObservation(f.request.ticket,22000)).toBeNull();
 expect(f.goals.settle(f.request.ticket,{relation:'replace',status:'running',summary:'task',estimate:{remainingSeconds:60,errorPercent:30}},31000)).toBe(true);
 expect(f.goals.settledAnchor(f.request.ticket)).toBe(21);
});

it.each(['epoch','pause'] as const)('rejects a native clock supplement after %s changes',async change=>{
 const f=fixture();const pending=f.goals.openNativeSource(f.request.ticket,new AbortController().signal,destination);
 f.resolve();await pending;
 if(change==='epoch')f.changeEpoch();else f.pause();
 expect(f.goals.refreshNativeObservation(f.request.ticket,21000)).toBeNull();
});

it.each(['same-user','changed-user','missing-user','not-ready'] as const)(
 'refreshes a newer source revision only with ready unchanged user evidence: %s',async change=>{
 const f=fixture('synthetic-user-a');
 const pending=f.goals.openNativeSource(f.request.ticket,new AbortController().signal,destination);
 f.resolve();await pending;
 f.source.inspect=()=>({revision:2,currentActionId:null,finalAvailable:false,ready:change!=='not-ready',
  ...(change==='missing-user'?{}:{userFingerprint:change==='changed-user'?'synthetic-user-b':'synthetic-user-a'})});
 const sample=f.goals.refreshNativeObservation(f.request.ticket,21000);
 if(change==='same-user'){
  expect(sample).toEqual({activeSeconds:21,runtime:'running',requestActiveSeconds:1});
  expect(f.goals.refreshNativeObservation(f.request.ticket,22000)).toBeNull();
 }else expect(sample).toBeNull();
});
