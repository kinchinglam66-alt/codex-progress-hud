import {expect,it} from 'vitest';
import {PassiveGoals, type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import type {PaceEvidence} from '../../src/estimation/pace-measurements.js';
import {freezePaceRequest} from '../../src/estimation/pace-request-snapshot.js';
import type {PaceGroup} from '../../src/estimation/pace-measurements.js';

const token='protected-pace-request-test-token-1234567890';
const evidence: PaceEvidence={
  signature:'vitest-signature',project:'C:/project',turnId:'turn',actionId:'action',
  startedAtMs:2_000,endedAtMs:5_000,
  files:[
    {identity:'tests/a.test.ts',startMs:2_000,endMs:3_000},
    {identity:'tests/b.test.ts',startMs:3_200,endMs:4_200},
    {identity:'tests/c.test.ts',startMs:4_400,endMs:5_000},
  ],
};
const continuity={sourceEpoch:1,historyComplete:true,
  runningWindows:[{startMs:1_000,endMs:6_000}],competingActionWindows:[]};

function setup(){
  let evidenceForRead:PaceEvidence|undefined;
  let measurementEpoch=1,historyComplete=true;
  const contexts=new PassiveContextStore();
  const source:GoalContextSource={
    epoch:()=>1,
    measurementEpoch:()=>measurementEpoch,
    read:(_key,_turn,query)=>({epoch:1,revision:1,currentActionId:null,finalAvailable:false,measurementEpoch,
      paceContinuity:{...continuity,historyComplete},
      ...(evidenceForRead===undefined?{}:{paceEvidence:evidenceForRead,paceContinuity:continuity}),
      input:{goalSummary:query.goalSummary,activeSeconds:query.activeSeconds,runtime:query.runtime,
        messages:[{kind:'user',text:'current task',truncated:false}],truncated:false} satisfies ObserverInput}),
  };
  const goals=new PassiveGoals(contexts,source);
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'turn'},0,token).envelope;
  goals.observe(envelope,true,0);
  const prompt=(now:number,turn='turn-two')=>{
    const next=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:turn},now,token).envelope;
    goals.observe(next,true,now);return next;
  };
  const request=(now:number)=>goals.request(envelope.sessionKey,now)!;
  return {goals,source,sessionKey:envelope.sessionKey,turnKey:envelope.turnKey!,request,prompt,
    setEvidence:(value?:PaceEvidence)=>{evidenceForRead=value;},setMeasurementEpoch:(value:number)=>{measurementEpoch=value;},
    setHistory:(value:boolean)=>{historyComplete=value;}};
}

const baseAnswer={relation:'replace' as const,status:'running' as const,summary:'current task',estimate:{remainingSeconds:100,errorPercent:20}};

it('keeps legacy responses valid and exposes no pace summaries without source evidence',()=>{
  const f=setup();
  const request=f.request(1_000);
  expect(request.input).not.toHaveProperty('paceMeasurements');
  expect(f.goals.settle(request.ticket,baseAnswer,1_100)).toBe(true);
});

it('freezes accepted request groups against future source samples',()=>{
  const f=setup();
  expect(f.goals.settle(f.request(1_000).ticket,baseAnswer,1_100)).toBe(true);
  f.setEvidence(evidence);
  const request=f.request(2_000);
  const measurements=request.input.paceMeasurements!;
  expect(measurements).toHaveLength(1);
  const work={composition:'serial' as const,changeReason:'routine' as const,parts:[
    {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:2,priorSeconds:10,
      measurementRef:measurements[0]!.measurementRef},
  ]};
  expect(f.goals.settle(request.ticket,{...baseAnswer,relation:'continue',work},2_100)).toBe(true);
  const before=f.goals.paceIntervals(request.ticket,work);
  expect(before).toHaveLength(3);
  f.setEvidence({...evidence,actionId:'future-action',files:[...evidence.files,
    {identity:'tests/d.test.ts',startMs:5_200,endMs:6_000}]});
  expect(f.goals.paceIntervals(request.ticket,work)).toEqual(before);
});

it('rejects foreign and replaced-ticket references',()=>{
  const first=setup();expect(first.goals.settle(first.request(1_000).ticket,baseAnswer,1_100)).toBe(true);
  first.setEvidence(evidence);const request=first.request(2_000);
  const ref=request.input.paceMeasurements![0]!.measurementRef;
  const work={composition:'serial' as const,changeReason:'routine' as const,parts:[
    {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:2,priorSeconds:10,measurementRef:ref},
  ]};
  expect(first.goals.settle(request.ticket,{...baseAnswer,relation:'continue',work},2_100)).toBe(true);
  const other=setup();
  expect(other.goals.paceIntervals(request.ticket,work)).toEqual([]);
  first.setEvidence(undefined);
  first.prompt(2_900);
  const replacement=first.request(3_000);
  expect(first.goals.settle(replacement.ticket,{...baseAnswer,summary:'new task'},3_100)).toBe(true);
  expect(first.goals.paceIntervals(request.ticket,work)).toEqual([]);
});

