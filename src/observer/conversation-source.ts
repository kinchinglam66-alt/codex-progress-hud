import {createContextOwner} from './context-owner.js';
import {createHash} from 'node:crypto';
import {assembleContext} from './context-assembler.js';
import type {GoalContextSource,GoalContextQuery} from '../server/passive-goals.js';
import {parsePaceEvidence, type PaceContinuity, type PaceWindow} from '../estimation/pace-measurements.js';

type OwnerOptions=Parameters<typeof createContextOwner>[0];
interface Binding {hostId:string;turnKey:string;epoch:number;sourceEpoch:number}

/** One selected source per authenticated attachment. Raw identities stay local. */
export function createConversationSource(options:OwnerOptions & {
  wallNow:()=>number;turnKeyFor:(hostId:string,turnId:string)=>string;
}) {
  const bindings=new Map<string,Binding>(),scopesByKey=new Map<string,object>();
  const measurementStates=new WeakMap<object,{sourceEpoch:number;cutoffMs:number}>();
  const measurementEpochs=new Map<string,{health:ContextHealth;historyComplete:boolean;partialLine:boolean;epoch:number}>();
  type ContextHealth='loading'|'ready'|'error'|'missing';
  let owner!:ReturnType<typeof createContextOwner>;
  const invalidateScopes=(key:string)=>{const scope=scopesByKey.get(key);if(scope!==undefined)measurementStates.delete(scope);scopesByKey.delete(key);};
  const observeHealth=(key:string)=>{
    const snapshot=owner.snapshot(key);
    const health=(snapshot?.health??'missing') as ContextHealth;
    const previous=measurementEpochs.get(key);
    const historyComplete=snapshot?.historyComplete??false,partialLine=snapshot?.partialLine??true;
    if(previous&&(previous.health!==health||previous.historyComplete!==historyComplete||previous.partialLine!==partialLine)&&(
      previous.health!=='ready'||health!=='ready'||previous.historyComplete!==historyComplete||previous.partialLine!==partialLine)){
      previous.epoch++;invalidateScopes(key);
    }
    measurementEpochs.set(key,{health,historyComplete,partialLine,epoch:previous?.epoch??0});
    return measurementEpochs.get(key)!.epoch;
  };
  owner=createContextOwner({...options,onChange:key=>{observeHealth(key);options.onChange?.(key);}});
  let nextEpoch=0;
  const allocate=()=>{if(nextEpoch>=Number.MAX_SAFE_INTEGER)throw Error('SOURCE_EPOCH_LIMIT');return ++nextEpoch;};
  const epoch=(key:string):number|null=>{
    const binding=bindings.get(key),sourceEpoch=owner.sourceEpoch(key);
    if(!binding||sourceEpoch===null)return null;
    if(binding.sourceEpoch!==sourceEpoch){binding.sourceEpoch=sourceEpoch;binding.epoch=allocate();}
    return binding.epoch;
  };
  const select=(key:string,turnKey:string,query:GoalContextQuery)=>{
    const binding=bindings.get(key),snapshot=owner.snapshot(key),currentEpoch=epoch(key);
    if(!binding||binding.turnKey!==turnKey||!snapshot||snapshot.health==='error'||currentEpoch===null)return null;
    const matches=(turnId:string|null)=>turnId!==null&&options.turnKeyFor(binding.hostId,turnId)===turnKey;
    const start=snapshot.records.findIndex(record=>matches(record.turnId));
    if(start<0)return null;
    // Bound the snapshot at the end of the authenticated turn. A later on-disk
    // turn cannot silently change which goal this attachment sends to inference.
    let end=start;
    while(end<snapshot.records.length&&matches(snapshot.records[end]!.turnId))end++;
    const floor=query.contextFloorTurnKey===undefined?0:snapshot.records.findIndex(record=>record.turnId!==null&&
      options.turnKeyFor(binding.hostId,record.turnId)===query.contextFloorTurnKey);
    const records=snapshot.records.slice(floor<0?start:floor,end);
    const current=snapshot.records.slice(start,end),actions=new Map<string,boolean>();
    for(const record of current){
      if(record.kind==='tool_start'&&record.actionId)actions.set(record.actionId,true);
      if(record.kind==='tool_result'&&record.actionId)actions.delete(record.actionId);
    }
    const finalAvailable=current.some(record=>record.kind==='assistant'&&record.assistantPhase==='final');
    // Local proof of unchanged instructions, never a public identity or model input.
    // Also fence later user turns already persisted before their Hook arrives.
    // They affect local validity only; `records` sent to inference stays turn-bounded.
    const userFingerprint=createHash('sha256').update(JSON.stringify(snapshot.records.filter(r=>r.kind==='user')
      .map(r=>[r.id,r.turnId,r.text??'']))).digest('hex');
    return {snapshot,hostId:binding.hostId,turnKey:binding.turnKey,currentEpoch,floor,records,current,actions,finalAvailable,userFingerprint};
  };
  const paceContinuity=(selected:NonNullable<ReturnType<typeof select>>,evidence:ReturnType<typeof parsePaceEvidence>):PaceContinuity=>{
    const endMs=options.wallNow();
    const matches=(record:{turnId:string|null})=>record.turnId!==null&&options.turnKeyFor(selected.hostId,record.turnId)===selected.turnKey;
    const runtime=selected.snapshot.records.filter(record=>record.kind==='runtime'&&matches(record)).sort((left,right)=>left.atMs-right.atMs);
    const runningWindows:PaceWindow[]=[];let runningStart:number|null=null;
    for(const record of runtime){
      if(record.runtime==='running'&&runningStart===null)runningStart=record.atMs;
      else if(record.runtime!=='running'&&runningStart!==null){if(record.atMs>runningStart)runningWindows.push({startMs:runningStart,endMs:record.atMs});runningStart=null;}
    }
    if(runningStart!==null&&endMs>runningStart)runningWindows.push({startMs:runningStart,endMs:endMs});
    const actions=new Map<string,{startMs:number;endMs:number}>();
    for(const record of selected.current){
      if(record.kind==='tool_start'&&record.actionId)actions.set(record.actionId,{startMs:record.startedAtMs??record.atMs,endMs:endMs});
      if(record.kind==='tool_result'&&record.actionId){const action=actions.get(record.actionId);if(action)action.endMs=record.endedAtMs??record.atMs;}
    }
    return {sourceEpoch:selected.currentEpoch,historyComplete:selected.snapshot.historyComplete&&!selected.snapshot.partialLine&&selected.floor>=0,
      runningWindows,competingActionWindows:[...actions.entries()].filter(([actionId])=>actionId!==evidence?.actionId).map(([,window])=>window)};
  };
  const paceFor=(key:string,selected:NonNullable<ReturnType<typeof select>>,query:GoalContextQuery)=>{
    if(!query.paceScope)return {};
    const scope=query.paceScope;const previousScope=scopesByKey.get(key);
    if(previousScope!==undefined&&previousScope!==scope)measurementStates.delete(previousScope);
    scopesByKey.set(key,scope);
    const state=measurementStates.get(scope);
    const cutoff=state?.sourceEpoch===selected.currentEpoch?state.cutoffMs:(measurementStates.set(scope,{sourceEpoch:selected.currentEpoch,cutoffMs:options.wallNow()}),measurementStates.get(scope)!.cutoffMs);
    const actionKeys=[...new Set(selected.current.filter(record=>record.actionId&&
      (record.kind==='tool_start'||record.kind==='tool_result')).map(record=>`${record.turnId}\u0000${record.actionId}`))];
    const paceBatches=actionKeys.map(keyValue=>{
      const records=selected.current.filter(record=>`${record.turnId}\u0000${record.actionId}`===keyValue);
      const evidence=parsePaceEvidence(records);
      if(!evidence)return null;
      const continuity=paceContinuity(selected,evidence);
      return {evidence,continuity:evidence.startedAtMs>=cutoff?continuity:{...continuity,runningWindows:[]}};
    }).filter((batch):batch is {evidence:NonNullable<ReturnType<typeof parsePaceEvidence>>;continuity:PaceContinuity}=>batch!==null);
    return {paceBatches,measurementEpoch:observeHealth(key)};
  };
  const measurementEpoch=(key:string):number|null=>bindings.has(key)?observeHealth(key):null;
  const goals:GoalContextSource={epoch,measurementEpoch,inspect(key,turnKey,query){
    const selected=select(key,turnKey,query);if(!selected)return null;
    return {revision:selected.snapshot.revision,userFingerprint:selected.userFingerprint,currentActionId:[...selected.actions.keys()].at(-1)??null,
      finalAvailable:selected.finalAvailable,
      ready:selected.records.some(record=>!!record.text&&(record.kind==='user'||
        (query.goalSummary!==null&&record.kind!=='runtime')))};
  },read(key,turnKey,query){
    const selected=select(key,turnKey,query);if(!selected)return null;
    const {snapshot,currentEpoch,floor,records,actions,finalAvailable}=selected;
    try{
      const input=assembleContext(records,{summary:query.goalSummary,
        summaryThroughSequence:Math.min(query.summaryThroughSequence??0,snapshot.revision),
        sequence:snapshot.revision,activeSeconds:query.activeSeconds,activeTimeKnown:false,
        historyComplete:snapshot.historyComplete&&floor>=0,nowMs:options.wallNow(),previousEstimate:query.previousEstimate,
        runtime:query.runtime});
      return {epoch:currentEpoch,revision:snapshot.revision,userFingerprint:selected.userFingerprint,input,
        currentActionId:[...actions.keys()].at(-1)??null,
        finalAvailable,...paceFor(key,selected,query)};
    }catch{return null;}
  }};
  return {
    goals,
    attach(key:string,hostId:string,turnKey:string):void {
      const existing=bindings.get(key);
      if(existing&&existing.hostId!==hostId)invalidateScopes(key);
      owner.attach(key,hostId,turnKey);
      if(!existing||existing.hostId!==hostId)bindings.set(key,{hostId,turnKey,epoch:allocate(),sourceEpoch:0});
      else existing.turnKey=turnKey;
    },
    changed:owner.changed,setActive:owner.setActive,tick:owner.tick,snapshot:owner.snapshot,
    stop(key:string):void {
      const binding=bindings.get(key);if(!binding)return;
      owner.remove(key);invalidateScopes(key);owner.attach(key,binding.hostId,binding.turnKey);owner.setActive(key,false);
      binding.epoch=allocate();binding.sourceEpoch=0;
    },
    remove(key:string):void {owner.remove(key);bindings.delete(key);invalidateScopes(key);measurementEpochs.delete(key);},
    prune(retain:(key:string)=>boolean):void {
      for(const key of bindings.keys())if(!retain(key)){owner.remove(key);bindings.delete(key);invalidateScopes(key);measurementEpochs.delete(key);}
    },
    measurementEpoch,
    async close():Promise<void>{bindings.clear();scopesByKey.clear();measurementEpochs.clear();await owner.close();}
  };
}
