import {expect,it} from 'vitest';
import {createConversationSource} from '../../src/observer/conversation-source.js';
import type {ReadBatch} from '../../src/observer/conversation-record.js';

const query={goalSummary:null,activeSeconds:15,runtime:'running' as const,previousEstimate:null};
it('keeps authenticated turn content across unattributed records without importing those records',async()=>{
  const f=setup();f.set({records:[
    {id:'start',turnId:'current',atMs:0,kind:'runtime',runtime:'running'},
    {id:'unattributed',turnId:null,atMs:1,kind:'user',text:'Unverified instruction'},
    ...records.slice(1),
  ],caughtUp:true,partialLine:false,reset:false});
  f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  try{
    expect(f.source.goals.inspect?.('key','opaque-current',query)).toMatchObject({ready:true,currentActionId:'call'});
    expect(f.source.goals.read('key','opaque-current',query)?.input.messages.map(m=>m.text)).toEqual(['Continue','sleep 100']);
  }finally{await f.source.close();}
});

it('never rejoins current-turn records beyond a different authenticated turn',async()=>{
  const f=setup();f.set({records:[...records,
    {id:'future',turnId:'future',atMs:3000,kind:'user',text:'Another task'},
    {id:'late',turnId:'current',atMs:4000,kind:'assistant',assistantPhase:'final',text:'Late final'},
  ],caughtUp:true,partialLine:false,reset:false});
  f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  try{
    expect(f.source.goals.inspect?.('key','opaque-current',query)?.finalAvailable).toBe(false);
    expect(f.source.goals.read('key','opaque-current',query)?.input.messages.map(m=>m.text)).toEqual(['Build a report','Continue','sleep 100']);
  }finally{await f.source.close();}
});

it('marks the first partial loading read uncertain without needing a prior execution cache',async()=>{
  const f=setup();f.set({records:[],caughtUp:false,partialLine:true,reset:false});
  f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  expect(f.source.goals.execution?.('key','opaque-current')).toMatchObject({state:'unknown'});
  await f.source.close();
});
it('uses same-turn final/runtime evidence and not quiet duration for execution',async()=>{
  const f=setup();f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  expect(f.source.goals.execution?.('key','opaque-current')).toMatchObject({state:'running'});
  f.set({records:[{id:'result',turnId:'current',atMs:3000,kind:'tool_result',actionId:'call'},
    {id:'final',turnId:'current',atMs:4000,kind:'assistant',assistantPhase:'final',text:'Done'}],caughtUp:true,partialLine:false,reset:false});
  f.time(5500);f.source.tick();await f.flush();
  expect(f.source.goals.execution?.('key','opaque-current')).toMatchObject({state:'waiting'});
  f.set({records:[{id:'resume',turnId:'current',atMs:5000,kind:'runtime',runtime:'running'}],caughtUp:true,partialLine:false,reset:false});
  f.time(10500);f.source.tick();await f.flush();
  expect(f.source.goals.execution?.('key','opaque-current')).toMatchObject({state:'running'});
  await f.source.close();
});
it('does not use another turn final or incomplete records to claim the current turn ended',async()=>{
  const f=setup();
  f.set({records:[...records,{id:'future-final',turnId:'future',atMs:3000,kind:'assistant',assistantPhase:'final',text:'done'}],
    caughtUp:true,partialLine:false,reset:false});
  f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  expect(f.source.goals.execution?.('key','opaque-current')).toMatchObject({state:'running'});
  f.set({records:[],caughtUp:true,partialLine:true,reset:false});
  f.time(5500);f.source.tick();await f.flush();
  expect(f.source.goals.execution?.('key','opaque-current')).toMatchObject({state:'unknown',boundaryMs:500});
  await f.source.close();
});
const records:ReadBatch['records']=[{id:'old',turnId:'old',atMs:0,kind:'user',text:'Build a report'},
  {id:'u',turnId:'current',atMs:1000,kind:'user',text:'Continue'},
  {id:'call',turnId:'current',atMs:2000,kind:'tool_start',actionId:'call',text:'sleep 100'}];
