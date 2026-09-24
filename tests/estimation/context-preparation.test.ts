import {expect,it,vi} from 'vitest';
import {prepareContext,createContextSummaryCache} from '../../src/estimation/context-preparation.js';
import {packObserverInput} from '../../src/estimation/observer-input.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import {parseCodexCheckpoint} from '../../src/observer/codex-checkpoint.js';

const base:ObserverInput={goalSummary:null,activeSeconds:12,runtime:'running',messages:[{kind:'user',text:'projection',truncated:true}],truncated:true};
const capacity={contextTokens:1000000,outputReserveTokens:2000,requestBytes:null,source:'configured' as const};
const sizer={kind:'conservative' as const,count:(text:string)=>Buffer.byteLength(text)};
it('keeps original execution ordinals and overlap when compression evicts an inner tool',async()=>{
 const records:ConversationRecord[]=[record('req','current','user','task'),
  {...record('a','current','tool_start','long A'),actionId:'a',atMs:200},
  {...record('b','current','tool_start','inner B'),actionId:'b',atMs:300},
  {...record('br','current','tool_result','inner result'),actionId:'b',atMs:400},
  ...Array.from({length:20},(_,i)=>({...record(`fill${i}`,'current','assistant','x'.repeat(500)),atMs:500+i})),
  {...record('ar','current','tool_result','A result'),actionId:'a',atMs:1000}];
 const prepared=await prepareContext({...options(source(records)),
  capacity:{...capacity,contextTokens:6000,outputReserveTokens:500},
  compressor:{async summarize(request){return {...request,text:'summary'};}}});
 expect(prepared.representation.mode).toBe('compressed');
 expect(prepared.input.messages.some(m=>m.text==='inner B')).toBe(false);
 expect(prepared.input.executionObservations?.samples).toEqual(expect.arrayContaining([
  expect.objectContaining({startOrdinal:1,endOrdinal:24,overlapsOtherTool:true}),
  expect.objectContaining({startOrdinal:2,endOrdinal:3,overlapsOtherTool:true})]));
 expect(prepared.input.messages.find(m=>m.text==='A result')?.event?.ordinal).toBe(24);
 expect(()=>packObserverInput(prepared.input)).not.toThrow();
});
it('does not assert prefix execution evidence for incomplete source history',async()=>{
 const prepared=await prepareContext(options(source([record('req','current','user','task')],false)));
 expect(prepared.input.executionObservations).toBeUndefined();
});
it('does not drop checkpoint images on the stateless preparation path',async()=>{
 const snapshot=source([record('req','current','user','inspect')]);
 snapshot.checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[
   {type:'message',role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,AA=='}]},
   {type:'compaction',encrypted_content:'synthetic'}]}})!;
 const setup=options(snapshot);
 await expect(prepareContext(setup)).rejects.toThrow('image_context_unsupported');
 expect(setup.compressor.summarize).not.toHaveBeenCalled();
});
it('rejects image-bearing history instead of silently claiming text-only full context',async()=>{
 const image:ConversationRecord={id:'image',turnId:'current',atMs:1,kind:'user',text:'inspect',contentParts:[{type:'local_image',path:'C:/fixture/image.png'}]};
 const setup=options(source([image]));
 await expect(prepareContext(setup)).rejects.toThrow('image_context_unsupported');
 expect(setup.compressor.summarize).not.toHaveBeenCalled();
});

it('services cancellation while assembling a buffered history page',async()=>{
  const controller=new AbortController();
  const records=[record('req','current','user','task'),
    ...Array.from({length:1000},(_,i)=>record(String(i),'current','assistant','x'.repeat(256)))];
  const timer=setTimeout(()=>controller.abort(),0);
  try {
    await expect(prepareContext({...options(source(records)),signal:controller.signal}).then(()=> 'completed')).rejects.toMatchObject({name:'AbortError'});
    expect(controller.signal.aborted).toBe(true);
  } finally {clearTimeout(timer);}
});

