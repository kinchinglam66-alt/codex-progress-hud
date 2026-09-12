import {expect,it} from 'vitest';
import {PassiveGoals,type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
it('emits source terminal evidence before a same-session takeover replaces the old turn',()=>{
  const events:unknown[]=[];
  const source:GoalContextSource={epoch:()=>1,read:()=>null,
    execution:()=>({state:'waiting',outcome:'completed',identity:'terminal',boundaryMs:1000,researchReliable:true}),
    takeover:()=>({turnKey:'next',startedAtMs:2000,identity:'new'})};
  const contexts=new PassiveContextStore(),goals=new PassiveGoals(contexts,source,event=>events.push(event));
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'test',turn_id:'first'},0,'protected-goal-owner-test-token-1234567890').envelope;
  contexts.ingest(envelope,0);goals.observe(envelope,true,0);
  goals.reconcileSource(envelope.sessionKey,2000);
  expect(events).toContainEqual(expect.objectContaining({turnKey:envelope.turnKey,outcome:'normal_end',activeSeconds:1,trusted:true}));
  expect(goals.currentTurnKey(envelope.sessionKey)).toBe('next');
});
it('research callback failure cannot prevent a production terminal transition',()=>{
  const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>({state:'waiting',outcome:'completed',identity:'terminal',boundaryMs:1000,researchReliable:true})};
  const contexts=new PassiveContextStore(),goals=new PassiveGoals(contexts,source,()=>{throw Error('disk');});
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'test',turn_id:'first'},0,'protected-goal-owner-test-token-1234567890').envelope;
  goals.observe(envelope,true,0);goals.reconcileSource(envelope.sessionKey,1000);
  expect(goals.view(envelope.sessionKey,2000)?.status).toBe('completed');
});
it('does not project an old terminal through an unrecorded pause interval',()=>{
  const events:{trusted:boolean}[]=[];
  const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>({state:'waiting',outcome:'completed',identity:'terminal',boundaryMs:1000,researchReliable:true})};
  const goals=new PassiveGoals(new PassiveContextStore(),source,event=>events.push(event));
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'test',turn_id:'first'},0,'protected-goal-owner-test-token-1234567890').envelope;
  goals.observe(envelope,true,0);goals.runtime(envelope.sessionKey,envelope.turnKey!,'paused',5000);
  goals.reconcileSource(envelope.sessionKey,6000);
  expect(events[0]?.trusted).toBe(false);
});