function setup(){
  let time=0,wallReads=0,contents:ReadBatch={records,caughtUp:true,partialLine:false,reset:false};
  const source=createConversationSource({source:{read:async()=>contents,remove:()=>{},close:async()=>{}},
    now:()=>time,wallNow:()=>{wallReads++;return 20000;},turnKeyFor:(_host,turn)=>`opaque-${turn}`});
  return {source,wallReads:()=>wallReads,time:(n:number)=>{time=n;},set:(batch:ReadBatch)=>{contents=batch;},
    flush:()=>new Promise<void>(resolve=>setImmediate(resolve))};
}
it('reads current persisted user and tool action without needing hook content',async()=>{
  const f=setup();f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  const capture=f.source.goals.read('key','opaque-current',query);
  expect(capture?.input.messages.map(m=>m.text)).toEqual(['Build a report','Continue','sleep 100']);
  expect(capture?.input.observation).toMatchObject({historyComplete:true,activeTimeKnown:false,
    currentAction:{text:'sleep 100',elapsedSeconds:18}});
  expect(capture?.currentActionId).toBe('call');await f.source.close();
});

it('inspects eligibility without taking an inference-time snapshot',async()=>{
  const f=setup();f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  for(let n=0;n<10;n++)expect(f.source.goals.inspect?.('key','opaque-current',query)).toMatchObject({ready:true,currentActionId:'call'});
  expect(f.wallReads()).toBe(0);f.source.goals.read('key','opaque-current',query);expect(f.wallReads()).toBe(1);
  await f.source.close();
});
it('requires the authenticated current turn and never imports a later turn',async()=>{
  const f=setup();f.set({records:[...records,{id:'future',turnId:'future',atMs:3000,kind:'user',text:'another goal'}],
    caughtUp:true,partialLine:false,reset:false});
  f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  expect(f.source.goals.read('key','opaque-current',query)?.input.messages.some(m=>m.text==='another goal')).toBe(false);
  expect(f.source.goals.read('key','opaque-absent',query)).toBeNull();await f.source.close();
});
it('changes source epoch on cursor reset and does not reuse it after removal',async()=>{
  const f=setup();f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  const first=f.source.goals.epoch('key');f.set({records,caughtUp:true,partialLine:false,reset:true});
  f.time(5500);f.source.tick();await f.flush();const reset=f.source.goals.epoch('key');expect(reset).not.toBe(first);
  f.source.remove('key');expect(f.source.goals.epoch('key')).toBeNull();
  f.source.attach('key','host','opaque-current');expect(f.source.goals.epoch('key')).not.toBe(reset);await f.source.close();
});

it('drops old goal bodies after a confirmed replacement while retaining summary watermark',async()=>{
  const f=setup();f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  const capture=f.source.goals.read('key','opaque-current',{...query,goalSummary:'New goal',
    contextFloorTurnKey:'opaque-current',summaryThroughSequence:1});
  expect(capture?.input.messages.map(m=>m.text)).toEqual(['Continue','sleep 100']);
  expect(capture?.input.observation?.summaryThroughSequence).toBe(1);await f.source.close();
});

it('clears stopped content but keeps only attachment identity for a fresh resume read',async()=>{
  const f=setup();f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  const before=f.source.goals.epoch('key');f.source.stop('key');
  expect(f.source.snapshot('key')?.records).toEqual([]);
  expect(f.source.goals.epoch('key')).not.toBe(before);
  f.time(10000);f.source.tick();await f.flush();expect(f.source.snapshot('key')?.records).toEqual([]);
  f.source.setActive('key',true);f.time(10500);f.source.tick();await f.flush();
  expect(f.source.goals.read('key','opaque-current',query)).not.toBeNull();await f.source.close();
});