it('invalidates measurement state across pause, recovery, and end',()=>{
  const f=setup();expect(f.goals.settle(f.request(1_000).ticket,baseAnswer,1_100)).toBe(true);
  f.setEvidence(evidence);const request=f.request(2_000);
  const ref=request.input.paceMeasurements![0]!.measurementRef;
  const work={composition:'serial' as const,changeReason:'routine' as const,parts:[
    {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:2,priorSeconds:10,measurementRef:ref},
  ]};
  const turnKey=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'turn'},0,token).envelope.turnKey!;
  f.goals.runtime(f.sessionKey,turnKey,'paused',2_100);
  expect(f.goals.settle(request.ticket,{...baseAnswer,relation:'continue',work},2_200)).toBe(false);
  f.goals.runtime(f.sessionKey,turnKey,'running',2_300);
  expect(f.goals.paceIntervals(request.ticket,work)).toEqual([]);
  f.goals.end(f.sessionKey);
  expect(f.goals.paceIntervals(request.ticket,work)).toEqual([]);
});

it('removes dropped summaries from the frozen lookup after final packing',()=>{
  const intervals=[0,2,4].map(start=>({workClass:'file_processing' as const,unit:'file' as const,
    startActiveSeconds:start,endActiveSeconds:start+1,completedUnits:1,complete:true,serial:true}));
  const groups:PaceGroup[]=Array.from({length:8},(_,index)=>({signature:`sig-${index}`,project:'project',
    workClass:'file_processing',unit:'file',intervals}));
  const input:ObserverInput={goalSummary:'goal',activeSeconds:10,runtime:'running',truncated:false,
    messages:[{kind:'user',text:'u'.repeat(4096),truncated:false},{kind:'assistant',text:'a'.repeat(4096),truncated:false},
      {kind:'tool',text:'t'.repeat(4096),truncated:false},{kind:'tool',text:'v'.repeat(4096),truncated:false}]};
  const frozen=freezePaceRequest(input,groups);
  expect(Buffer.byteLength(JSON.stringify(frozen.input),'utf8')).toBeLessThanOrEqual(16_384);
  expect(frozen.intervals.size).toBe(frozen.input.paceMeasurements?.length??0);
  expect(JSON.stringify(frozen.input.paceMeasurements)).not.toMatch(/project|command|cwd|tests/u);
});

it('clears frozen intervals when an accepted goal completes',()=>{
  const f=setup();expect(f.goals.settle(f.request(1_000).ticket,baseAnswer,1_100)).toBe(true);
  f.goals.runtime(f.sessionKey,f.turnKey,'waiting',1_500);
  f.setEvidence(evidence);const request=f.request(2_000);
  const ref=request.input.paceMeasurements![0]!.measurementRef;
  const work={composition:'serial' as const,changeReason:'routine' as const,parts:[
    {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:2,priorSeconds:10,measurementRef:ref},
  ]};
  expect(f.goals.settle(request.ticket,{relation:'continue',status:'completed',summary:'done',estimate:null},2_100)).toBe(true);
  expect(f.goals.paceIntervals(request.ticket,work)).toEqual([]);
});

it('invalidates frozen refs on empty recovery and partial history without a live epoch reset',()=>{
  const f=setup();expect(f.goals.settle(f.request(1_000).ticket,baseAnswer,1_100)).toBe(true);
  f.setEvidence(evidence);const request=f.request(2_000);
  const ref=request.input.paceMeasurements![0]!.measurementRef;
  const work={composition:'serial' as const,changeReason:'routine' as const,parts:[
    {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:2,priorSeconds:10,measurementRef:ref},
  ]};
  expect(f.goals.settle(request.ticket,{...baseAnswer,relation:'continue',work},2_100)).toBe(true);
  f.setMeasurementEpoch(2);f.setEvidence(undefined);
  const recovery=f.request(3_000);
  expect(recovery.input).not.toHaveProperty('paceMeasurements');
  expect(f.goals.paceIntervals(request.ticket,work)).toEqual([]);
  expect(f.goals.settle(recovery.ticket,{...baseAnswer,relation:'continue'},3_100)).toBe(true);
  f.setHistory(false);f.setMeasurementEpoch(3);
  const partial=f.request(4_000);
  expect(partial.input).not.toHaveProperty('paceMeasurements');
  expect(f.goals.paceIntervals(request.ticket,work)).toEqual([]);
});