it('services another event-loop callback without changing lossless context output',async()=>{
  let serviced=false;
  const records=[record('req','current','user','task'),
    ...Array.from({length:1000},(_,i)=>record(String(i),'current','assistant',`${i}:`+'x'.repeat(256)))];
  const timer=setTimeout(()=>{serviced=true;},0);
  try {
    const result=await prepareContext(options(source(records)));
    expect(serviced).toBe(true);
    expect(result.input.messages.map(message=>message.text)).toEqual(records.map(record=>record.text));
    expect(result.representation.mode).toBe('full');
  } finally {clearTimeout(timer);}
});

it('services cancellation inside a long suffix eviction pass',async()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,largeSizingPasses=0;
  const records=[record('req','current','user','task'),
    ...Array.from({length:256},(_,i)=>record(String(i),'old','assistant','x'.repeat(512))),
    record('large','old','assistant','marker:'+'y'.repeat(950000))];
  // Keep every history record before the current turn so overflow must trim it.
  records[0]!.turnId='old';records.push(record('current','current','user','current task'));
  const input=options(source(records));
  try {
    const result=prepareContext({...input,signal:controller.signal,serialize:packet=>{
      if(packet.messages.at(-1)?.text.startsWith('marker:')){
        largeSizingPasses++;
        if(timer===undefined)timer=setTimeout(()=>controller.abort(),0);
      }
      return JSON.stringify(packet);
    }}).then(()=> 'completed',error=>error.name);
    expect(await result).toBe('AbortError');
    expect(controller.signal.aborted).toBe(true);
    expect(largeSizingPasses).toBeLessThan(200);
    expect(input.compressor.summarize).not.toHaveBeenCalled();
  }finally{clearTimeout(timer);}
});

it('processes queued cancellation after expensive final serialization before returning success',async()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const input=options(source([record('req','current','user','task')]));
  try {
    const result=prepareContext({...input,signal:controller.signal,serialize:packet=>{
      if(packet.observation?.historyComplete){
        timer=setTimeout(()=>controller.abort(),0);
        // Simulate one indivisible expensive serializer, not a production wait.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      }
      return JSON.stringify(packet);
    }}).then(()=> 'completed',error=>error.name);
    expect(await result).toBe('AbortError');
  }finally{clearTimeout(timer);}
});

it('services cancellation during compression packing before dispatching a compressor',async()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let previousOrdinal=-1,flushObserved=false;
  const records=[...Array.from({length:40},(_,i)=>record(String(i),'old','assistant','x'.repeat(300))),
    record('req','current','user','task')];
  const input=options(source(records));
  try {
    const result=prepareContext({...input,signal:controller.signal,
      capacity:{...capacity,contextTokens:5000,outputReserveTokens:500},
      serializeCompression:request=>{
        // Overflow pops the last record before flush serializes the smaller chunk.
        if(request.lastOrdinal<previousOrdinal&&timer===undefined){
          flushObserved=true;timer=setTimeout(()=>controller.abort(),0);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
        }
        previousOrdinal=request.lastOrdinal;
        return JSON.stringify(request);
      }}).then(()=> 'completed',error=>error.name);
    expect(await result).toBe('AbortError');
    expect(flushObserved).toBe(true);
    expect(input.compressor.summarize).not.toHaveBeenCalled();
  }finally{clearTimeout(timer);}
});
function source(records:ConversationRecord[],complete=true):HistorySnapshot {
  const coverage={complete:false,gaps:complete?[]:['upstream_truncated' as const]};
  let closed=false;
  return {identity:'source',sourceEpoch:1,revision:2,coverage,
    async *records(signal){if(closed)throw Error('closed');for(const [ordinal,record] of records.entries()){
      signal.throwIfAborted();yield {ordinal,record};
    }coverage.complete=complete;},async close(){closed=true;}};
}
function record(id:string,turnId:string,kind:ConversationRecord['kind'],text:string):ConversationRecord {
  return {id,turnId,kind,text,atMs:100};
}
function options(snapshot:HistorySnapshot){return {snapshot,baseInput:base,currentTurnId:'current',observedAtMs:5100,capacity,sizer,
  serialize:JSON.stringify,serializeCompression:JSON.stringify,signal:new AbortController().signal,
  compressor:{summarize:vi.fn(async()=>{throw Error('compression forbidden');})}};}