it('waits for the persisted final body instead of consuming commentary as final evidence',async()=>{
  const f=setup();const commentary={id:'comment',turnId:'current',atMs:3000,kind:'assistant' as const,
    text:'I am working',assistantPhase:'commentary' as const};
  f.set({records:[...records,commentary],caughtUp:true,partialLine:false,reset:false});
  f.source.attach('key','host','opaque-current');f.time(500);f.source.tick();await f.flush();
  expect(f.source.goals.inspect?.('key','opaque-current',query)?.finalAvailable).toBe(false);
  f.set({records:[{...commentary,id:'final',assistantPhase:'final'}],caughtUp:true,partialLine:false,reset:false});
  f.time(5500);f.source.tick();await f.flush();
  expect(f.source.goals.inspect?.('key','opaque-current',query)?.finalAvailable).toBe(true);await f.source.close();
});

it('releases completed attachments so later tasks do not exhaust source capacity',async()=>{
  const f=setup();
  for(let n=0;n<40;n++){
    f.source.prune(()=>false);
    f.source.attach(`key-${n}`,`host-${n}`,'opaque-current');
  }
  expect(f.source.goals.epoch('key-0')).toBeNull();
  expect(f.source.goals.epoch('key-39')).not.toBeNull();await f.source.close();
});

it('returns every distinct completed invocation after a fresh wall-time cutoff',async()=>{
  let monotonic=0,wall=20_000;
  let contents:ReadBatch={records:[
    {id:'u',turnId:'current',atMs:20_000,kind:'user',text:'Run tests'},
    {id:'running',turnId:'current',atMs:20_000,kind:'runtime',runtime:'running'},
  ],caughtUp:true,partialLine:false,reset:false};
  const source=createConversationSource({source:{read:async()=>contents,remove:()=>{},close:async()=>{}},
    now:()=>monotonic,wallNow:()=>wall,turnKeyFor:(_host,turn)=>`opaque-${turn}`});
  const scope={};source.attach('key','host','opaque-current');monotonic=500;source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  const query={...queryBase(),paceScope:scope};
  expect(source.goals.read('key','opaque-current',query)?.paceBatches).toEqual([]);
  const commandFor=(names:string[])=>`node node_modules/vitest/vitest.mjs run ${names.join(' ')} --reporter=json --maxWorkers=1 --no-file-parallelism`;
  const report=(names:string[],start:number,end:number)=>JSON.stringify({success:true,numTotalTestSuites:3,numPassedTestSuites:3,
    numFailedTestSuites:0,numPendingTestSuites:0,numTotalTests:3,numPassedTests:3,numFailedTests:0,numPendingTests:0,
    testResults:names.map((name,index)=>({name,status:'passed',message:'',startTime:start+index*500,endTime:start+index*500+200,assertionResults:[{status:'passed',failureMessages:[]}]}))});
  const tool=(id:string,start:number,end:number,names:string[])=>{
    const command=commandFor(names);return [
    {id:`${id}-start`,turnId:'current',atMs:start,kind:'tool_start' as const,actionId:id,toolName:'CommandExecution',cwd:'C:/project',command,startedAtMs:start},
    {id:`${id}-result`,turnId:'current',atMs:end,kind:'tool_result' as const,actionId:id,toolName:'CommandExecution',cwd:'C:/project',command,
      complete:true,exitCode:0,endedAtMs:end,output:report(names,start+100,end-100),outputComplete:true},
  ];};
  contents={records:[...tool('one',21_000,24_000,['tests/a.test.ts','tests/b.test.ts','tests/c.test.ts']),
    ...tool('two',25_000,28_000,['tests/d.test.ts','tests/e.test.ts','tests/f.test.ts'])],caughtUp:true,partialLine:false,reset:false};
  wall=30_000;monotonic=5_500;source.changed('key');source.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  const batches=source.goals.read('key','opaque-current',{...queryBase(),paceScope:scope})?.paceBatches??[];
  expect(batches).toHaveLength(2);
  expect(batches.map(batch=>batch.evidence.actionId)).toEqual(['one','two']);
  await source.close();
});

function queryBase(){return {goalSummary:null,activeSeconds:15,runtime:'running' as const,previousEstimate:null};}
