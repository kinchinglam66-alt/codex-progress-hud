import {expect,it} from 'vitest';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import {createConversationSource} from '../../src/observer/conversation-source.js';
import type {ReadBatch} from '../../src/observer/conversation-record.js';

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
it.each(['output','duplicate','new-user','same-id-edit','rewrite'] as const)('preserves instruction fences independently of projection eviction: %s',async(change)=>{
  let now=0;
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'turn'},0,
    'protected-eviction-identity-token-1234567890').envelope;
  const initial:ReadBatch['records']=[{id:'first',turnId:'old',atMs:0,kind:'user',text:'x'.repeat(20000)},
    {id:'middle',turnId:'old',atMs:1,kind:'user',text:'Prior requirement'},
    {id:'user',turnId:'turn',atMs:2,kind:'user',text:'Current task'}];
  let batch:ReadBatch={records:initial,caughtUp:true,partialLine:false,reset:false};
  const source=createConversationSource({source:{read:async()=>batch,remove(){},async close(){}},
    now:()=>now,wallNow:()=>now,turnKeyFor:(_,turn)=>turn==='turn'?envelope.turnKey!:turn});
  const goals=new PassiveGoals(new PassiveContextStore(),source.goals);
  goals.observe(envelope,true,0);source.attach(envelope.sessionKey,'host',envelope.turnKey!);
  const flush=async()=>{source.tick();await new Promise(r=>setImmediate(r));};
  try{
    now=500;await flush();
    const request=goals.request(envelope.sessionKey,now)!;expect(request).not.toBeNull();
    batch={...batch,records:Array.from({length:20},(_,i)=>({id:`tool-${i}`,turnId:'turn',atMs:3+i,kind:'tool_result',text:'y'.repeat(16384)}))};
    now=6000;await flush();
    expect(source.snapshot(envelope.sessionKey)?.records.some(r=>r.id==='middle')).toBe(false);
    if(change!=='output'){
      batch={...batch,records:change==='duplicate'?[initial[1]!]:change==='new-user'?
        [{id:'new-user',turnId:'turn',atMs:7000,kind:'user',text:'Additional requirement'}]:change==='same-id-edit'?
        [{...initial[2]!,text:'Changed task'}]:initial.map(r=>r.id==='user'?{...r,text:'Changed task'}:r),
        reset:change==='rewrite'};
      now=12000;await flush();
      if(change==='duplicate')expect(source.snapshot(envelope.sessionKey)?.records.some(r=>r.id==='middle')).toBe(false);
      if(change==='same-id-edit')expect(source.goals.read(envelope.sessionKey,envelope.turnKey!,
        {goalSummary:null,activeSeconds:0,runtime:'running',previousEstimate:null})?.input.messages.some(m=>m.text==='Changed task')).toBe(true);
    }
    expect(goals.settle(request.ticket,answer,now+100)).toBe(change==='output'||change==='duplicate');
    expect(goals.view(envelope.sessionKey,now+100)?.prediction!==null).toBe(change==='output'||change==='duplicate');
  }finally{await source.close();}
});
it('stops charging active time at a persisted end even when later output evicts old bodies',async()=>{
  let monotonic=0;
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'turn'},0,
    'protected-clock-regression-token-1234567890').envelope;
  let contents:ReadBatch={records:[{id:'user',turnId:'turn',atMs:0,kind:'user',text:'Work'}],
    caughtUp:true,partialLine:false,reset:false};
  const source=createConversationSource({source:{read:async()=>contents,remove:()=>{},close:async()=>{}},
    now:()=>monotonic,wallNow:()=>monotonic,turnKeyFor:(_host,turn)=>turn==='turn'?envelope.turnKey!:'next'});
  const goals=new PassiveGoals(new PassiveContextStore(),source.goals);
  goals.observe(envelope,true,0);source.attach(envelope.sessionKey,'host',envelope.turnKey!);
  try{
    monotonic=500;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
    goals.reconcileSource(envelope.sessionKey,monotonic);
    contents={records:[{id:'end',turnId:'turn',atMs:3000,kind:'runtime',runtime:'waiting'},
      {id:'next',turnId:'next',atMs:4000,kind:'user',text:'Next'},
      ...Array.from({length:8},(_,i)=>({id:`body${i}`,turnId:'next',atMs:4001+i,kind:'tool_result' as const,text:'x'.repeat(60000)}))],
      caughtUp:true,partialLine:false,reset:false};
    monotonic=5500;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
    goals.reconcileSource(envelope.sessionKey,monotonic);
    expect(goals.view(envelope.sessionKey,6000)).toMatchObject({runtime:'waiting',activeSeconds:3});
    expect(goals.view(envelope.sessionKey,3600000)).toMatchObject({runtime:'waiting',activeSeconds:3});
  }finally{await source.close();}
});

