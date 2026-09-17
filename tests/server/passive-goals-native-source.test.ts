import {expect,it} from 'vitest';
import {PassiveGoals,type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {OpenNativeSourceResult,NativeTurnSource} from '../../src/observer/native-source-request.js';

const destination={destinationDirectory:'C:/owned',maxSourceBytes:10000,verifyDestination:async()=>{}};
function fixture(){
 let epoch=1,closed=0,opens=0;
 let resolve!:(value:OpenNativeSourceResult)=>void;
 const contexts=new PassiveContextStore();
 const source:GoalContextSource={epoch:()=>epoch,read:()=>({epoch,revision:1,currentActionId:null,finalAvailable:false,
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
 return {goals,source,envelope,request,result,resolve:()=>resolve(result),changeEpoch:()=>{epoch++;},
  counts:()=>({closed,opens}),pause:()=>goals.runtime(envelope.sessionKey,envelope.turnKey!,'paused',1100)};
}

it('opens native input only for a current opaque goal ticket',async()=>{
 const f=fixture();
 await expect(f.goals.openNativeSource({},new AbortController().signal,destination)).rejects.toMatchObject({code:'GOAL_TICKET_STALE'});
 expect(f.counts().opens).toBe(0);
 const pending=f.goals.openNativeSource(f.request.ticket,new AbortController().signal,destination);
 f.resolve();expect(await pending).toBe(f.result);expect(f.counts()).toEqual({closed:0,opens:1});
});

it.each(['waiting','paused'] as const)('paired validation rejects %s after acquisition',async runtime=>{
 const f=fixture(),signal=new AbortController().signal;
 const source:NativeTurnSource={identity:'source',sourceEpoch:1,revision:1,currentTurnId:'one',baseKey:'base',
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
