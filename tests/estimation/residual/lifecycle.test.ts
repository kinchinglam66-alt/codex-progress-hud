import {expect,it} from 'vitest';
import {ResearchLifecycle} from '../../../src/estimation/residual/lifecycle.js';
const identity={groupId:'a'.repeat(64),turnId:'b'.repeat(64),runId:'c'.repeat(32),sourceEpoch:1,generation:1};
const event=(n:number)=>({id:n.toString(16).padStart(64,'0'),atActiveSeconds:n,state:'waiting' as const,trusted:true});
it('does not confuse waiting with completion and emits normal end once',()=>{
  const life=new ResearchLifecycle();
  expect(life.transition(identity,event(40))).toEqual([]);
  const completed={...event(70),outcome:'normal_end' as const};
  expect(life.transition(identity,completed)).toMatchObject([{kind:'terminal',outcome:'normal_end',endActiveSeconds:70}]);
  expect(life.transition(identity,completed)).toEqual([]);
});
it('keeps interruptions distinct and invalidates conflicting terminal evidence',()=>{
  const life=new ResearchLifecycle();
  expect(life.transition(identity,{...event(70),outcome:'interrupted'})).toMatchObject([{outcome:'interrupted'}]);
  expect(life.transition(identity,{...event(71),outcome:'normal_end'})).toMatchObject([{kind:'invalidate',reason:'conflicting_terminal'}]);
});
it('does not rehabilitate an unreliable clock on a later normal end',()=>{
  const life=new ResearchLifecycle();
  expect(life.transition(identity,{...event(40),trusted:false})).toMatchObject([{kind:'invalidate',reason:'clock_unknown'}]);
  expect(life.transition(identity,{...event(70),outcome:'normal_end'})).toMatchObject([{kind:'terminal',outcome:'clock_unknown',clockReliable:false}]);
});
it('rejects backward active time and isolates runs',()=>{
  const life=new ResearchLifecycle();life.transition(identity,event(40));
  expect(life.transition(identity,event(30))).toMatchObject([{reason:'clock_unknown'}]);
  const newRun={...identity,runId:'d'.repeat(32)};
  expect(life.transition(newRun,{...event(70),outcome:'normal_end'})).toMatchObject([{outcome:'normal_end'}]);
});
it('shares sequence allocation and releases detached identities',()=>{
  let seq=5;const life=new ResearchLifecycle(()=>++seq);
  expect(life.invalidate(identity,'recording_gap').sequence).toBe(6);
  life.forget(identity);
  expect(life.transition(identity,{...event(70),outcome:'normal_end'})).toMatchObject([{sequence:7,outcome:'normal_end'}]);
});
