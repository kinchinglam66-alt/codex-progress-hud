import {it,expect} from 'vitest';
import {PassiveGoals,createProductionPassiveGoals,type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput,type HookName} from '../../src/hooks/schema.js';
import {ETA_TIME_BASIS} from '../../src/core/eta-time-contract.js';
import {etaClockTicks} from '../../src/ui/eta-clock-policy.js';
import {EtaLiveClock} from '../../src/core/eta-live-clock.js';

const response={relation:'replace',status:'running',summary:'download and validate',estimate:{remainingSeconds:1800,errorPercent:30}};
it('separates missing approval coverage from an observed ambiguous block without certifying scoring',()=>{
 let evidence:NonNullable<ReturnType<NonNullable<GoalContextSource['execution']>>>={state:'running',identity:'one',wallClockBoundaryMs:0,blockingEvidenceComplete:false};
 const f=fixture({epoch:()=>1,read:()=>null,execution:()=>evidence});
 f.hook('UserPromptSubmit',0);f.goals.reconcileSource(f.key,1000);
 expect(f.goals.view(f.key,5000)).toMatchObject({runtime:'running',activeSeconds:5,
   blockingUnknown:false,blockingEvidenceIncomplete:true,humanBlocked:false,timingUncertain:true});
 expect(f.goals.activeTimeKnown(f.key)).toBe(false);
 evidence={...evidence,identity:'two',wallClockBoundaryMs:5000,
   attention:{required:true,evidenceRef:'approval:2',relevantWorkRunning:undefined}};
 f.goals.reconcileSource(f.key,5000);
 expect(f.goals.view(f.key,6000)).toMatchObject({blockingUnknown:true,blockingEvidenceIncomplete:false,activeSeconds:6,humanBlocked:false});
 evidence={...evidence,identity:'three',wallClockBoundaryMs:6000,
   attention:{required:true,evidenceRef:'approval:3',relevantWorkRunning:true}};
 f.goals.reconcileSource(f.key,6000);
 expect(f.goals.view(f.key,7000)).toMatchObject({blockingUnknown:false,blockingEvidenceIncomplete:true,activeSeconds:7,humanBlocked:false});
});
it('uncovered clock intervals remain uncertain after coverage resumes and never deduct user time',()=>{
 const c=new EtaLiveClock(0);c.blocking('uncovered',1000);
 expect(c.unknownBlocking).toBe(false);expect(c.blockingEvidenceIncomplete).toBe(true);
 expect(c.elapsed(5000)).toBe(5);expect(c.uncertain).toBe(true);
 c.blocking('none',5000);expect(c.blockingEvidenceIncomplete).toBe(false);
 expect(c.uncertain).toBe(true);expect(c.elapsed(6000)).toBe(6);
 c.end(6000);expect(c.elapsed(10000)).toBe(6);
});
it('production factory selects wall delivery while raw legacy constructor stays unmarked',()=>{
 expect(createProductionPassiveGoals(new PassiveContextStore()).clockBasis()).toBe(ETA_TIME_BASIS);
 expect(new PassiveGoals(new PassiveContextStore()).clockBasis()).toBeUndefined();
});
function fixture(source?:GoalContextSource){
  const contexts=new PassiveContextStore(),goals=new PassiveGoals(contexts,source,undefined,ETA_TIME_BASIS);
  let key='',turn='';
  function hook(kind:HookName,at:number,id='one'){
    const e=normalizeHookInput(kind,{session_id:'walltest',turn_id:id},at,'test-protected-token-1234567890123456789').envelope;
    e.content={kind:kind==='UserPromptSubmit'?'user':kind==='PostToolUse'?'tool':'assistant',text:'download and validate',truncated:false};
    contexts.ingest(e,at);goals.observe(e,true,at);key=e.sessionKey;turn=e.turnKey!;return key;
  }
  return {goals,hook,get key(){return key;},get turn(){return turn;}};
}
it('marks new model requests and keeps download waiting time in live clock',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);
  const request=f.goals.request(f.key,1000)!;expect(request.input.timeBasis).toBe(ETA_TIME_BASIS);
  expect(f.goals.settle(request.ticket,response,2000)).toBe(true);
  f.goals.runtime(f.key,f.turn,'waiting',3000);
  const view=f.goals.view(f.key,1800000)!;
  expect(view).toMatchObject({timeBasis:ETA_TIME_BASIS,activeSeconds:1800,blockingUnknown:true});
  expect(etaClockTicks(view)).toBe(true);
});
it('tracking pause does not claim that the source task stopped working',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);f.goals.runtime(f.key,f.turn,'paused',1000);
  expect(f.goals.view(f.key,10000)?.activeSeconds).toBe(10);
});
it('interrupt stops clock and does not become a completed task',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);f.hook('Interrupt',8000);
  expect(f.goals.view(f.key,30000)).toMatchObject({status:'interrupted',activeSeconds:8,prediction:null});
});
it('rejects model-completed result even when runtime is waiting',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);f.hook('Stop',1000);
  const request=f.goals.request(f.key,2000)!;
  expect(f.goals.settle(request.ticket,{...response,status:'completed',estimate:null},3000)).toBe(false);
  expect(f.goals.view(f.key,10000)?.status).not.toBe('completed');
  expect(f.goals.view(f.key,10000)?.activeSeconds).toBe(10);
});
it('does not restore legacy active-time prediction into wall clock',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);const legacy=f.goals.checkpoint(1000,1000)[0]!;
  delete legacy.timeBasis;legacy.activeSeconds=999;legacy.prediction={remainingSeconds:500,errorPercent:20,observedActiveSeconds:990};
  const g=fixture();g.goals.restoreCheckpoint([legacy],2000);g.hook('UserPromptSubmit',0);
  expect(g.goals.view(g.key,1000)).toMatchObject({activeSeconds:1,prediction:null,timingUncertain:true});
});
it('new checkpoints retain explicit basis and count restart gap without restoring stale forecast',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);const r=f.goals.request(f.key,1000)!;f.goals.settle(r.ticket,response,2000);
  const checkpoint=f.goals.checkpoint(10000,100000);expect(checkpoint[0]?.timeBasis).toBe(ETA_TIME_BASIS);
  const g=fixture();g.goals.restoreCheckpoint(checkpoint,120000);g.hook('UserPromptSubmit',0);
  expect(g.goals.view(g.key,5000)).toMatchObject({activeSeconds:35,prediction:null,timingUncertain:true});
});
it('uses independently verified full-human blockage and resumes on source running',()=>{
  let evidence:NonNullable<ReturnType<NonNullable<GoalContextSource['execution']>>>={state:'running',identity:'one',boundaryMs:0};
  const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>evidence};
  const f=fixture(source);f.hook('UserPromptSubmit',0);f.goals.reconcileSource(f.key,0);
  evidence={state:'waiting',identity:'two',boundaryMs:1000,humanBlock:{humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false,evidenceRef:'native:2'}};
  f.goals.reconcileSource(f.key,1000);expect(f.goals.view(f.key,11000)).toMatchObject({activeSeconds:1,humanBlocked:true});
  evidence={state:'running',identity:'three',boundaryMs:11000};f.goals.reconcileSource(f.key,11000);
  expect(f.goals.view(f.key,12000)).toMatchObject({activeSeconds:2,humanBlocked:false});
});
it('native completion stops at its event time, not observation or model time',()=>{
  let evidence:NonNullable<ReturnType<NonNullable<GoalContextSource['execution']>>>={state:'running',identity:'one',boundaryMs:0,startedAtMs:0};
  const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>evidence};
  const f=fixture(source);f.hook('UserPromptSubmit',0);f.goals.reconcileSource(f.key,0);
  evidence={state:'waiting',identity:'two',boundaryMs:8000,wallClockBoundaryMs:8000,outcome:'completed',startedAtMs:0};
  f.goals.reconcileSource(f.key,10000);expect(f.goals.view(f.key,20000)).toMatchObject({status:'completed',activeSeconds:8});
});
it('does not use a legacy clamped terminal as a reliable wall-clock boundary',()=>{
 const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>({state:'waiting',identity:'done',boundaryMs:0,startedAtMs:-20000,outcome:'completed'})};
 const f=fixture(source);f.hook('PostToolUse',10000);f.goals.reconcileSource(f.key,12000);
 expect(f.goals.view(f.key,20000)).toMatchObject({status:'completed',activeSeconds:32,timingUncertain:true});
 expect(f.goals.activeTimeKnown(f.key)).toBe(false);
});
it('late attachment recovers the earlier verified native start',()=>{
  const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>({state:'running',identity:'one',boundaryMs:0,startedAtMs:0})};
  const f=fixture(source);f.hook('PostToolUse',10000);f.goals.reconcileSource(f.key,10000);
  expect(f.goals.view(f.key,15000)?.activeSeconds).toBe(15);
});
it('marks missing late-attachment origin uncertain instead of claiming complete turn time',()=>{
  const f=fixture();f.hook('PostToolUse',10000);
  expect(f.goals.view(f.key,15000)).toMatchObject({timeBasis:ETA_TIME_BASIS,timingUncertain:true});
  expect(f.goals.activeTimeKnown(f.key)).toBe(false);
});
it('new turn gets a new wall clock, not previous task elapsed',()=>{
  const f=fixture();f.hook('UserPromptSubmit',0);f.hook('UserPromptSubmit',10000,'two');
  expect(f.goals.view(f.key,12000)?.activeSeconds).toBe(2);
});
it('supports late terminal evidence cutting off previously observed pause intervals',()=>{
  const c=new EtaLiveClock(0);c.blocking('confirmed_human',1000);c.blocking('none',5000);c.end(3000);
  expect(c.elapsed(10000)).toBe(1);
});
it('late attachment counts the part before the current process monotonic origin',()=>{
 const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>({state:'running',identity:'one',boundaryMs:0,startedAtMs:-20000})};
 const f=fixture(source);f.hook('PostToolUse',10000);f.goals.reconcileSource(f.key,10000);
 expect(f.goals.view(f.key,15000)?.activeSeconds).toBe(35);
});
it('recovered terminal inside downtime excludes time after native completion',()=>{
 const f=fixture();f.hook('UserPromptSubmit',0);const checkpoint=f.goals.checkpoint(10000,100000);
 const source:GoalContextSource={epoch:()=>1,read:()=>null,health:()=> 'ready',
  execution:()=>({state:'waiting',identity:'done',outcome:'completed',boundaryMs:0,wallClockBoundaryMs:-5000})};
 const g=fixture(source);g.goals.restoreCheckpoint(checkpoint,120000);g.hook('UserPromptSubmit',0);g.goals.reconcileSource(g.key,5000);
 expect(g.goals.view(g.key,50000)).toMatchObject({status:'completed',activeSeconds:25,prediction:null,timingUncertain:true});
});
