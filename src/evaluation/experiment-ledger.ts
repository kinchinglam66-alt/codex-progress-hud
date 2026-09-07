import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const count=z.number().int().min(0).max(1_000_000_000);
const configSchema=z.object({
  budgetTokens:z.number().int().min(1).max(1_000_000),
  reservationTokens:z.number().int().min(1).max(1_000_000),
  maxStarts:z.number().int().min(1).max(1000),
  protocolHash:z.string().regex(/^[a-f0-9]{64}$/)
}).strict().refine(x=>x.reservationTokens<=x.budgetTokens);
const usageSchema=z.object({inputTokens:count,outputTokens:count,cachedInputTokens:count.nullable()})
  .strict().refine(x=>x.cachedInputTokens===null || x.cachedInputTokens<=x.inputTokens);
const rowSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("reserve"),id:count,task:z.string().regex(/^sample_[a-z0-9_]{1,64}$/),
    lane:z.enum(["workload","estimator"])}).strict(),
  z.object({type:z.literal("settle"),id:count,usage:usageSchema.nullable()}).strict(),
  z.object({type:z.literal("charge_unknown"),id:count,assumedTokens:count}).strict(),
  z.object({type:z.literal("budget_amendment"),budgetTokens:z.literal(1500000),authorization:z.literal("user_20260906_1500000")}).strict(),
  z.object({type:z.literal("reservation_amendment"),reservationTokens:z.literal(16000)}).strict()
]);
type Row=z.infer<typeof rowSchema>;
type Usage=z.infer<typeof usageSchema>;

/** Offline experiment owner. One journal covers workloads, estimator calls and
 * retries. Unknown usage or reservation overruns stop new dispatch, not evidence
 * collection. Reservations are conservative headroom, not provider enforcement.
 */
