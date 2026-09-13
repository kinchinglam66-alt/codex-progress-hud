import type {ConversationRecord,ReadBatch} from './conversation-record.js';
import type {HistorySnapshot} from './history-snapshot.js';
import {createHash} from 'node:crypto';

interface Source {
  read(id:string,signal:AbortSignal):Promise<ReadBatch>;
  snapshot?(id:string,signal:AbortSignal):Promise<HistorySnapshot>;
  remove(id:string):void;close():Promise<void>;
}
export interface ContextSnapshot {
  /** Source-owned instruction identity, independent of the bounded text projection. */
  instructionFingerprint:string;
  imageContextPending?:boolean;
  lastSuccessfulReadAt?:number;
  records:ConversationRecord[];revision:number;sourceEpoch:number;
  health:'loading'|'ready'|'error';historyComplete:boolean;partialLine:boolean;
  reason:string|null;projectionOnly:true;
}
interface Entry extends ContextSnapshot {
  hostId:string;turnKey:string;due:number;active:boolean;failures:number;
  bytes:number;historyTrimmed:boolean;flight?:AbortController;operation?:Promise<void>;
  goalRetentionFailed?:boolean;historyFlights:Set<AbortController>;
  instructionDigests:Map<string,string>;
}

const EMPTY_INSTRUCTIONS=createHash('sha256').update('hud-instructions-v1').digest('hex');
const hashInstruction=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

const PROJECTION_TEXT_BYTES=16*1024;
function productionRecordBytes(record:ConversationRecord):number {
  // Research-only attribution must not evict estimator context sooner.
  const {sourceTurnId:_research,...production}=record;
  return Buffer.byteLength(JSON.stringify(production));
}
function boundProjectionText(text:string):string {
  if(Buffer.byteLength(text)<=PROJECTION_TEXT_BYTES)return text;
  return Buffer.from(text).subarray(0,PROJECTION_TEXT_BYTES).toString('utf8');
}
function projectRecord(record:ConversationRecord):{record:ConversationRecord;trimmed:boolean} {
  let trimmed=false;const projected={...record};
  if(projected.contentParts?.some(part=>part.type!=='text')){
    projected.imageCount=projected.contentParts.filter(part=>part.type!=='text').length;
    projected.imageFingerprint=hashInstruction(projected.contentParts);
    delete projected.contentParts;
  }
  if(projected.text!==undefined){const text=boundProjectionText(projected.text);if(text!==projected.text){projected.text=text;trimmed=true;}}
  if(projected.output!==undefined){const output=boundProjectionText(projected.output);if(output!==projected.output){projected.output=output;projected.outputComplete=false;trimmed=true;}}
  return {record:projected,trimmed};
}
function historyBindingError():Error&{code:string} {
  const error=new Error('source history binding changed') as Error&{code:string};error.code='SOURCE_HISTORY_BINDING_CHANGED';return error;
}

