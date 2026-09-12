import {createHash} from 'node:crypto';
import type {HistorySnapshot} from '../observer/history-snapshot.js';
import type {ConversationRecord} from '../observer/conversation-record.js';
import {assembleContext} from '../observer/context-assembler.js';
import type {ObserverInput} from './observer-contract.js';
import {requestFits,type ContextCapacity,type RequestSizer} from './context-capacity.js';
import type {PreparedContext} from './prepared-context.js';

interface Summary {text:string;firstOrdinal:number;lastOrdinal:number}
export interface ContextSummaryCache {
  get(key:string):Summary|undefined;
  put(key:string,value:Summary):void;
  clear():void;
}
/** Process-local summary-only LRU; never persists raw source records. */
export function createContextSummaryCache():ContextSummaryCache {
  const entries=new Map<string,Summary>();
  return {
    get(key){const value=entries.get(key);if(!value)return undefined;
      entries.delete(key);entries.set(key,value);return {...value};},
    put(key,value){
      if(Buffer.byteLength(value.text,'utf8')>64*1024)return;
      entries.delete(key);entries.set(key,{...value});
      while(entries.size>32)entries.delete(entries.keys().next().value!);
    },
    clear(){entries.clear();}
  };
}
export interface ContextPreparationOptions {
  snapshot:HistorySnapshot;
  baseInput:ObserverInput;
  currentTurnId:string;
  observedAtMs:number;
  capacity:ContextCapacity|null;
  sizer:RequestSizer;
  serialize:(input:ObserverInput)=>string;
  serializeCompression:(request:Summary)=>string;
  compressor:{summarize(request:Summary,signal:AbortSignal):Promise<Summary>};
  summaryCache?:ContextSummaryCache;
  /** Trusted provider/account/model/config identity, not conversation text. */
  cacheScope?:string;
  signal:AbortSignal;
}

