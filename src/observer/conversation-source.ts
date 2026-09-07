import {createContextOwner} from './context-owner.js';
import {createHash} from 'node:crypto';
import {assembleContext} from './context-assembler.js';
import type {GoalContextSource,GoalContextQuery} from '../server/passive-goals.js';

type OwnerOptions=Parameters<typeof createContextOwner>[0];
interface Binding {hostId:string;turnKey:string;epoch:number;sourceEpoch:number}

/** One selected source per authenticated attachment. Raw identities stay local. */
export function createConversationSource(options:OwnerOptions & {
  wallNow:()=>number;turnKeyFor:(hostId:string,turnId:string)=>string;
}) {
  const owner=createContextOwner(options),bindings=new Map<string,Binding>();
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
    return {snapshot,currentEpoch,floor,records,current,actions,finalAvailable,userFingerprint};
  };
  const goals:GoalContextSource={epoch,inspect(key,turnKey,query){
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
        finalAvailable};
    }catch{return null;}
  }};
  return {
    goals,
    attach(key:string,hostId:string,turnKey:string):void {
      const existing=bindings.get(key);
      owner.attach(key,hostId,turnKey);
      if(!existing||existing.hostId!==hostId)bindings.set(key,{hostId,turnKey,epoch:allocate(),sourceEpoch:0});
      else existing.turnKey=turnKey;
    },
    changed:owner.changed,setActive:owner.setActive,tick:owner.tick,snapshot:owner.snapshot,
    stop(key:string):void {
      const binding=bindings.get(key);if(!binding)return;
      owner.remove(key);owner.attach(key,binding.hostId,binding.turnKey);owner.setActive(key,false);
      binding.epoch=allocate();binding.sourceEpoch=0;
    },
    remove(key:string):void {owner.remove(key);bindings.delete(key);},
    prune(retain:(key:string)=>boolean):void {
      for(const key of bindings.keys())if(!retain(key)){owner.remove(key);bindings.delete(key);}
    },
    async close():Promise<void>{bindings.clear();await owner.close();}
  };
}