/** Owns source reads only. No inference, authorization or model quota mutations. */
export function createContextOwner(options:{source:Source;now:()=>number;onChange?:(key:string)=>void;turnKeyFor?:(hostId:string,turnId:string)=>string}) {
  const entries=new Map<string,Entry>();let closed=false,inFlight=0,totalBytes=0;
  const operations=new Set<Promise<void>>();
  let closing:Promise<void>|undefined;
  const clock=()=>{const n=options.now();if(!Number.isFinite(n)||n<0)throw Error('INVALID_SOURCE_CLOCK');return n;};
  const notify=(key:string)=>{try{options.onChange?.(key);}catch{/* display callback owns no source */}};
  const remove=(key:string)=>{
    const e=entries.get(key);if(!e)return;
    e.flight?.abort();for(const flight of e.historyFlights)flight.abort();e.historyFlights.clear();
    entries.delete(key);totalBytes-=e.bytes;options.source.remove(e.hostId);
  };
  const snapshot=(key:string):ContextSnapshot|null=>{
    const e=entries.get(key);if(!e)return null;
    return {records:e.records.map(r=>({...r})),revision:e.revision,sourceEpoch:e.sourceEpoch,instructionFingerprint:e.instructionFingerprint,
      imageContextPending:e.imageContextPending===true,
      ...(e.lastSuccessfulReadAt===undefined?{}:{lastSuccessfulReadAt:e.lastSuccessfulReadAt}),
      health:e.health,historyComplete:e.historyComplete,partialLine:e.partialLine,reason:e.reason,projectionOnly:true};
  };
  const start=(key:string,e:Entry)=>{
    const controller=new AbortController();e.flight=controller;inFlight++;
    entries.delete(key);entries.set(key,e);
    const current=()=>!closed&&entries.get(key)===e&&!controller.signal.aborted;
    let released=false,deadline:ReturnType<typeof setTimeout>|undefined;
    const releaseFlight=()=>{
      if(released)return;released=true;inFlight--;
      if(deadline!==undefined)clearTimeout(deadline);
      if(e.flight===controller)delete e.flight;
    };
    controller.signal.addEventListener('abort',releaseFlight,{once:true});
    deadline=setTimeout(()=>{
      if(!current())return;
      e.health='error';e.reason='source_read_timeout';e.failures++;
      e.due=clock()+([1000,2000,5000][Math.min(2,e.failures-1)]??5000);
      controller.abort();notify(key);
    },15000);
    deadline.unref?.();
    let read:Promise<ReadBatch>;
    try{read=options.source.read(e.hostId,controller.signal);}catch(error){read=Promise.reject(error);}
    const operation=read.then(batch=>{
      if(!current())return;
      if(batch.reset)e.goalRetentionFailed=false;
      if(e.goalRetentionFailed)throw Error('SOURCE_GOAL_LIMIT');
      const previousHealth=e.health;
      const previousPartial=e.partialLine,previousComplete=e.historyComplete;
      let records=batch.reset?[]:[...e.records];
      const known=new Set(records.map(r=>r.id));
      let changed=batch.reset;
      const imageContextPending=(!batch.reset&&e.imageContextPending===true)||batch.records.some(record=>
        record.imageContextPending===true||(record.imageCount??0)>0||record.contentParts?.some(part=>part.type!=='text'));
      const instructionDigests=batch.reset?new Map<string,string>():new Map(e.instructionDigests);
      let instructionFingerprint=batch.reset?EMPTY_INSTRUCTIONS:e.instructionFingerprint;
      for(const record of batch.records){
        let revisedUser=false;
        if(record.kind==='user'){
          const id=hashInstruction(record.id),digest=hashInstruction([record.id,record.turnId,record.text??'',record.imageFingerprint??(record.contentParts?hashInstruction(record.contentParts):null)]);
          revisedUser=instructionDigests.get(id)!==digest;
          if(revisedUser){instructionFingerprint=hashInstruction([instructionFingerprint,digest]);changed=true;}
          instructionDigests.delete(id);instructionDigests.set(id,digest);
          // Match the source reader's bounded dedupe window. A replay beyond it
          // conservatively invalidates an estimate; it never reuses stale identity.
          if(instructionDigests.size>4096)instructionDigests.delete(instructionDigests.keys().next().value!);
          if(!revisedUser&&!known.has(record.id))continue;
        }
        if(!known.has(record.id)){known.add(record.id);records.push({...record});changed=true;}
        else if(revisedUser){records[records.findIndex(r=>r.id===record.id)]={...record};}
      }
      let trimmed=false;
      records=records.map(record=>{const projected=projectRecord(record);trimmed ||= projected.trimmed;return projected.record;});
      // Exact production JSON array size, without repeatedly serializing the entire
      // history for every discarded record during catch-up.
      const sizes=records.map(productionRecordBytes);
      let bytes=2+sizes.reduce((sum,size)=>sum+size,0)+Math.max(0,records.length-1);
      const firstUser=records.find(r=>r.kind==='user');
      let latestUser:ConversationRecord|undefined,currentUser:ConversationRecord|undefined;
      for(const record of records){
        if(record.kind!=='user')continue;
        latestUser=record;
        if(record.turnId!==null&&(options.turnKeyFor?options.turnKeyFor(e.hostId,record.turnId):record.turnId)===e.turnKey)currentUser=record;
      }
      const protectedUsers=new Set([firstUser,latestUser,currentUser]);
      const protectedRecords=new Set(protectedUsers);
      // Lifecycle evidence must survive body eviction. Otherwise a retained
      // prompt becomes the last evidence and resurrects an already ended turn.
      const matches=(record:ConversationRecord)=>record.turnId!==null&&
        (options.turnKeyFor?options.turnKeyFor(e.hostId,record.turnId):record.turnId)===e.turnKey;
      const start=records.findIndex(matches);
      if(start>=0){
        let lastExecution:ConversationRecord|undefined;
        for(let index=start;index<records.length;index++){
          const record=records[index]!;
          if(record.turnId===null)continue;
          if(!matches(record)){protectedRecords.add(record);break;}
          if(record.kind==='runtime'||record.kind==='user'||record.kind==='tool_start'||
            (record.kind==='assistant'&&record.assistantPhase==='final'))lastExecution=record;
        }
        protectedRecords.add(lastExecution);
      }
      // Keep identity/state, not a potentially 64 KiB final/tool body, when
      // lifecycle protection would compete with the protected user instructions.
      if(bytes>256*1024)records=records.map((record,index)=>{
        if(!protectedRecords.has(record)||protectedUsers.has(record))return record;
        const compact:ConversationRecord={id:record.id,turnId:record.turnId,atMs:record.atMs,kind:record.kind,
          ...(record.sourceTurnId===undefined?{}:{sourceTurnId:record.sourceTurnId}),
          ...(record.runtime===undefined?{}:{runtime:record.runtime}),
          ...(record.outcome===undefined?{}:{outcome:record.outcome}),
          ...(record.assistantPhase===undefined?{}:{assistantPhase:record.assistantPhase}),
          ...(record.actionId===undefined?{}:{actionId:record.actionId})};
        const size=productionRecordBytes(compact);
        if(size>=sizes[index]!)return record;
        bytes-=sizes[index]!-size;sizes[index]=size;trimmed=true;
        protectedRecords.delete(record);protectedRecords.add(compact);return compact;
      });
      let retainedCount=records.length;
      records=records.filter((record,index)=>{
        if(bytes<=256*1024||protectedRecords.has(record))return true;
        bytes-=sizes[index]!+(retainedCount>1?1:0);
        retainedCount--;trimmed=true;return false;
      });
      if(bytes>256*1024){e.goalRetentionFailed=true;throw Error('SOURCE_GOAL_LIMIT');}
      if(totalBytes-e.bytes+bytes>8*1024*1024)throw Error('SOURCE_LIMIT');
      totalBytes+=bytes-e.bytes;e.bytes=bytes;e.records=records;
      e.imageContextPending=imageContextPending;
      e.instructionFingerprint=instructionFingerprint;e.instructionDigests=instructionDigests;
      if(batch.reset)e.sourceEpoch++;
      if(changed)e.revision++;
      e.historyTrimmed=(batch.reset?false:e.historyTrimmed)||trimmed||
        ('historyTruncated' in batch && batch.historyTruncated===true);
      e.historyComplete=batch.caughtUp&&!e.historyTrimmed;
      e.partialLine=batch.partialLine;e.health=batch.caughtUp?'ready':'loading';e.reason=null;e.failures=0;
      const readAt=clock();
      if(batch.caughtUp&&!batch.partialLine)e.lastSuccessfulReadAt=readAt;
      e.due=readAt+(batch.caughtUp?5000:0);
      if(changed||previousHealth!==e.health||previousPartial!==e.partialLine||previousComplete!==e.historyComplete)notify(key);
    }).catch(()=>{
      if(!current())return;
      e.health='error';e.reason='source_unavailable';e.failures++;
      e.due=clock()+([1000,2000,5000][Math.min(2,e.failures-1)]??5000);notify(key);
    }).finally(()=>{
      releaseFlight();controller.signal.removeEventListener('abort',releaseFlight);
      operations.delete(operation);
    });
    e.operation=operation;operations.add(operation);
  };
  return {
    attach(key:string,hostId:string,turnKey:string):void {
      if(closed)return;
      const existing=entries.get(key);
      if(existing&&(existing.hostId!==hostId||existing.goalRetentionFailed)){remove(key);}
      else if(existing){existing.turnKey=turnKey;existing.active=true;existing.due=Math.min(existing.due,clock()+500);return;}
      if(entries.size>=32)throw Error('SOURCE_CAPACITY');
      entries.set(key,{hostId,turnKey,records:[],revision:0,sourceEpoch:0,health:'loading',
        instructionFingerprint:EMPTY_INSTRUCTIONS,instructionDigests:new Map(),
        historyComplete:true,partialLine:false,reason:null,projectionOnly:true,due:clock()+500,active:true,failures:0,bytes:0,
        historyTrimmed:false,historyFlights:new Set()});
    },
    changed(key:string):void {const e=entries.get(key);if(e&&!closed)e.due=Math.min(e.due,clock()+500);},
    setActive(key:string,active:boolean):void {const e=entries.get(key);if(!e||closed)return;e.active=active;if(active)e.due=clock()+500;},
    snapshot,remove,
    async openHistory(key:string,turnKey:string,signal:AbortSignal):Promise<{snapshot:HistorySnapshot;currentTurnId:string}|null> {
      const e=entries.get(key),snapshotReader=options.source.snapshot;
      if(!e||e.turnKey!==turnKey||snapshotReader===undefined)return null;
      const currentRecord=[...e.records].reverse().find(record=>record.turnId!==null&&
        (options.turnKeyFor?options.turnKeyFor(e.hostId,record.turnId):record.turnId)===turnKey);
      if(!currentRecord?.turnId)return null;
      const boundHostId=e.hostId,boundSourceEpoch=e.sourceEpoch,boundCurrentTurnId=currentRecord.turnId;
      const controller=new AbortController();
      const relay=()=>controller.abort();
      signal.addEventListener('abort',relay,{once:true});e.historyFlights.add(controller);
      let history:HistorySnapshot|undefined;
      try{
        history=await snapshotReader(boundHostId,controller.signal);
        const current=entries.get(key),stillCurrent=current?.records.some(record=>record.turnId===boundCurrentTurnId&&
          (options.turnKeyFor?options.turnKeyFor(boundHostId,record.turnId):record.turnId)===turnKey);
        if(closed||controller.signal.aborted||current!==e||current.hostId!==boundHostId||current.turnKey!==turnKey||
          current.sourceEpoch!==boundSourceEpoch||!stillCurrent)throw historyBindingError();
        return {snapshot:history,currentTurnId:boundCurrentTurnId};
      }catch(error){
        if(history!==undefined){try{await history.close();}catch{/* stale history must not leak */}}
        throw error;
      }finally{
        signal.removeEventListener('abort',relay);e.historyFlights.delete(controller);
      }
    },
    health(key:string):ContextSnapshot['health']|'missing' {return entries.get(key)?.health??'missing';},
    sourceEpoch(key:string):number|null {return entries.get(key)?.sourceEpoch??null;},
    tick():void {
      if(closed)return;const now=clock();
      for(const [key,e] of [...entries]){
        if(inFlight>=2)break;
        if(e.active&&!e.flight&&now>=e.due){
          // Logical timeout cannot guarantee that an OS read stopped. Bound
          // all unresolved reads, including timed-out ones, to four globally.
          if(operations.size>=4){
            if(e.health!=='error'||e.reason!=='source_read_capacity'){
              e.health='error';e.reason='source_read_capacity';notify(key);
            }
            continue;
          }
          start(key,e);
        }
      }
    },
    close():Promise<void> {
      if(closing)return closing;
      closed=true;for(const e of entries.values()){
        e.flight?.abort();for(const flight of e.historyFlights)flight.abort();e.historyFlights.clear();
      }
      const drain=(async()=>{
        await options.source.close();await Promise.allSettled([...operations]);
        entries.clear();totalBytes=0;
      })();
      let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<never>((_resolve,reject)=>{
        timer=setTimeout(()=>reject(Error('SOURCE_CLOSE_UNCONFIRMED')),6000);
      });
      closing=Promise.race([drain,deadline]).finally(()=>clearTimeout(timer));
      return closing;
    },
  };
}
