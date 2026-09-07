import type {ConversationRecord,ReadBatch} from './conversation-record.js';

interface Source {
  read(id:string,signal:AbortSignal):Promise<ReadBatch>;
  remove(id:string):void;close():Promise<void>;
}
export interface ContextSnapshot {
  records:ConversationRecord[];revision:number;sourceEpoch:number;
  health:'loading'|'ready'|'error';historyComplete:boolean;partialLine:boolean;
  reason:string|null;
}
interface Entry extends ContextSnapshot {
  hostId:string;turnKey:string;due:number;active:boolean;failures:number;
  bytes:number;historyTrimmed:boolean;flight?:AbortController;operation?:Promise<void>;
  goalRetentionFailed?:boolean;
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
    e.flight?.abort();entries.delete(key);totalBytes-=e.bytes;options.source.remove(e.hostId);
  };
  const snapshot=(key:string):ContextSnapshot|null=>{
    const e=entries.get(key);if(!e)return null;
    return {records:e.records.map(r=>({...r})),revision:e.revision,sourceEpoch:e.sourceEpoch,
      health:e.health,historyComplete:e.historyComplete,partialLine:e.partialLine,reason:e.reason};
  };
  const start=(key:string,e:Entry)=>{
    const controller=new AbortController();e.flight=controller;inFlight++;
    entries.delete(key);entries.set(key,e);
    const current=()=>!closed&&entries.get(key)===e&&!controller.signal.aborted;
    let read:Promise<ReadBatch>;
    try{read=options.source.read(e.hostId,controller.signal);}catch(error){read=Promise.reject(error);}
    const operation=read.then(batch=>{
      if(!current())return;
      if(batch.reset)e.goalRetentionFailed=false;
      if(e.goalRetentionFailed)throw Error('SOURCE_GOAL_LIMIT');
      const previousHealth=e.health;
      const records=batch.reset?[]:[...e.records];
      const known=new Set(records.map(r=>r.id));
      let changed=batch.reset;
      for(const record of batch.records){if(!known.has(record.id)){known.add(record.id);records.push({...record});changed=true;}}
      let bytes=Buffer.byteLength(JSON.stringify(records));let trimmed=false;
      const firstUser=records.find(r=>r.kind==='user');
      let latestUser:ConversationRecord|undefined,currentUser:ConversationRecord|undefined;
      for(const record of records){
        if(record.kind!=='user')continue;
        latestUser=record;
        if(record.turnId!==null&&(options.turnKeyFor?options.turnKeyFor(e.hostId,record.turnId):record.turnId)===e.turnKey)currentUser=record;
      }
      const protectedUsers=new Set([firstUser,latestUser,currentUser]);
      while(bytes>256*1024&&records.length){
        const index=records.findIndex(r=>!protectedUsers.has(r));
        if(index<0){e.goalRetentionFailed=true;throw Error('SOURCE_GOAL_LIMIT');}
        records.splice(index,1);trimmed=true;bytes=Buffer.byteLength(JSON.stringify(records));
      }
      if(totalBytes-e.bytes+bytes>8*1024*1024)throw Error('SOURCE_LIMIT');
      totalBytes+=bytes-e.bytes;e.bytes=bytes;e.records=records;
      if(batch.reset)e.sourceEpoch++;
      if(changed)e.revision++;
      e.historyTrimmed=(batch.reset?false:e.historyTrimmed)||trimmed||
        ('historyTruncated' in batch && batch.historyTruncated===true);
      e.historyComplete=batch.caughtUp&&!e.historyTrimmed;
      e.partialLine=batch.partialLine;e.health=batch.caughtUp?'ready':'loading';e.reason=null;e.failures=0;
      e.due=clock()+(batch.caughtUp?5000:0);
      if(changed||previousHealth!==e.health)notify(key);
    }).catch(()=>{
      if(!current())return;
      e.health='error';e.reason='source_unavailable';e.failures++;
      e.due=clock()+([1000,2000,5000][Math.min(2,e.failures-1)]??5000);notify(key);
    }).finally(()=>{
      if(e.flight===controller)delete e.flight;
      inFlight--;operations.delete(operation);
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
        historyComplete:true,partialLine:false,reason:null,due:clock()+500,active:true,failures:0,bytes:0,historyTrimmed:false});
    },
    changed(key:string):void {const e=entries.get(key);if(e&&!closed)e.due=Math.min(e.due,clock()+500);},
    setActive(key:string,active:boolean):void {const e=entries.get(key);if(!e||closed)return;e.active=active;if(active)e.due=clock()+500;},
    snapshot,remove,
    sourceEpoch(key:string):number|null {return entries.get(key)?.sourceEpoch??null;},
    tick():void {
      if(closed)return;const now=clock();
      for(const [key,e] of [...entries]){if(inFlight>=2)break;if(e.active&&!e.flight&&now>=e.due)start(key,e);}
    },
    close():Promise<void> {
      if(closing)return closing;
      closed=true;for(const e of entries.values())e.flight?.abort();
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
