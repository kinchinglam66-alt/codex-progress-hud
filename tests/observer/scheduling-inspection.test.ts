import {expect,it} from 'vitest';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
it('checks source readiness without assembling model packets on each scheduling tick',()=>{
  let packetReads=0;
  const source={epoch:()=>1,inspect:()=>({ready:true,revision:1,currentActionId:'action',finalAvailable:false}),
    read:()=>{packetReads++;return null;}};
  const goals=new PassiveGoals(new PassiveContextStore(),source);
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'s',turn_id:'t'},0,'protected-inspection-token-1234567890').envelope;
  goals.observe(envelope,true,0);
  for(let now=1000;now<=15000;now+=1000)expect(goals.scheduling(envelope.sessionKey,now)?.ready).toBe(true);
  expect(packetReads).toBe(0);
  goals.request(envelope.sessionKey,15000);expect(packetReads).toBe(1);
});
