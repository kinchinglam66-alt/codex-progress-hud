import {createContextOwner} from './context-owner.js';
import {createHash} from 'node:crypto';
import {assembleContext} from './context-assembler.js';
import type {GoalContextSource,GoalContextQuery} from '../server/passive-goals.js';
import {parsePaceEvidence, type PaceContinuity, type PaceWindow} from '../estimation/pace-measurements.js';
import type {HistorySnapshot} from './history-snapshot.js';
import type {NativeSourceDestination,OpenNativeSourceResult,BoundNativeTurnSource} from './native-source-request.js';
import {createPrefixFingerprint} from '../estimation/residual/fingerprint.js';

type OwnerOptions=Parameters<typeof createContextOwner>[0];
interface Binding {hostId:string;turnKey:string;epoch:number;sourceEpoch:number}

/** One selected source per authenticated attachment. Raw identities stay local. */
export function createConversationSource(options:OwnerOptions & {
  wallNow:()=>number;turnKeyFor:(hostId:string,turnId:string)=>string;
  taskHandleFor?:(hostId:string,turnId:string)=>string;
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
    // Unattributed records are not a new authenticated turn, but must not be
    // sent as if they belonged to this one. Only an explicit different turn
    // closes the boundary; later same-turn records beyond it remain excluded.
    while(end<snapshot.records.length&&(snapshot.records[end]!.turnId===null||matches(snapshot.records[end]!.turnId)))end++;
    const floor=query.contextFloorTurnKey===undefined?0:snapshot.records.findIndex(record=>record.turnId!==null&&
      options.turnKeyFor(binding.hostId,record.turnId)===query.contextFloorTurnKey);
    const records=snapshot.records.slice(floor<0?start:floor,end).filter(record=>record.turnId!==null);
    const current=snapshot.records.slice(start,end).filter(record=>matches(record.turnId)),actions=new Map<string,boolean>();
    for(const record of current){
      if(record.kind==='tool_start'&&record.actionId)actions.set(record.actionId,true);
      if(record.kind==='tool_result'&&record.actionId)actions.delete(record.actionId);
    }
    const finalAvailable=current.some(record=>record.kind==='assistant'&&record.assistantPhase==='final');
    // Content identity intentionally excludes record ids, timestamps, runtime
    // state and other source bookkeeping so it represents only current-turn
    // text that could improve an inference.
    const contentFingerprint=createHash('sha256').update(JSON.stringify(current
      .filter(record=>record.kind!=='runtime'&&(!!record.text||(record.imageCount??0)>0))
      .map(record=>[record.kind,record.text,record.imageFingerprint??null]))).digest('hex');
    // Local proof of unchanged instructions, never a public identity or model input.
    // Also fence later user turns already persisted before their Hook arrives.
    // They affect local validity only; `records` sent to inference stays turn-bounded.
    const userFingerprint=snapshot.instructionFingerprint;
    const nextTurn=snapshot.records[end];
    return {snapshot,hostId:binding.hostId,turnKey:binding.turnKey,currentEpoch,floor,records,current,
      currentTurnId:current[0]?.turnId??null,actions,finalAvailable,userFingerprint,contentFingerprint,nextTurn};
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
  const executionCache=new Map<string,{identity:string;boundaryMs:number;trustedAt:number}>();
  const researchBridges=new Map<string,{epoch:number;offset:number;reliable:boolean}>();
  const takeover=(key:string,turnKey:string)=>{
    const binding=bindings.get(key),snapshot=owner.snapshot(key);
    if(!binding||binding.turnKey!==turnKey||!snapshot||snapshot.health!=='ready'||
      !snapshot.historyComplete||snapshot.partialLine)return null;
    const selected=select(key,turnKey,{goalSummary:null,activeSeconds:0,runtime:'running',previousEstimate:null});
    if(!selected?.nextTurn||selected.nextTurn.kind!=='runtime'||selected.nextTurn.runtime!=='running')return null;
    const previousRuntime=selected.current.filter(record=>record.kind==='runtime').at(-1);
    if(!previousRuntime||previousRuntime.runtime==='running'||selected.nextTurn.atMs<previousRuntime.atMs)return null;
    const nextTurnId=selected.nextTurn.turnId;
    if(nextTurnId===null)return null;
    const nextTurnKey=options.turnKeyFor(binding.hostId,nextTurnId);
    const identity=`${selected.currentEpoch}:${snapshot.revision}:${selected.nextTurn.id}:${nextTurnKey}`;
    binding.turnKey=nextTurnKey;binding.epoch=allocate();executionCache.delete(key);invalidateScopes(key);
    owner.attach(key,binding.hostId,nextTurnKey);
    return {turnKey:nextTurnKey,startedAtMs:selected.nextTurn.atMs,identity,
      ...(options.taskHandleFor===undefined?{}:{taskHandle:options.taskHandleFor(binding.hostId,nextTurnId)})};
  };
  const openHistory=async(key:string,turnKey:string,signal:AbortSignal):Promise<{snapshot:HistorySnapshot;currentTurnId:string}|null>=>{
    const binding=bindings.get(key);
    if(!binding||binding.turnKey!==turnKey)return null;
    const result=await owner.openHistory(key,turnKey,signal);
    const current=bindings.get(key);
    if(result!==null&&(!current||current!==binding||current.turnKey!==turnKey)){
      await result.snapshot.close();
      throw Object.assign(new Error('source history binding changed'),{code:'SOURCE_HISTORY_BINDING_CHANGED'});
    }
    return result;
  };
  const openNativeSource=async(key:string,turnKey:string,signal:AbortSignal,destination:NativeSourceDestination):Promise<OpenNativeSourceResult|null>=>{
    const binding=bindings.get(key);
    if(!binding||binding.turnKey!==turnKey)return null;
    const result=await owner.openNativeSource(key,turnKey,signal,destination);
    const current=bindings.get(key);
    if(result!==null&&(!current||current!==binding||current.turnKey!==turnKey)){
      await result.snapshot.close();
      throw Object.assign(new Error('source history binding changed'),{code:'SOURCE_HISTORY_BINDING_CHANGED'});
    }
    return result;
  };
  const openNativeTurn=async(key:string,turnKey:string,signal:AbortSignal):Promise<BoundNativeTurnSource|null>=>{
    const binding=bindings.get(key);
    if(!binding||binding.turnKey!==turnKey)return null;
    const result=await owner.openNativeTurn(key,turnKey,signal);
    const current=bindings.get(key);
    if(result!==null&&(!current||current!==binding||current.turnKey!==turnKey)){
      await result.close();throw Object.assign(new Error('source history binding changed'),{code:'SOURCE_HISTORY_BINDING_CHANGED'});
    }
    return result;
  };
  const goals:GoalContextSource={epoch,measurementEpoch,health:owner.health,execution(key,turnKey){
    const snapshot=owner.snapshot(key),binding=bindings.get(key);
    if(!binding||binding.turnKey!==turnKey||!snapshot)return null;
    const previous=executionCache.get(key),now=options.now();
    const trustedAt=snapshot.lastSuccessfulReadAt??previous?.trustedAt;
    if(snapshot.health==='loading')return previous||snapshot.partialLine?{state:'unknown',identity:`${turnKey}:loading:${snapshot.sourceEpoch}`,
      ...(trustedAt===undefined?{}:{boundaryMs:trustedAt})}:null;
    if(snapshot.health==='error'||snapshot.partialLine)return {state:'unknown',identity:`${turnKey}:unavailable:${snapshot.sourceEpoch}`,
      ...(trustedAt===undefined?{}:{boundaryMs:trustedAt})};
    const selected=select(key,turnKey,{goalSummary:null,activeSeconds:0,runtime:'running',previousEstimate:null});
    if(!selected)return {state:'unknown',identity:`${turnKey}:missing:${snapshot.sourceEpoch}`,boundaryMs:previous?.trustedAt??now};
    // Terminal evidence is not undone by a late tool result. Only a subsequent
    // actual start/runtime event establishes another running interval.
    let record=selected.current.filter(r=>r.kind==='runtime'||r.kind==='user'||r.kind==='tool_start'||
      (r.kind==='assistant'&&r.assistantPhase==='final')).at(-1);
    if(!record)return null;
    const latestRuntime=selected.current.filter(r=>r.kind==='runtime').at(-1);
    if(latestRuntime&&latestRuntime.runtime!=='running')record=latestRuntime;
    let state:NonNullable<ReturnType<NonNullable<GoalContextSource['execution']>>>['state']=record.kind==='runtime'?(record.runtime??'unknown'):
      record.kind==='assistant'?(selected.actions.size===0?'waiting':'unknown'):'running';
    const outcome=record.kind==='runtime'?record.outcome:undefined;
    // A new persisted start fences the old clock even if its Hook is delayed.
    // It does not authorize importing the new turn or claiming goal completion.
    const next=selected.nextTurn;
    if(state==='running'&&next&&(next.kind==='user'||(next.kind==='runtime'&&next.runtime==='running'))){
      state='unknown';record=next;
    }
    const identity=`${selected.currentEpoch}:${turnKey}:${record.id}:${state}`;
    const wall=options.wallNow(),offset=wall-now,bridge=researchBridges.get(key);
    const reliable=Number.isFinite(offset)&&(bridge?.epoch!==selected.currentEpoch||
      (bridge.reliable&&Math.abs(offset-bridge.offset)<=1000));
    researchBridges.set(key,{epoch:selected.currentEpoch,offset:bridge?.epoch===selected.currentEpoch?bridge.offset:offset,reliable});
    const boundaryMs=previous?.identity===identity?previous.boundaryMs:
      Math.max(0,Math.floor(now-Math.max(0,options.wallNow()-record.atMs)));
    executionCache.set(key,{identity,boundaryMs,trustedAt:now});
    return {state,identity,boundaryMs,
      researchReliable:reliable&&snapshot.historyComplete&&record.kind==='runtime'&&snapshot.health==='ready'&&!snapshot.partialLine&&
        Number.isSafeInteger(record.atMs)&&record.atMs>=0&&record.atMs<=options.wallNow(),
      ...(outcome===undefined?{}:{outcome})};
  },takeover,openHistory,openNativeSource,openNativeTurn,inspect(key,turnKey,query){
    const selected=select(key,turnKey,query);if(!selected)return null;
     return {revision:selected.snapshot.revision,userFingerprint:selected.userFingerprint,contentFingerprint:selected.contentFingerprint,
       currentActionId:[...selected.actions.keys()].at(-1)??null,
      finalAvailable:selected.finalAvailable,
      ready:selected.records.some(record=>(!!record.text||(record.imageCount??0)>0)&&(record.kind==='user'||
        (query.goalSummary!==null&&record.kind!=='runtime')))};
  },read(key,turnKey,query){
    const selected=select(key,turnKey,query);if(!selected)return null;
    const {snapshot,currentEpoch,floor,records,actions,finalAvailable}=selected;
    try{
      const researchHash=createPrefixFingerprint();for(const record of selected.current)researchHash.add(record);
      const input=assembleContext(records,{summary:query.goalSummary,
        imageContextPending:snapshot.imageContextPending===true,
        summaryThroughSequence:Math.min(query.summaryThroughSequence??0,snapshot.revision),
        sequence:snapshot.revision,activeSeconds:query.activeSeconds,activeTimeKnown:false,
        historyComplete:snapshot.historyComplete&&floor>=0,nowMs:options.wallNow(),previousEstimate:query.previousEstimate,
        runtime:query.runtime,currentTurnId:selected.currentTurnId});
      return {epoch:currentEpoch,revision:snapshot.revision,userFingerprint:selected.userFingerprint,input,researchFingerprint:researchHash.finish(),
         currentActionId:[...actions.keys()].at(-1)??null,contentFingerprint:selected.contentFingerprint,
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
    changed:owner.changed,setActive:owner.setActive,tick:owner.tick,snapshot:owner.snapshot,openHistory,openNativeSource,openNativeTurn,
    turnKey(key:string):string|null {return bindings.get(key)?.turnKey??null;},
    stop(key:string):void {
      const binding=bindings.get(key);if(!binding)return;
      executionCache.delete(key);researchBridges.delete(key);
      owner.remove(key);invalidateScopes(key);owner.attach(key,binding.hostId,binding.turnKey);owner.setActive(key,false);
      binding.epoch=allocate();binding.sourceEpoch=0;
    },
    remove(key:string):void {owner.remove(key);bindings.delete(key);invalidateScopes(key);measurementEpochs.delete(key);executionCache.delete(key);researchBridges.delete(key);},
    prune(retain:(key:string)=>boolean):void {
      for(const key of bindings.keys())if(!retain(key)){owner.remove(key);bindings.delete(key);invalidateScopes(key);measurementEpochs.delete(key);executionCache.delete(key);researchBridges.delete(key);}
    },
    measurementEpoch,
    async close():Promise<void>{bindings.clear();scopesByKey.clear();measurementEpochs.clear();executionCache.clear();researchBridges.clear();await owner.close();}
  };
}
