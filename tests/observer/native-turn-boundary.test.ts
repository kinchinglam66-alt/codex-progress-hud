import {describe,expect,it} from 'vitest';
import {createNativeTurnIndex} from '../../src/observer/native-turn-boundary.js';

const event=(type:string,turn_id:unknown)=>({type:'event_msg',payload:{type,turn_id}});
const user={type:'response_item',payload:{type:'message',role:'user',content:[]}};

describe('native completed-turn boundary',()=>{
  it('separates completed history from the complete current-turn prefix',()=>{
    const index=createNativeTurnIndex();
    index.observe({type:'session_meta',payload:{id:'source'}},0,10);
    index.observe(event('task_started','six'),10,20);
    index.observe(event('task_complete','six'),20,30);
    index.observe(event('task_started','seven'),30,40);
    index.observe(user,40,70);
    expect(index.snapshot()).toEqual({currentTurnId:'seven',currentStartOffset:30,
      watermark:70,completed:{turnId:'six',endOffset:30}});
  });
  it('represents a verified first active turn without inventing completed history',()=>{
    const index=createNativeTurnIndex();
    index.observe({type:'session_meta',payload:{id:'source'}},0,10);
    index.observe(event('task_started','one'),10,20);
    expect(index.snapshot()).toEqual({currentTurnId:'one',currentStartOffset:10,watermark:20,completed:null});
  });
  it.each(['task_complete','task_failed','turn_aborted'])('keeps %s as historical terminal evidence',type=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','old'),0,10);
    index.observe(event(type,'old'),10,20);
    expect(index.snapshot()).toBeNull();
    index.observe(event('task_started','new'),20,30);
    expect(index.snapshot()?.completed).toEqual({turnId:'old',endOffset:20});
  });
  it('does not move the original start on a repeated same-turn start',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','one'),0,10);
    index.observe(user,10,20);
    index.observe(event('task_started','one'),20,30);
    expect(index.snapshot()).toMatchObject({currentStartOffset:0,watermark:30});
  });
  it('does not interpret assistant final text or quoted lifecycle markers as a terminal',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','one'),0,10);
    index.observe({type:'response_item',payload:{type:'message',role:'assistant',phase:'final',
      content:[{type:'output_text',text:'task_complete turn_aborted done'}]}},10,20);
    expect(index.snapshot()).toMatchObject({currentTurnId:'one',watermark:20,completed:null});
  });
  it.each([
    event('task_complete','other'),event('task_started','other'),
    event('task_complete',undefined),event('task_started',''),event('task_started',3),
    {type:'event_msg',payload:{type:'task_started',turn_id:'one',turnId:'other'}},
    {type:'response_item',turn_id:'one',payload:{type:'message',turn_id:'other',role:'user'}},
    {type:'turn_completed',turn_id:'one'},
    {type:'event_msg',payload:{type:'turn_completed',turn_id:'one'}},
  ])('fails closed on malformed or conflicting turn control %#',envelope=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','one'),0,10);
    index.observe(envelope,10,20);
    expect(index.snapshot()).toBeNull();
    index.observe(event('task_started','one'),20,30);
    expect(index.snapshot()).toBeNull();
  });
  it('refuses an unmatched terminal before the first observed start',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_complete','old'),0,10);
    index.observe(event('task_started','new'),10,20);
    expect(index.snapshot()).toBeNull();
  });
  it('refuses a duplicated terminal rather than treating it as a fresh boundary',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','old'),0,10);
    index.observe(event('task_complete','old'),10,20);
    index.observe(event('task_complete','old'),20,30);
    index.observe(event('task_started','new'),30,40);
    expect(index.snapshot()).toBeNull();
  });
  it.each([[11,20],[9,20],[10,10],[10,9],[-1,20],[10,Infinity],[10,10.5],[10,Number.MAX_SAFE_INTEGER+1]])(
    'invalidates noncontiguous or unsafe offsets %s..%s',(start,end)=>{
      const index=createNativeTurnIndex();
      index.observe(event('task_started','one'),0,10);
      index.observe(user,start,end);
      expect(index.snapshot()).toBeNull();
    });
  it('rejects a stream that begins after unknown omitted history',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','one'),100,120);
    expect(index.snapshot()).toBeNull();
  });
  it('does not confuse arbitrary nested user payload IDs with source attribution',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','one'),0,10);
    index.observe({type:'response_item',payload:{type:'function_call',call_id:'call',
      arguments:JSON.stringify({turn_id:'unrelated',type:'task_complete'})}},10,20);
    expect(index.snapshot()).toMatchObject({currentTurnId:'one',completed:null});
  });
  it('accepts consistent explicit envelope and payload turn aliases',()=>{
    const index=createNativeTurnIndex();
    index.observe({type:'event_msg',turnId:'one',payload:{type:'task_started',turn_id:'one',turnId:'one'}},0,10);
    expect(index.snapshot()?.currentTurnId).toBe('one');
  });
  it('returns independent views so consumer mutation cannot change future boundaries',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','old'),0,10);
    index.observe(event('task_complete','old'),10,20);
    index.observe(event('task_started','new'),20,30);
    const first=index.snapshot()!;
    first.currentStartOffset=999;first.completed!.turnId='fake';
    expect(index.snapshot()).toEqual({currentTurnId:'new',currentStartOffset:20,watermark:30,
      completed:{turnId:'old',endOffset:20}});
  });
  it('stages an appended read without changing the previously committed index',()=>{
    const index=createNativeTurnIndex();
    index.observe(event('task_started','one'),0,10);
    const staged=index.copy();
    staged.observe(event('task_complete','one'),10,20);
    expect(staged.snapshot()).toBeNull();
    expect(index.snapshot()).toMatchObject({currentTurnId:'one',watermark:10});
  });
});