it('preserves complete earlier and current text without compression when it fits',async()=>{
  const records=[record('old','earlier','user','old requirement'),
    record('new','current','user','sk-test-not-real '+ 'x'.repeat(5000)),
    ...Array.from({length:200},(_,i)=>record(String(i),'current','assistant',`message ${i}`))];
  const input=options(source(records));
  const result=await prepareContext(input);
  expect(result.input.messages.map(m=>m.text)).toEqual(records.map(r=>r.text));
  expect(result.input.messages[0]?.scope).toBe('background');
  expect(result.input.messages[1]?.scope).toBe('current');
  expect(result.input.activeSeconds).toBe(12);
  expect(result.representation.mode).toBe('full');
  expect(result.input.truncated).toBe(false);
  expect(input.compressor.summarize).not.toHaveBeenCalled();
  expect(result.metrics).toMatchObject({originalTextBytes:records.reduce((sum,r)=>sum+Buffer.byteLength(r.text??''),0),compressionCalls:0,cachedCompressionCalls:0});
  expect(result.metrics?.preparedRequestBytes).toBe(Buffer.byteLength(JSON.stringify(result.input)));
});

it('compresses older history only after overflow and retains current requirements and latest result',async()=>{
  const records=[...Array.from({length:40},(_,i)=>record(String(i),'earlier','assistant',`history ${i} `+'x'.repeat(300))),
    record('req','current','user','current requirement'),record('result','current','tool_result','latest result')];
  let readComplete=false;
  const snapshot=source(records);
  const original=snapshot.records.bind(snapshot);
  snapshot.records=async function*(signal){yield* original(signal);readComplete=true;};
  const requests:Array<{text:string;firstOrdinal:number;lastOrdinal:number}>=[];
  const result=await prepareContext({...options(snapshot),capacity:{...capacity,contextTokens:5000,outputReserveTokens:500},
    compressor:{async summarize(request){expect(readComplete).toBe(true);requests.push(request);return {...request,text:'Older history summarized'};}}});
  expect(result.representation.mode).toBe('compressed');
  expect(result.representation.originalRecords).toBe(42);
  expect(result.input.messages.some(m=>m.text==='current requirement')).toBe(true);
  expect(result.input.messages.at(-1)?.text).toBe('latest result');
  expect(result.input.historySummary?.text).toBe('Older history summarized');
  expect(requests.length).toBeGreaterThan(0);
  expect(JSON.stringify(requests)).toContain('history 0');
});

it('does not quietly clip a current requirement too large for the model',async()=>{
  const input=options(source([record('req','current','user','x'.repeat(10000))]));
  await expect(prepareContext({...input,capacity:{...capacity,contextTokens:3000,outputReserveTokens:500}}))
    .rejects.toThrow('context_too_large');
  expect(input.compressor.summarize).not.toHaveBeenCalled();
});

it('reports an oversized historical record with the real strict request serializer',async()=>{
  const input=options(source([record('old','earlier','tool_result','x'.repeat(20000)),record('req','current','user','task')]));
  await expect(prepareContext({...input,serialize:packObserverInput,
    capacity:{...capacity,contextTokens:3000,outputReserveTokens:500}})).rejects.toThrow('context_too_large');
});

