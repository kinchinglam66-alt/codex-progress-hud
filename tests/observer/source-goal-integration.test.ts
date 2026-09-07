import {expect,it} from 'vitest';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';

function setup(){
  let epoch=0,revision=1,available=false;
  const contexts=new PassiveContextStore();
  const source={epoch:()=>epoch,read:(_key:string,_turn:string,query:{activeSeconds:number})=>available?{
    epoch,revision,currentActionId:'action',finalAvailable:false,input:{goalSummary:null,
      activeSeconds:query.activeSeconds,runtime:'running',messages:[{kind:'user',text:'persisted sleep 100',truncated:false}],
      truncated:false} satisfies ObserverInput}:null};
  const goals=new PassiveGoals(contexts,source);
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'turn'},0,
    'protected-source-test-token-1234567890').envelope;
  goals.observe(envelope,true,0);
  return {goals,contexts,envelope,available:()=>{available=true;},reset:()=>{epoch++;},advance:()=>{revision++;}};
}
const answer={relation:'replace',status:'running',summary:'sleep',estimate:{remainingSeconds:90,errorPercent:20}};
it('rejects a new answer based on superseded source input without erasing the previous estimate',()=>{
  const f=setup();f.available();const first=f.goals.request(f.envelope.sessionKey,15000)!;
  expect(f.goals.settle(first.ticket,answer,16000)).toBe(true);
  const before=f.goals.view(f.envelope.sessionKey,17000)!.prediction;
  const next=f.goals.request(f.envelope.sessionKey,17000)!;f.advance();
  expect(f.goals.settle(next.ticket,{...answer,relation:'continue',estimate:{remainingSeconds:1,errorPercent:5}},18000)).toBe(false);
  expect(f.goals.view(f.envelope.sessionKey,18000)?.prediction).toEqual(before);
});
it('uses selected source content even when the authenticated hook has no body',()=>{
  const f=setup();expect(f.goals.request(f.envelope.sessionKey,15000)).toBeNull();f.available();
  expect(f.goals.scheduling(f.envelope.sessionKey,15000)).toMatchObject({ready:true,revision:1,currentActionId:'action'});
  expect(f.goals.request(f.envelope.sessionKey,15000)?.input.messages[0]?.text).toBe('persisted sleep 100');
});
it('does not silently fall back to hook body when the selected source fails',()=>{
  const f=setup();f.contexts.ingest({...f.envelope,content:{kind:'user',text:'hook body',truncated:false}},0);
  expect(f.goals.request(f.envelope.sessionKey,15000)).toBeNull();
  expect(f.goals.scheduling(f.envelope.sessionKey,15000)?.ready).toBe(false);
});
it('rejects an otherwise valid model result after the source was replaced',()=>{
  const f=setup();f.available();const request=f.goals.request(f.envelope.sessionKey,15000)!;
  f.reset();expect(f.goals.settle(request.ticket,answer,16000)).toBe(false);
  expect(f.goals.view(f.envelope.sessionKey,16000)?.prediction).toBeNull();
});
it('clears accepted prediction state when the selected source is rebuilt',()=>{
  const f=setup();f.available();const first=f.goals.request(f.envelope.sessionKey,15000)!;
  expect(f.goals.settle(first.ticket,answer,16000)).toBe(true);
  f.reset();
  expect(f.goals.scheduling(f.envelope.sessionKey,17000)?.view.prediction).toBeNull();
});
