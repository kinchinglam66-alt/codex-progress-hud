import {describe, expect, it} from 'vitest';
import {PassiveGoals, type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import {ObserverScheduler,type ObserverObservation} from '../../src/estimation/observer-scheduler.js';
import {randomUUID} from 'node:crypto';

const token='checkpoint-test-token-not-a-live-credential';
const wall=1_800_000_000_000;
const answer={relation:'continue',status:'running',summary:'PRIVATE summary',estimate:{remainingSeconds:3600,errorPercent:30}};
function hook(session='one',turn='one',at=0) {
  const event=normalizeHookInput('UserPromptSubmit',{session_id:session,turn_id:turn},at,token).envelope;
  event.content={kind:'user',text:'PRIVATE user text',truncated:false};
  return event;
}
function fixture() {
  let state:'running'|'waiting'|'unknown'='running';
  let outcome:'completed'|undefined;
  const source:GoalContextSource={health:()=>state==='unknown'?'loading':'ready',epoch:()=>1,
    execution:()=>({state,identity:`${state}:${outcome??''}`,...(outcome?{outcome}:{})}),
    read:()=>({epoch:1,revision:1,currentActionId:null,finalAvailable:false,
      input:{goalSummary:null,activeSeconds:0,runtime:'running',messages:[{kind:'user',text:'PRIVATE user text',truncated:false}],truncated:false}})};
  const contexts=new PassiveContextStore();
  const goals=new PassiveGoals(contexts,source);
  return {goals,source,setState:(next:typeof state)=>{state=next;},complete:()=>{state='waiting';outcome='completed';}};
}
function seeded() {
  const f=fixture(),event=hook(); f.goals.observe(event,true,0);
  const request=f.goals.request(event.sessionKey,0)!;
  expect(f.goals.settle(request.ticket,answer,0)).toBe(true);
  return {...f,event};
}

describe('same native turn restart recovery',()=>{
  it('does not invent provenance for a recovered prediction',()=>{
    const before=seeded(),after=fixture(),key=before.event.sessionKey;
    const source={instanceId:randomUUID(),turnRef:'a'.repeat(64),correlationId:randomUUID(),requestId:1};
    expect(before.goals.settle(before.goals.request(key,100)!.ticket,answer,200,source)).toBe(true);
    expect(before.goals.view(key,200)?.predictionSource).toEqual(source);
    const checkpoint=before.goals.checkpoint(1000,wall);
    expect(JSON.stringify(checkpoint)).not.toContain(source.correlationId);
    after.goals.restoreCheckpoint(checkpoint);after.goals.observe({...before.event,receivedAt:10},true,10);
    after.goals.reconcileSource(key,10);
    expect(after.goals.view(key,10)?.prediction).not.toBeNull();
    expect(after.goals.view(key,10)?.predictionSource).toBeUndefined();
  });
  it('marks recovered numeric forecasts with unknown conditions rather than inventing an unconditional estimate',()=>{
    const before=seeded(),after=fixture(),key=before.event.sessionKey;
    after.goals.restoreCheckpoint(before.goals.checkpoint(1000,wall));
    after.goals.observe({...before.event,receivedAt:10},true,10);after.goals.reconcileSource(key,10);
    expect(after.goals.view(key,10)?.estimateCondition).toEqual({selectedPath:'unknown',displayPath:'unknown',issue:'missing_conditions'});
    expect(after.goals.view(key,10)?.prediction?.remainingSeconds).toBe(3600);
  });
  it.each([false,true])('restores milestone only when checkpoint revision matches (%s mismatch)',mismatch=>{
    const before=seeded(),after=fixture(),key=before.event.sessionKey;
    const next=before.goals.request(key,1000)!;
    expect(before.goals.settle(next.ticket,{...answer,nextMilestone:{definition:'stage',criterion:'stage evidence',completionCriterion:'semantic',operationRef:null,estimate:{remainingSeconds:600,errorPercent:50}}},2000)).toBe(true);
    before.goals.runtime(key,before.event.turnKey!,'paused',3000);before.goals.runtime(key,before.event.turnKey!,'running',9000);
    const checkpoints=before.goals.checkpoint(10000,wall),milestones=before.goals.milestoneCheckpoint(wall);
    expect(milestones).toHaveLength(1);if(mismatch)milestones[0]!.estimateRevision++;
    after.goals.restoreCheckpoint(checkpoints,wall+600000);after.goals.restoreMilestoneCheckpoint(milestones);
    after.goals.observe({...before.event,receivedAt:10},true,10);
    expect(after.goals.view(key,10)?.progressState).toBeUndefined();
    after.goals.reconcileSource(key,10);
    expect(after.goals.view(key,10)?.activeSeconds).toBe(4);
    if(mismatch)expect(after.goals.view(key,10)?.progressState).toBeUndefined();
    else expect(after.goals.view(key,10)?.progressState?.milestone?.definition).toBe('stage');
  });
  it.each([undefined,wall-1,Number.NaN,Number.POSITIVE_INFINITY])('does not invent a recovery gap from an invalid wall clock %s',reloadWall=>{
    const before=seeded(),after=fixture();
    after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall),reloadWall);
    after.goals.observe({...before.event,receivedAt:50},true,50);after.goals.reconcileSource(before.event.sessionKey,50);
    expect(after.goals.view(before.event.sessionKey,50)).toMatchObject({activeSeconds:100,recoveryGapSeconds:null,timingUncertain:true});
    const next=hook('one','two',100);after.goals.observe(next,true,100);
    expect(after.goals.view(next.sessionKey,100)).not.toHaveProperty('recoveryGapSeconds');
    expect(after.goals.view(next.sessionKey,100)).not.toHaveProperty('recoveryState');
  });
  it('marks recovered measurements and the unobserved wall-time gap without charging it',async()=>{
    const before=seeded(),after=fixture(),events:ObserverObservation[]=[];
    after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall),wall+600_000);
    after.goals.observe({...before.event,receivedAt:50},true,50);after.goals.reconcileSource(before.event.sessionKey,50);
    const scheduler=new ObserverScheduler({goals:after.goals,contexts:new PassiveContextStore(),now:()=>50,onObservation:event=>events.push(event),
      workers:[{status:()=>({active:false,disabled:true,poisoned:false}),disable(){},async close(){},async observe(){throw Error('must not infer');}}]});
    try{scheduler.changed(before.event.sessionKey,'activity');
      expect(events[0]).toMatchObject({activeSeconds:100,timingUncertain:true,recoveryState:'restored',recoveryGapSeconds:600});
    }finally{await scheduler.close();}
  });
  it('rejects an invalid or regressing checkpoint clock instead of saving an empty state',()=>{
    const f=seeded();
    expect(()=>f.goals.checkpoint(Number.NaN,wall)).toThrow();
    f.goals.runtime(f.event.sessionKey,f.event.turnKey!,'paused',1000);
    expect(()=>f.goals.checkpoint(999,wall)).toThrow();
  });
  it('restores eight independent clocks without charging downtime',()=>{
    const before=fixture();
    const events=Array.from({length:8},(_,n)=>hook(String(n)));
    for(const event of events){before.goals.observe(event,true,0);expect(before.goals.settle(before.goals.request(event.sessionKey,0)!.ticket,answer,0)).toBe(true);}
    const records=before.goals.checkpoint(1_200_000,wall);
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
    const after=fixture();after.goals.restoreCheckpoint(records);
    for(const event of events){
      after.goals.observe({...event,receivedAt:50},true,50);
      expect(after.goals.request(event.sessionKey,50)).toBeNull();
      after.goals.reconcileSource(event.sessionKey,50);
      expect(after.goals.view(event.sessionKey,50)).toMatchObject({activeSeconds:1200,timingUncertain:true,runtime:'running',estimateRevision:records[0]!.estimateRevision,prediction:{remainingSeconds:3600,errorPercent:30}});
      expect(after.goals.view(event.sessionKey,1050)?.activeSeconds).toBe(1201);
    }
  });
  it('keeps recovery frozen and non-dispatchable while native evidence is missing',()=>{
    const before=seeded(),after=fixture();after.setState('unknown');
    after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall));
    after.goals.observe({...before.event,receivedAt:10},true,10);
    after.goals.reconcileSource(before.event.sessionKey,10);
    expect(after.goals.request(before.event.sessionKey,5010)).toBeNull();
    expect(after.goals.view(before.event.sessionKey,5010)).toMatchObject({activeSeconds:100,runtime:'waiting',runtimeUncertain:true});
    after.setState('running');after.goals.reconcileSource(before.event.sessionKey,6010);
    expect(after.goals.view(before.event.sessionKey,7010)?.activeSeconds).toBe(101);
  });
  it('preserves manual pause but lets native completion supersede it',()=>{
    const before=seeded();before.goals.runtime(before.event.sessionKey,before.event.turnKey!,'paused',10_000);
    const after=fixture();after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall));
    after.goals.observe({...before.event,receivedAt:10},true,10);after.goals.reconcileSource(before.event.sessionKey,10);
    expect(after.goals.view(before.event.sessionKey,9010)).toMatchObject({runtime:'paused',activeSeconds:10});
    after.complete();after.goals.reconcileSource(before.event.sessionKey,9010);
    expect(after.goals.view(before.event.sessionKey,9010)?.status).toBe('completed');
    expect(after.goals.checkpoint(9010,wall+1000)).toEqual([]);
  });
  it('starts a verified different turn fresh',()=>{
    const before=seeded(),after=fixture();after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall));
    const next=hook('one','two',50);after.goals.observe(next,true,50);after.goals.reconcileSource(next.sessionKey,50);
    expect(after.goals.view(next.sessionKey,50)).toMatchObject({activeSeconds:0,prediction:null});
  });
  it('does not revive tickets or reset recovered time during summary bootstrap',()=>{
    const before=seeded(),oldRequest=before.goals.request(before.event.sessionKey,1000)!;
    const after=fixture();after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall));
    after.goals.observe({...before.event,receivedAt:10},true,10);after.goals.reconcileSource(before.event.sessionKey,10);
    expect(after.goals.settle(oldRequest.ticket,answer,10)).toBe(false);
    const current=after.goals.request(before.event.sessionKey,1010)!;
    const generation=after.goals.view(before.event.sessionKey,1010)!.generation;
    expect(after.goals.settle(current.ticket,{...answer,estimate:null},1010)).toBe(true);
    expect(after.goals.view(before.event.sessionKey,1010)).toMatchObject({activeSeconds:101,generation,prediction:{remainingSeconds:3600}});
  });
  it('keeps progress floor when replacement estimate grows and recovery repeats',()=>{
    const before=seeded();before.goals.view(before.event.sessionKey,1_800_000);
    before.goals.settle(before.goals.request(before.event.sessionKey,1_800_000)!.ticket,{...answer,estimate:{remainingSeconds:10000,errorPercent:30}},1_800_000);
    const saved=before.goals.checkpoint(1_800_000,wall);
    expect(saved[0]!.progressFloor).toBe(50);
    const after=fixture();after.goals.restoreCheckpoint(saved);after.goals.observe({...before.event,receivedAt:10},true,10);after.goals.reconcileSource(before.event.sessionKey,10);
    expect(after.goals.view(before.event.sessionKey,10)?.progressFloor).toBe(50);
    expect(after.goals.checkpoint(10,wall+10000)[0]!.activeSeconds).toBe(1800);
  });
  it('does not overwrite pending records with zero or extend their save timestamp',()=>{
    const before=seeded(),records=before.goals.checkpoint(100_000,wall),after=fixture();
    after.goals.restoreCheckpoint(records);
    expect(after.goals.checkpoint(50,wall+10000)).toEqual(records);
  });
  it('retains a pause made during recovery across another restart',()=>{
    const before=seeded(),after=fixture();after.setState('unknown');
    after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall));
    after.goals.observe({...before.event,receivedAt:10},true,10);
    after.goals.runtime(before.event.sessionKey,before.event.turnKey!,'paused',20);
    expect(after.goals.checkpoint(30,wall+1000)[0]?.runtime).toBe('paused');
    after.setState('running');after.goals.reconcileSource(before.event.sessionKey,30);
    expect(after.goals.view(before.event.sessionKey,1000)).toMatchObject({runtime:'paused',activeSeconds:100});
  });
  it('honors an interrupt arriving before native recovery completes',()=>{
    const before=seeded(),after=fixture();after.setState('unknown');
    after.goals.restoreCheckpoint(before.goals.checkpoint(100_000,wall));
    after.goals.observe({...before.event,receivedAt:10},true,10);
    after.goals.observe({...before.event,hook:'Interrupt',receivedAt:20},true,20);
    after.setState('running');after.goals.reconcileSource(before.event.sessionKey,30);
    expect(after.goals.view(before.event.sessionKey,1000)?.runtime).toBe('interrupted');
    expect(after.goals.checkpoint(1000,wall+1000)).toEqual([]);
  });
});