it('rejects invalid summary coverage instead of treating omitted history as represented',async()=>{
  const records=[...Array.from({length:20},(_,i)=>record(String(i),'old','assistant','x'.repeat(300))),
    record('req','current','user','task')];
  await expect(prepareContext({...options(source(records)),capacity:{...capacity,contextTokens:4000,outputReserveTokens:500},
    compressor:{async summarize(request){return {...request,text:'summary',lastOrdinal:999};}}}))
    .rejects.toThrow('compression_invalid');
});

it('cancels after compression without returning a stale prepared input',async()=>{
  const controller=new AbortController();
  const records=[...Array.from({length:20},(_,i)=>record(String(i),'old','assistant','x'.repeat(300))),
    record('req','current','user','task')];
  await expect(prepareContext({...options(source(records)),signal:controller.signal,
    capacity:{...capacity,contextTokens:4000,outputReserveTokens:500},
    compressor:{async summarize(request){controller.abort();return {...request,text:'summary'};}}}))
    .rejects.toThrow();
});

it('reuses exact compression prefixes only within the same provider scope',async()=>{
  const records=[...Array.from({length:20},(_,i)=>record(String(i),'old','assistant','x'.repeat(300))),
    record('req','current','user','task')];
  const summaryCache=createContextSummaryCache();
  let calls=0;
  const compressor={async summarize(request:{text:string;firstOrdinal:number;lastOrdinal:number}){
    calls++;return {...request,text:'summary'};
  }};
  const run=(cacheScope:string)=>prepareContext({...options(source(records)),summaryCache,cacheScope,compressor,
    capacity:{...capacity,contextTokens:4000,outputReserveTokens:500}});
  await run('provider-A');const firstCalls=calls;
  await run('provider-A');expect(calls).toBe(firstCalls);
  await run('provider-B');expect(calls).toBeGreaterThan(firstCalls);
});

it('preserves the observation timestamp for known-wait action age',async()=>{
  const action={...record('act','current','tool_start','sleep 100'),actionId:'a'};
  const result=await prepareContext(options(source([record('req','current','user','wait'),action])));
  expect(result.input.observation?.currentAction?.elapsedSeconds).toBe(5);
});

it('clears completed tool actions even when the tool result has no readable text',async()=>{
  const action={...record('act','current','tool_start','sleep 100'),actionId:'a'};
  const end={...record('end','current','tool_result',''),actionId:'a'};
  const result=await prepareContext(options(source([record('req','current','user','wait'),action,end])));
  expect(result.input.observation?.currentAction).toBeNull();
});

it('preserves validated local pace evidence alongside full history',async()=>{
  const paceMeasurements:NonNullable<ObserverInput['paceMeasurements']>=[{
    measurementRef:'pm_'+'a'.repeat(32),workClass:'file_processing',unit:'file',
    sampleCount:3,medianSecondsPerUnit:2,clock:'tool_execution'}];
  const result=await prepareContext({...options(source([record('req','current','user','task')])),
    baseInput:{...base,paceMeasurements}});
  expect(result.input.paceMeasurements).toEqual(paceMeasurements);
  expect(()=>packObserverInput(result.input)).not.toThrow();
});

it('excludes a later turn without turning old background into current work',async()=>{
  const result=await prepareContext(options(source([record('1','old','user','old'),
    record('2','current','user','current'),record('3','future','user','future')])));
  expect(result.input.messages.map(m=>m.text)).toEqual(['old','current']);
});

it('retains source incompleteness separately from verbatim representation',async()=>{
  const result=await prepareContext(options(source([record('1','current','user','task')],false)));
  expect(result.representation.mode).toBe('incomplete');
  expect(result.input.observation?.historyComplete).toBe(false);
});

it('rejects unknown capacity and cancelled preparation without invoking a model',async()=>{
  const input=options(source([record('1','current','user','task')]));
  await expect(prepareContext({...input,capacity:null})).rejects.toThrow('capacity_unknown');
  const controller=new AbortController();controller.abort();
  await expect(prepareContext({...input,signal:controller.signal})).rejects.toThrow();
  expect(input.compressor.summarize).not.toHaveBeenCalled();
});
