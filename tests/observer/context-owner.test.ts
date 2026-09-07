import {it,expect,vi} from 'vitest';
import {createContextOwner} from '../../src/observer/context-owner.js';

function setup(){
  let now=0;const calls:Array<{id:string;signal:AbortSignal;finish:(batch:any)=>void}>=[];
  const source={read:(id:string,signal:AbortSignal)=>new Promise<any>(finish=>calls.push({id,signal,finish})),remove:()=>{},close:async()=>{}};
  const changes:string[]=[];
  const owner=createContextOwner({source,now:()=>now,onChange:key=>changes.push(key)});
  const flush=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));};
  return {owner,calls,changes,time:(n:number)=>{now=n;},flush};
}
const batch={records:[{id:'u1',turnId:'t1',atMs:0,kind:'user',text:'sleep 100'}],caughtUp:true,reset:false,partialLine:false};
it('retains first objective and latest user amendment across large current-turn output',async()=>{
  const f=setup();f.owner.attach('one','host1','t2');f.time(500);f.owner.tick();
  const amendment={id:'u2',turnId:'t2',atMs:1,kind:'user',text:'Use the amended goal'};
  f.calls[0]!.finish({...batch,records:[...batch.records,amendment,...Array.from({length:8},(_,i)=>({id:`tool${i}`,turnId:'t2',atMs:i+2,kind:'tool_result',text:'x'.repeat(60000)}))]});
  await f.flush();const value=f.owner.snapshot('one')!;
  expect(value.records.filter(r=>r.kind==='user').map(r=>r.id)).toEqual(['u1','u2']);
  expect(Buffer.byteLength(JSON.stringify(value.records))).toBeLessThanOrEqual(256*1024);
  expect(value.historyComplete).toBe(false);
});
it('stays unavailable when protected goals exceed the budget rather than reviving old context',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  f.calls[0]!.finish({...batch,records:[{...batch.records[0],text:'x'.repeat(300000)}]});await f.flush();
  expect(f.owner.snapshot('one')?.health).toBe('error');
  f.time(1500);f.owner.tick();f.calls[1]!.finish({...batch,records:[]});await f.flush();
  expect(f.owner.snapshot('one')?.health).toBe('error');
});

it('debounces source reads then publishes persisted user content without a tool result',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');
  f.time(499);f.owner.tick();expect(f.calls).toHaveLength(0);
  f.time(500);f.owner.tick();expect(f.calls).toHaveLength(1);
  f.calls[0]!.finish(batch);await f.flush();
  expect(f.owner.snapshot('one')).toMatchObject({health:'ready',revision:1,records:batch.records});
  f.time(5499);f.owner.tick();expect(f.calls).toHaveLength(1);
  f.time(5500);f.owner.tick();expect(f.calls).toHaveLength(2);
  f.calls[1]!.finish({...batch,records:[]});await f.flush();
  expect(f.owner.snapshot('one')?.revision).toBe(1);
});

it('bounds global reads to two and keeps each conversation isolated',async()=>{
  const f=setup();for(const id of ['one','two','three'])f.owner.attach(id,`host-${id}`,'t1');
  f.time(500);f.owner.tick();expect(f.calls).toHaveLength(2);
  f.owner.tick();expect(f.calls).toHaveLength(2);
  f.calls[0]!.finish(batch);await f.flush();f.owner.tick();
  expect(f.calls).toHaveLength(3);
  expect(f.owner.snapshot('two')?.records).toEqual([]);
});

it('does not resurrect removed state from a late source response',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  f.owner.remove('one');expect(f.calls[0]!.signal.aborted).toBe(true);
  f.calls[0]!.finish(batch);await f.flush();expect(f.owner.snapshot('one')).toBeNull();
});

it('pauses local reads and rebuilds explicitly after source reset',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  f.calls[0]!.finish(batch);await f.flush();
  f.owner.setActive('one',false);f.time(20000);f.owner.tick();expect(f.calls).toHaveLength(1);
  f.owner.setActive('one',true);f.time(20500);f.owner.tick();
  f.calls[1]!.finish({...batch,reset:true,records:[],caughtUp:false});await f.flush();
  expect(f.owner.snapshot('one')).toMatchObject({health:'loading',revision:2,records:[],sourceEpoch:1});
});

it('marks history complete after multiple catch-up batches without content loss',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  f.calls[0]!.finish({...batch,caughtUp:false});await f.flush();f.owner.tick();
  f.calls[1]!.finish({...batch,records:[{...batch.records[0]!,id:'u2',text:'continue'}]});await f.flush();
  expect(f.owner.snapshot('one')).toMatchObject({historyComplete:true,health:'ready',revision:2});
});

it('does not let catch-up readers starve another waiting conversation',async()=>{
  const f=setup();for(const id of ['one','two','three'])f.owner.attach(id,`host-${id}`,'t1');
  f.time(500);f.owner.tick();f.calls[0]!.finish({...batch,caughtUp:false});await f.flush();
  f.owner.tick();expect(f.calls[2]!.id).toBe('host-three');
});

it('bounds shutdown when a source ignores cancellation',async()=>{
  vi.useFakeTimers();
  try {
    const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
    const closing=f.owner.close();
    const assertion=expect(closing).rejects.toThrow('SOURCE_CLOSE_UNCONFIRMED');
    await vi.advanceTimersByTimeAsync(6000);await assertion;
    expect(f.calls[0]!.signal.aborted).toBe(true);
  } finally {vi.useRealTimers();}
});

it('does not call history complete after the reader skipped oversized records',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  f.calls[0]!.finish({...batch,historyTruncated:true});await f.flush();
  expect(f.owner.snapshot('one')).toMatchObject({health:'ready',historyComplete:false});
  f.time(5500);f.owner.tick();f.calls[1]!.finish({...batch,records:[]});await f.flush();
  expect(f.owner.snapshot('one')?.historyComplete).toBe(false);
});
