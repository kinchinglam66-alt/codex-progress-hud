import {expect,it,vi} from 'vitest';
import {withContextPreparation} from '../../src/estimation/context-worker.js';
import type {ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';

const input={goalSummary:null,activeSeconds:2,runtime:'running' as const,messages:[{kind:'user' as const,text:'projection',truncated:true}],truncated:true};
function history():HistorySnapshot {return {identity:'s',sourceEpoch:1,revision:1,coverage:{complete:true,gaps:[]},
  async *records(){yield {ordinal:0,record:{id:'r',turnId:'turn',kind:'user',text:'full task',atMs:1}};},close:vi.fn(async()=>{})};}
function provider():ObserverWorker{return {observe:vi.fn(async()=>({status:'disabled' as const,interpretation:null,usage:null})),
  status:()=>({active:false,disabled:false,poisoned:false}),disable:vi.fn(),close:vi.fn(async()=>{})};}
const configuration={capacity:{contextTokens:10000,outputReserveTokens:1000,requestBytes:null,source:'configured' as const},
  sizer:{kind:'conservative' as const,count:(s:string)=>Buffer.byteLength(s)},serialize:JSON.stringify,serializeCompression:JSON.stringify,
  compressor:{summarize:vi.fn(async()=>{throw Error('forbidden');})}};

it('prepares full input without calling ETA or compression under capacity',async()=>{
  const delegate=provider(),snapshot=history();
  const worker=withContextPreparation(delegate,async()=>configuration);
  const result=await worker.prepareContext!(input,{snapshot,currentTurnId:'turn'},new AbortController().signal,'key',1,2000);
  expect(result.input.messages[0]?.text).toBe('full task');
  expect(delegate.observe).not.toHaveBeenCalled();
  expect(configuration.compressor.summarize).not.toHaveBeenCalled();
  expect(worker.status().active).toBe(false);
  expect(snapshot.close).toHaveBeenCalled();
});

it('disable cancels pending configuration and prevents later inference',async()=>{
  let resolve!: (value:typeof configuration)=>void;
  const promise=new Promise<typeof configuration>(done=>{resolve=done;});
  const delegate=provider(),snapshot=history();
  const worker=withContextPreparation(delegate,()=>promise);
  const pending=worker.prepareContext!(input,{snapshot,currentTurnId:'turn'},new AbortController().signal,'key',1,2000);
  const rejected=expect(pending).rejects.toThrow();
  expect(worker.status().active).toBe(true);
  worker.disable();resolve(configuration);await rejected;
  expect((await worker.observe(input,new AbortController().signal,'key')).status).toBe('disabled');
  expect(delegate.observe).not.toHaveBeenCalled();
  expect(snapshot.close).toHaveBeenCalled();
  await worker.close();
});