export async function openExperimentLedger(directory:string,input:z.infer<typeof configSchema>) {
  const config=configSchema.parse(input),lockPath=join(directory,"experiment.lock");
  const lock=await open(lockPath,"wx",0o600);
  let journal:FileHandle|undefined,bytes=0,starts=0,knownTokens=0,unknown=0,assumedTokens=0,overrun=false;
  let closed=false,poisoned=false,queue:Promise<unknown>=Promise.resolve(),closing:Promise<void>|undefined;
  const pending=new Set<number>(), recovered=new Set<number>();
  const unresolved=new Set<number>();
  let budgetTokens=config.budgetTokens;
  let reservationTokens=config.reservationTokens;
  const exposures=new Map<number,number>();
  const allowed=()=>!unresolved.size && !overrun && pending.size<2 &&
    starts<config.maxStarts && knownTokens+assumedTokens+[...pending].reduce((sum,id)=>sum+exposures.get(id)!,0)+reservationTokens<=budgetTokens;
  function validate(row:Row) {
    if(row.type==="budget_amendment") {if(row.budgetTokens<=budgetTokens||pending.size)throw Error("INVALID_BUDGET_AMENDMENT");return;}
    if(row.type==="reservation_amendment"){if(pending.size||row.reservationTokens>=reservationTokens)throw Error("INVALID_RESERVATION_AMENDMENT");return;}
    if(row.type==="reserve") {
      if(row.id!==starts+1 || !allowed())throw Error("INVALID_EXPERIMENT_RESERVATION");
    } else if(row.type==="charge_unknown"){
      if(!unresolved.has(row.id)||row.assumedTokens!==exposures.get(row.id))throw Error("INVALID_UNKNOWN_CHARGE");
    }else if(!pending.has(row.id))throw Error("INVALID_EXPERIMENT_SETTLEMENT");
  }
  function apply(row:Row) {
    if(row.type==="budget_amendment"){budgetTokens=row.budgetTokens;return;}
    if(row.type==="reservation_amendment"){reservationTokens=row.reservationTokens;return;}
    if(row.type==="reserve") {starts++;pending.add(row.id);exposures.set(row.id,reservationTokens);}
    else if(row.type==="charge_unknown") {unresolved.delete(row.id);assumedTokens+=row.assumedTokens;}
    else {
      pending.delete(row.id);recovered.delete(row.id);
      if(row.usage===null){unknown++;unresolved.add(row.id);}
      else {
        const actual=row.usage.inputTokens+row.usage.outputTokens;
        knownTokens+=actual;overrun ||= actual>exposures.get(row.id)!;
      }
    }
  }
  try {
    journal=await open(join(directory,"experiment.jsonl"),"a+",0o600);
    bytes=(await journal.stat()).size;
    if(bytes>1_048_576)throw Error();
    const header=JSON.stringify({version:1,config});
    if(bytes===0) {await journal.writeFile(header+"\n");await journal.sync();bytes=Buffer.byteLength(header)+1;}
    else {
      const text=await journal.readFile("utf8");if(!text.endsWith("\n"))throw Error();
      const lines=text.trimEnd().split("\n");
      if(lines.shift()!==header)throw Error();
      for(const line of lines){const row=rowSchema.parse(JSON.parse(line));validate(row);apply(row);}
      for(const id of pending)recovered.add(id);
    }
  } catch {
    await journal?.close();await lock.close();
    // Preserve lock on uncertain/corrupt state; never silently start a fresh budget.
    throw Error("EXPERIMENT_JOURNAL_UNAVAILABLE");
  }
  const file=journal;
  function serial<T>(operation:()=>Promise<T>):Promise<T> {
    const result=queue.then(operation);queue=result.catch(()=>undefined);return result;
  }
  async function append(row:Row) {
    validate(row);
    const line=JSON.stringify(row)+"\n",size=Buffer.byteLength(line);
    if(bytes+size>1_048_576){poisoned=true;throw Error("EXPERIMENT_JOURNAL_FULL");}
    try{await file.writeFile(line);await file.sync();}
    catch{poisoned=true;throw Error("EXPERIMENT_PERSIST_FAILED");}
    bytes+=size;apply(row);
  }
  return {
    reserve(task:string,lane:"workload"|"estimator"):Promise<number|null> {
      // Validate before enqueue; id is assigned by the serial owner.
      rowSchema.parse({type:"reserve",id:1,task,lane});
      return serial(async()=>{
        if(closed || poisoned || recovered.size || !allowed())return null;
        const id=starts+1;await append({type:"reserve",id,task,lane});return id;
      });
    },
    settle(id:number,usage:Usage|null):Promise<void> {
      if(closed || poisoned)return Promise.reject(Error("EXPERIMENT_CLOSED"));
      const row=rowSchema.parse({type:"settle",id,usage});
      return serial(async()=>{if(poisoned)throw Error("EXPERIMENT_CLOSED");await append(row);});
    },
    chargeUnknownReservation(id:number):Promise<void> {
      if(closed||poisoned)return Promise.reject(Error("EXPERIMENT_CLOSED"));
      const row=rowSchema.parse({type:"charge_unknown",id,assumedTokens:exposures.get(id)});
      return serial(async()=>{if(poisoned)throw Error("EXPERIMENT_CLOSED");await append(row);});
    },
    amendBudget(value:1500000,authorization:"user_20260906_1500000"):Promise<void>{
      if(closed||poisoned)return Promise.reject(Error("EXPERIMENT_CLOSED"));
      const row=rowSchema.parse({type:"budget_amendment",budgetTokens:value,authorization});
      return serial(async()=>{if(poisoned)throw Error("EXPERIMENT_CLOSED");await append(row);});
    },
    amendReservation(value:16000):Promise<void>{
      if(closed||poisoned)return Promise.reject(Error("EXPERIMENT_CLOSED"));
      const row=rowSchema.parse({type:"reservation_amendment",reservationTokens:value});
      return serial(async()=>{if(poisoned)throw Error("EXPERIMENT_CLOSED");await append(row);});
    },
    snapshot(){return {budgetTokens,reservationTokens,starts,knownTokens,pending:pending.size,unknown,unreconciledUnknown:unresolved.size,assumedTokens,overrun};},
    close():Promise<void> {
      if(closing)return closing;
      closed=true;
      closing=queue.then(async()=>{await file.close();await lock.close();if(!poisoned)await unlink(lockPath);});
      return closing;
    }
  };
}