/** Preparation owns the acquired snapshot, never a provider credential or task execution. */
export async function prepareContext(options:ContextPreparationOptions):Promise<PreparedContext> {
  const {snapshot,signal,baseInput,capacity}=options;
  try {
    signal.throwIfAborted();
    if(capacity===null)throw Error('capacity_unknown');
    if(!Number.isSafeInteger(options.observedAtMs)||options.observedAtMs<0)throw Error('invalid_observation_time');
    type Entry={ordinal:number;record:ConversationRecord};
    let retained:Entry[]=[];
    const requirements:Entry[]=[],active=new Map<string,Entry>();
    let latestPair:Entry[]=[];
    let currentSeen=false,laterTurn=false,overflow=false,originalRecords=0;
    const fits=(input:ObserverInput,budget=capacity)=>requestFits(options.serialize(input),budget,options.sizer);
    const suffixBudget={...capacity,contextTokens:capacity.outputReserveTokens+
      Math.max(1,Math.floor((capacity.contextTokens-capacity.outputReserveTokens)/2)),
      requestBytes:capacity.requestBytes===null?null:Math.max(1,Math.floor(capacity.requestBytes/2))};
    const protectedEntries=()=>[...requirements,...active.values(),...latestPair];
    const combined=()=>[...new Map([...retained,...protectedEntries()].map(e=>[e.ordinal,e])).values()]
      .sort((a,b)=>a.ordinal-b.ordinal);
    const trim=()=>{
      while(retained.length&&!fits(assemble(combined(),false),suffixBudget))retained.shift();
      const protectedAndRetained=combined();
      if(protectedAndRetained.length&&!fits(assemble(protectedAndRetained,false)))throw Error('context_too_large');
    };
    for await(const entry of snapshot.records(signal)) {
      signal.throwIfAborted();
      const {record}=entry;
      if(record.turnId===options.currentTurnId)currentSeen=true;
      else if(currentSeen&&record.turnId!==null)laterTurn=true;
      if(laterTurn||record.kind==='runtime'||!record.text)continue;
      originalRecords++;
      if(record.turnId===options.currentTurnId){
        if(record.kind==='user')requirements.push(entry);
        if(record.kind==='tool_start'&&record.actionId)active.set(record.actionId,entry);
        if(record.kind==='tool_result'){
          const start=record.actionId?active.get(record.actionId):undefined;
          latestPair=start?[start,entry]:[entry];
          if(record.actionId)active.delete(record.actionId);
        }
      }
      retained.push(entry);
      if(!overflow&&!fits(assemble(retained,false)))overflow=true;
      if(overflow)trim();
    }
    if(!currentSeen)throw Error('current_turn_missing');
    signal.throwIfAborted();
    let summary:Summary|undefined;
    if(overflow){
      // Earliest suffix item, not a protected requirement repeated verbatim.
      const cutoff=retained[0]?.ordinal??Math.max(...protectedEntries().map(e=>e.ordinal));
      if(!Number.isSafeInteger(cutoff)||cutoff<=0)throw Error('context_too_large');
      let chunk:Array<{ordinal:number;kind:string;text:string;atMs:number}>=[];
      const makeRequest=():Summary=>({firstOrdinal:0,lastOrdinal:chunk.at(-1)!.ordinal,
        text:JSON.stringify({previousSummary:summary?.text??null,records:chunk})});
      const flush=async()=>{
        if(!chunk.length)return;
        signal.throwIfAborted();
        const request=makeRequest();
        if(!requestFits(options.serializeCompression(request),capacity,options.sizer))throw Error('context_too_large');
        const cacheKey=options.cacheScope?createHash('sha256').update(JSON.stringify({
          version:1,scope:options.cacheScope,source:snapshot.identity,epoch:snapshot.sourceEpoch,
          capacity,request
        })).digest('hex'):undefined;
        const cached=cacheKey?options.summaryCache?.get(cacheKey):undefined;
        const answer=cached??await options.compressor.summarize(request,signal);
        signal.throwIfAborted();
        if(!answer||typeof answer.text!=='string'||!answer.text.trim()||
          answer.firstOrdinal!==request.firstOrdinal||answer.lastOrdinal!==request.lastOrdinal)
          throw Error('compression_invalid');
        if(cacheKey&&!cached)options.summaryCache?.put(cacheKey,answer);
        summary={...answer};chunk=[];
      };
      for await(const {ordinal,record} of snapshot.records(signal)){
        signal.throwIfAborted();
        if(ordinal>=cutoff)break;
        if(!record.text||record.kind==='runtime')continue;
        const item={ordinal,kind:record.kind,text:record.text,atMs:record.atMs};
        chunk.push(item);
        if(!requestFits(options.serializeCompression(makeRequest()),capacity,options.sizer)){
          chunk.pop();await flush();chunk.push(item);
          if(!requestFits(options.serializeCompression(makeRequest()),capacity,options.sizer))throw Error('context_too_large');
        }
      }
      await flush();
      if(!summary)throw Error('context_too_large');
    }
    const selected=overflow?combined():retained;
    const input=assemble(selected,snapshot.coverage.complete);
    input.representation!.originalRecords=originalRecords;
    if(summary){input.historySummary=summary;input.representation!.mode='compressed';
      input.representation!.compressedThroughOrdinal=summary.lastOrdinal;input.truncated=true;}
    if(!fits(input))throw Error('context_too_large');
    return {input,representation:input.representation!};
  } finally {await snapshot.close();}

  function assemble(entries:Array<{ordinal:number;record:ConversationRecord}>,complete:boolean):ObserverInput {
    if(!entries.length)throw Error('context_missing');
    const records=entries.map(e=>e.record);
    const observation=baseInput.observation;
    const packet=assembleContext(records,{summary:baseInput.goalSummary,
      summaryThroughSequence:Math.min(observation?.summaryThroughSequence??0,snapshot.revision),
      sequence:snapshot.revision,activeSeconds:baseInput.activeSeconds,
      activeTimeKnown:observation?.activeTimeKnown??false,historyComplete:complete,
      nowMs:options.observedAtMs,previousEstimate:observation?.previousEstimate??null,
      runtime:baseInput.runtime,currentTurnId:options.currentTurnId});
    if(baseInput.paceMeasurements)packet.paceMeasurements=baseInput.paceMeasurements.map(value=>({...value}));
    packet.representation={mode:complete?'full':'incomplete',sourceComplete:complete,
      originalRecords:packet.messages.length,compressedThroughOrdinal:null,sizing:options.sizer.kind};
    for(const [index,message] of packet.messages.entries())if(message.event)message.event.ordinal=entries[index]!.ordinal;
    return packet;
  }
}
