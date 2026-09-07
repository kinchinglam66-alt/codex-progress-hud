import type {ObserverObservation} from '../estimation/observer-scheduler.js';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdir,open,type FileHandle} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Local research metadata only. Bounded asynchronous I/O never gates model work.
 * Missing terminal summary means an unclean recording shutdown, not completion. */
export function createPilotJournal(directory:string){
  const session=randomUUID(),salt=randomUUID();
  let file:FileHandle|undefined,tail=Promise.resolve(),closing:Promise<void>|undefined;
  let written=0,dropped=0,failed=false,pending=0,bytes=0;
  const pendingRequests=new Set<number>();
  const status=()=>({written,dropped,failed});
  async function handle(){
    if(!file){await mkdir(directory,{recursive:true});file=await open(resolve(directory,`pilot-${session}.jsonl`),'wx',0o600);}
    return file;
  }
  return {
    record(value:ObserverObservation):void {
      if(closing || failed || pending>=128){dropped++;return;}
      // Explicit field projection prevents accidental future context/identity logging.
      const row={schemaVersion:1,session,recordedAt:Date.now(),kind:value.kind,at:value.at,
        key:createHmac('sha256',salt).update(value.key).digest('hex'),generation:value.generation,
        activeSeconds:value.activeSeconds,activeTimeKnown:value.activeTimeKnown,runtime:value.runtime,version:value.version,
        requestId:value.requestId,requestedAt:value.requestedAt,observedActiveSeconds:value.observedActiveSeconds,
        accepted:value.accepted,status:value.status,relation:value.relation,
        timings:value.timings?{preparationMs:value.timings.preparationMs,providerMs:value.timings.providerMs,
          settlementMs:value.timings.settlementMs,deliveryMs:value.timings.deliveryMs,totalMs:value.timings.totalMs}:undefined,
        estimate:value.estimate?{remainingSeconds:value.estimate.remainingSeconds,errorPercent:value.estimate.errorPercent}:value.estimate,
        usage:value.usage?{kind:value.usage.kind,inputTokens:value.usage.inputTokens,outputTokens:value.usage.outputTokens,cachedInputTokens:value.usage.cachedInputTokens}:value.usage};
      const line=JSON.stringify(row)+'\n',size=Buffer.byteLength(line);
      if(size>8192 || bytes+size>10*1024*1024){dropped++;return;}
      if(value.requestId!==undefined){
        if(value.kind==='request')pendingRequests.add(value.requestId);
        if(value.kind==='result')pendingRequests.delete(value.requestId);
      }
      bytes+=size;pending++;
      tail=tail.then(async()=>{
        if(failed){dropped++;return;}
        try{await (await handle()).writeFile(line);written++;}catch{failed=true;dropped++;}
      }).finally(()=>{pending--;});
    },
    status,
    close():Promise<void>{
      if(closing)return closing;
      closing=tail.then(async()=>{
        if(!file)return;
        try{await file.writeFile(JSON.stringify({schemaVersion:1,session,kind:'journal_summary',...status(),pendingRequests:pendingRequests.size})+'\n');await file.sync();}
        catch{failed=true;}finally{await file.close().catch(()=>{failed=true;});}
      });
      return closing;
    },
  };
}
