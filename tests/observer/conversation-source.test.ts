import {expect,it} from 'vitest';
import {createConversationSource} from '../../src/observer/conversation-source.js';
import type {ReadBatch} from '../../src/observer/conversation-record.js';

const query={goalSummary:null,activeSeconds:15,runtime:'running' as const,previousEstimate:null};
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
