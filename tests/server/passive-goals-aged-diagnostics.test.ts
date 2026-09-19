import {expect,it} from 'vitest';
import {PassiveGoals,type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';

function fixture(waiting=false){
 let revision=1;
 const contexts=new PassiveContextStore();
 const source:GoalContextSource={epoch:()=>1,read:(_key,_turn,query)=>({
  epoch:1,revision,userFingerprint:'same-instruction',currentActionId:null,finalAvailable:false,
  input:{goalSummary:null,activeSeconds:query.activeSeconds,runtime:query.runtime,truncated:false,
   messages:[{kind:'user',text:'synthetic task',truncated:false}]}})};
 const goals=new PassiveGoals(contexts,source);
 const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'synthetic',turn_id:'one'},0,'synthetic-aged-diagnostics-key-123456789').envelope;
 goals.observe(envelope,true,0);
 if(waiting)goals.runtime(envelope.sessionKey,envelope.turnKey!,'waiting',500);
 const request=goals.request(envelope.sessionKey,1000)!;
 revision=2;
 return {goals,request,key:envelope.sessionKey,turn:envelope.turnKey!};
}
it.each([
 ['no-estimate','aged_response_no_estimate'],
 ['unknown-relation','aged_response_unknown_relation'],
 ['completed','aged_response_completed'],
 ['waiting','aged_response_not_running'],
] as const)('distinguishes %s without accepting the stale semantic result',(mode,reason)=>{
 const f=fixture(mode==='waiting');
 const response={relation:mode==='unknown-relation'?'unknown':'replace',status:mode==='unknown-relation'?'unknown':mode==='completed'?'completed':'running',
  summary:mode==='unknown-relation'?null:'synthetic summary',estimate:mode==='waiting'?{remainingSeconds:600,errorPercent:30}:null};
 expect(f.goals.settle(f.request.ticket,response,2000)).toBe(false);
 expect(f.goals.rejectionReason(f.request.ticket)).toBe(reason);
 expect(f.goals.view(f.key,2000)?.prediction).toBeNull();
});
it('still accepts a same-instruction numeric snapshot with its original active-time anchor',()=>{
 const f=fixture();
 expect(f.goals.settle(f.request.ticket,{relation:'replace',status:'running',summary:'synthetic summary',
  estimate:{remainingSeconds:600,errorPercent:30}},2000)).toBe(true);
 expect(f.goals.view(f.key,2000)?.prediction).toEqual({remainingSeconds:600,errorPercent:30,observedActiveSeconds:1});
});