it('takes over a newer persisted task start on an attached conversation and resets the turn clock',async()=>{
  let monotonic=0;
  const oldTurn=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'old'},0,
    'protected-round-takeover-token-1234567890').envelope;
  const newTurn=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'new'},0,
    'protected-round-takeover-token-1234567890').envelope;
  let contents:ReadBatch={records:[
    {id:'old-start',turnId:'old',atMs:1_000,kind:'runtime',runtime:'running'},
    {id:'old-user',turnId:'old',atMs:1_100,kind:'user',text:'old turn'},
    {id:'old-complete',turnId:'old',atMs:2_000,kind:'runtime',runtime:'waiting',outcome:'completed'},
  ],caughtUp:true,partialLine:false,reset:false};
  const source=createConversationSource({source:{read:async()=>contents,remove:()=>{},close:async()=>{}},
    now:()=>monotonic,wallNow:()=>monotonic,turnKeyFor:(_host,turn)=>turn==='old'?oldTurn.turnKey!:newTurn.turnKey!});
  const goals=new PassiveGoals(new PassiveContextStore(),source.goals);
  goals.observe(oldTurn,true,0);source.attach(oldTurn.sessionKey,'host',oldTurn.turnKey!);
  try{
    monotonic=1_000;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
    goals.reconcileSource(oldTurn.sessionKey,1_000);
    contents={records:[...contents.records,
      {id:'new-start',turnId:'new',atMs:3_000,kind:'runtime',runtime:'running'},
      {id:'new-user',turnId:'new',atMs:3_100,kind:'user',text:'new turn'}],
      caughtUp:true,partialLine:false,reset:false};
    monotonic=6_000;source.changed(oldTurn.sessionKey);source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
    goals.reconcileSource(oldTurn.sessionKey,6_000);
    expect(goals.view(oldTurn.sessionKey,6_000)).toMatchObject({runtime:'running',status:'unknown',activeSeconds:0,prediction:null});
    expect(goals.request(oldTurn.sessionKey,6_000)?.input.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'user',text:'old turn',scope:'background'}),
      expect.objectContaining({kind:'user',text:'new turn',scope:'current'})
    ]));
  }finally{await source.close();}
});
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

it('resolves a frozen pace reference through the real conversation source',async()=>{
  let monotonic=0,wall=1_000;
  let failReads=false;
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'turn'},0,
    'protected-real-source-pace-token-1234567890').envelope;
  const turnKey=envelope.turnKey!;
  let contents:ReadBatch={records:[
    {id:'u',turnId:'turn',atMs:500,kind:'user',text:'run tests'},
    {id:'running',turnId:'turn',atMs:500,kind:'runtime',runtime:'running'},
  ],caughtUp:true,partialLine:false,reset:false};
  const source=createConversationSource({source:{read:async()=>{if(failReads)throw Error('offline');return contents;},remove:()=>{},close:async()=>{}},
    now:()=>monotonic,wallNow:()=>wall,turnKeyFor:(_host:string,turn:string)=>turn==='turn'?turnKey:'other'});
  const contexts=new PassiveContextStore(),goals=new PassiveGoals(contexts,source.goals);
  goals.observe(envelope,true,0);source.attach(envelope.sessionKey,'host',turnKey);
  monotonic=500;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  expect(goals.settle(goals.request(envelope.sessionKey,1_000)!.ticket,{...answer,summary:'run tests'},1_100)).toBe(true);
  expect(goals.settle(goals.request(envelope.sessionKey,2_000)!.ticket,{...answer,relation:'continue'},2_100)).toBe(true);
  const command='node node_modules/vitest/vitest.mjs run tests/a.test.ts tests/b.test.ts tests/c.test.ts --reporter=json --maxWorkers=1 --no-file-parallelism';
  const output=JSON.stringify({success:true,numTotalTestSuites:3,numPassedTestSuites:3,numFailedTestSuites:0,numPendingTestSuites:0,
    numTotalTests:3,numPassedTests:3,numFailedTests:0,numPendingTests:0,testResults:['a','b','c'].map((name,index)=>({name:`tests/${name}.test.ts`,
      status:'passed',message:'',startTime:3_100+index*500,endTime:3_300+index*500,assertionResults:[{status:'passed',failureMessages:[]}]}))});
  contents={records:[{id:'start',turnId:'turn',atMs:3_000,kind:'tool_start',actionId:'pace',toolName:'CommandExecution',cwd:'C:/project',command,startedAtMs:3_000},
    {id:'result',turnId:'turn',atMs:5_000,kind:'tool_result',actionId:'pace',toolName:'CommandExecution',cwd:'C:/project',command,complete:true,exitCode:0,
      endedAtMs:5_000,output,outputComplete:true}],caughtUp:true,partialLine:false,reset:false};
  wall=6_000;monotonic=5_500;source.changed(envelope.sessionKey);source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  const request=goals.request(envelope.sessionKey,6_100)!;const ref=request.input.paceMeasurements?.[0]?.measurementRef;
  expect(ref).toMatch(/^pm_[a-f0-9]{32}$/u);
  const work={composition:'serial' as const,changeReason:'routine' as const,parts:[{workClass:'file_processing' as const,unit:'file' as const,
    remainingUnits:2,priorSeconds:10,measurementRef:ref!}]};
  expect(goals.settle(request.ticket,{...answer,relation:'continue',work},6_200)).toBe(true);
  expect(goals.paceIntervals(request.ticket,work)).toHaveLength(3);
  failReads=true;monotonic=10_000;source.changed(envelope.sessionKey);monotonic=10_500;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  expect(goals.paceIntervals(request.ticket,work)).toEqual([]);
  failReads=false;monotonic=11_000;source.changed(envelope.sessionKey);monotonic=11_500;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  expect(goals.paceIntervals(request.ticket,work)).toEqual([]);
  await source.close();
});
