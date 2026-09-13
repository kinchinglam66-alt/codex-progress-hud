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
it('retains image delivery requirements after projection eviction until source reset',async()=>{
  const f=setup();
  try{
    f.owner.attach('one','host1','t3');f.time(500);f.owner.tick();
    f.calls[0]!.finish({...batch,records:[...batch.records,
      {id:'image',turnId:'old',atMs:1,kind:'user',imageCount:1},
      ...Array.from({length:600},(_,i)=>({id:`r${i}`,turnId:'t1',atMs:i+2,kind:'tool_result',text:'x'.repeat(512)})),
      {id:'latest',turnId:'t3',atMs:999,kind:'user',text:'continue'}]});await f.flush();
    expect(f.owner.snapshot('one')!.records.some(r=>r.id==='image')).toBe(false);
    expect(f.owner.snapshot('one')).toMatchObject({imageContextPending:true});
    f.time(5500);f.owner.tick();f.calls[1]!.finish({...batch,records:[]});await f.flush();
    expect(f.owner.snapshot('one')).toMatchObject({imageContextPending:true});
    f.time(10500);f.owner.tick();f.calls[2]!.finish({...batch,reset:true});await f.flush();
    expect(f.owner.snapshot('one')).toMatchObject({imageContextPending:false});
  }finally{await f.owner.close();}
});
it('conservatively invalidates old instruction replays beyond the dedupe window and resets identity on source rebuild',async()=>{
  const f=setup();
  try{
    f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();f.calls[0]!.finish(batch);await f.flush();
    const initial=f.owner.snapshot('one')!.instructionFingerprint;
    f.time(5500);f.owner.tick();f.calls[1]!.finish({...batch,records:Array.from({length:4097},(_,i)=>({
      id:`u-${i}`,turnId:'t1',atMs:i+1,kind:'user',text:`instruction ${i}`}))});await f.flush();
    const expanded=f.owner.snapshot('one')!.instructionFingerprint;expect(expanded).not.toBe(initial);
    f.time(10500);f.owner.tick();f.calls[2]!.finish(batch);await f.flush();
    expect(f.owner.snapshot('one')!.instructionFingerprint).not.toBe(expanded);
    f.time(15500);f.owner.tick();f.calls[3]!.finish({...batch,reset:true});await f.flush();
    expect(f.owner.snapshot('one')!.instructionFingerprint).toBe(initial);
    expect(f.owner.snapshot('one')!.sourceEpoch).toBe(1);
  }finally{await f.owner.close();}
});
it('research attribution does not consume the production context retention budget',async()=>{
  const ordinary=setup(),research=setup();
  const records=[...batch.records,...Array.from({length:600},(_,i)=>({id:`r${i}`,turnId:'t1',atMs:i+1,kind:'tool_result',text:'x'.repeat(512)}))];
  try{
    for(const f of [ordinary,research]){f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();}
    ordinary.calls[0]!.finish({...batch,records});
    research.calls[0]!.finish({...batch,records:records.map(r=>({...r,sourceTurnId:'t1'}))});
    await ordinary.flush();await research.flush();
    const a=ordinary.owner.snapshot('one')!,b=research.owner.snapshot('one')!;
    expect(b.health).toBe(a.health);expect(b.historyComplete).toBe(a.historyComplete);
    expect(b.records.map(({sourceTurnId:_research,...record})=>record)).toEqual(a.records);
    expect(b.records.every(r=>r.sourceTurnId==='t1')).toBe(true);
  }finally{await ordinary.owner.close();await research.owner.close();}
});
it('times out a stuck read, retries, and ignores its late result after recovery',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const f=setup();
  try{
    f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
    f.time(15500);await vi.advanceTimersByTimeAsync(15000);
    expect(f.owner.snapshot('one')).toMatchObject({health:'error',reason:'source_read_timeout'});
    expect(f.calls[0]!.signal.aborted).toBe(true);
    f.time(16500);f.owner.tick();expect(f.calls).toHaveLength(2);
    f.calls[1]!.finish(batch);await f.flush();
    expect(f.owner.snapshot('one')).toMatchObject({health:'ready',records:batch.records});
    f.calls[0]!.finish({...batch,reset:true,records:[]});await f.flush();
    expect(f.owner.snapshot('one')).toMatchObject({health:'ready',records:batch.records});
  }finally{for(const call of f.calls)call.finish(batch);await f.flush();await f.owner.close();vi.useRealTimers();}
});
it('bounds abandoned reads while making their blocked state explicit',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const f=setup();
  try{
    f.owner.attach('one','host1','t1');
    for(let i=0;i<6;i++){
      f.time(500+i*20000);f.owner.tick();f.time(15500+i*20000);await vi.advanceTimersByTimeAsync(15000);
    }
    expect(f.calls).toHaveLength(4);
    expect(f.owner.snapshot('one')?.health).toBe('error');
    f.calls[0]!.finish(batch);await f.flush();f.time(130000);f.owner.tick();
    expect(f.calls).toHaveLength(5);
    f.calls[4]!.finish(batch);await f.flush();expect(f.owner.snapshot('one')?.health).toBe('ready');
  }finally{for(const call of f.calls)call.finish(batch);await f.flush();await f.owner.close();vi.useRealTimers();}
});
it('trims a large catch-up batch in one sizing pass while preserving the current goal and newest output',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  const records=[...batch.records,...Array.from({length:2000},(_,i)=>({id:`r${i}`,turnId:'t1',atMs:i+1,kind:'tool_result',text:'x'.repeat(512)}))];
  const original=JSON.stringify;
  let serializedBytes=0;
  const spy=vi.spyOn(JSON,'stringify').mockImplementation(((value:unknown)=>{
    const encoded=original(value);serializedBytes+=encoded?.length??0;return encoded;
  }) as typeof JSON.stringify);
  try {f.calls[0]!.finish({...batch,records});await f.flush();} finally {spy.mockRestore();}
  const snapshot=f.owner.snapshot('one')!;
  expect(snapshot.health).toBe('ready');
  expect(snapshot.records[0]?.id).toBe('u1');
  expect(snapshot.records.at(-1)?.id).toBe('r1999');
  expect(Buffer.byteLength(JSON.stringify(snapshot.records))).toBeLessThanOrEqual(256*1024);
  expect(serializedBytes).toBeLessThan(2*1024*1024);
  await f.owner.close();
});
it('retains first objective and latest user amendment across large current-turn output',async()=>{
  const f=setup();f.owner.attach('one','host1','t2');f.time(500);f.owner.tick();
  const amendment={id:'u2',turnId:'t2',atMs:1,kind:'user',text:'Use the amended goal'};
  f.calls[0]!.finish({...batch,records:[...batch.records,amendment,...Array.from({length:8},(_,i)=>({id:`tool${i}`,turnId:'t2',atMs:i+2,kind:'tool_result',text:'x'.repeat(60000)}))]});
  await f.flush();const value=f.owner.snapshot('one')!;
  expect(value.records.filter(r=>r.kind==='user').map(r=>r.id)).toEqual(['u1','u2']);
  expect(Buffer.byteLength(JSON.stringify(value.records))).toBeLessThanOrEqual(256*1024);
  expect(value.historyComplete).toBe(false);
});
it('bounds a huge protected goal projection rather than blocking independent history reads',async()=>{
  const f=setup();f.owner.attach('one','host1','t1');f.time(500);f.owner.tick();
  f.calls[0]!.finish({...batch,records:[{...batch.records[0],text:'x'.repeat(300000)}]});await f.flush();
  expect(f.owner.snapshot('one')).toMatchObject({health:'ready',projectionOnly:true,historyComplete:false});
  expect(f.owner.snapshot('one')!.records[0]!.text!.length).toBeLessThan(300000);
  f.time(5500);f.owner.tick();f.calls[1]!.finish({...batch,records:[]});await f.flush();
  expect(f.owner.snapshot('one')?.health).toBe('ready');
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
  expect(f.owner.snapshot('one')?.lastSuccessfulReadAt).toBe(5500);
  const notifications=f.changes.length;
  f.time(10500);f.owner.tick();f.calls[2]!.finish({...batch,records:[],partialLine:true});await f.flush();
  expect(f.changes.length).toBe(notifications+1);
  expect(f.owner.snapshot('one')?.lastSuccessfulReadAt).toBe(5500);
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
