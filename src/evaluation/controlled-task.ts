import { performance } from "node:perf_hooks";
import type { ControlledCallResult } from "./controlled-call.js";
import type { CallKind } from "./controlled-output.js";
interface Validation {passed:boolean;cases:number;passedCases:number;error:string|null}
interface Options {
  key:string;prompt:string;sampleMs:readonly number[];
  emit(row:Record<string,unknown>):Promise<void>;
  call(kind:CallKind,input:string|{activeSeconds:number;progress:null;toolCount:number;validationFailures:number}):Promise<ControlledCallResult>;
  validate(sql:string):Promise<Validation>;
  onUnsafe?:()=>void;
}
/** A real workload with at most one repair and asynchronous, nonqueued samples.
 * End time is independent validation completion, never estimator completion.
 * A caller error propagates after outstanding sampling work is joined.
 */
export async function runControlledTask(options:Options) {
  const {key,prompt,sampleMs,emit,call,validate}=options;
  if(!/^sample_[a-z0-9_]{1,64}$/.test(key) || prompt.length>8192 ||
    sampleMs.length>3 || sampleMs.some((x,i)=>!Number.isFinite(x)||x<0||(i>0&&x<=sampleMs[i-1]!)))throw Error("INVALID_CONTROLLED_TASK");
  let done=false,busy=false,validationFailures=0,toolCount=0,fatal:unknown;
  const jobs:Promise<void>[]=[],timers:ReturnType<typeof setTimeout>[]=[];
  const sampled=new Set<number>();
  await emit({type:"start",key});
  const start=performance.now(),elapsed=()=> (performance.now()-start)/1000;
  const sample=(plannedMs:number)=>{
    const job=(async()=>{
      if(done)return;
      sampled.add(plannedMs);
      if(busy){await emit({type:"sample_skipped",key,plannedMs,atSeconds:elapsed(),reason:"busy"});return;}
      busy=true;
      try {
        const metrics={activeSeconds:elapsed(),progress:null,toolCount,validationFailures};
        const result=await call("estimator",metrics);
        const deliveredSeconds=elapsed(),late=done;
        await emit({type:"prediction",key,plannedMs,metrics,deliveredSeconds,late,result});
      }finally{busy=false;}
    })().catch(error=>{fatal=error;options.onUnsafe?.();});
    jobs.push(job);
  };
  let outcome:"verified"|"failed"|"interrupted"="failed",endSeconds:number|null=null;
  try {
    for(const ms of sampleMs)timers.push(setTimeout(()=>sample(ms),ms));
    let input=prompt;
    for(let attempt=0;attempt<2;attempt++) {
      if(fatal)throw fatal;
      const result=await call("workload",input);toolCount++;
      let validation:Validation|null=null;
      if(result.status==="answered" && result.answer && "sql" in result.answer)validation=await validate(result.answer.sql);
      const atSeconds=elapsed();
      if(validation?.passed){outcome="verified";done=true;endSeconds=atSeconds;}
      else if(result.usage===null || result.status==="process_error" || result.status==="not_admitted"){
        outcome="interrupted";done=true;endSeconds=atSeconds;
      }else validationFailures++;
      await emit({type:"workload",key,attempt,atSeconds,result,validation});
      if(done)break;
      // Only bounded fixture answer and validation counters are repair context.
      input=JSON.stringify({specification:prompt,previousSql:result.answer && "sql" in result.answer?result.answer.sql:null,
        feedback:validation??{error:"invalid_answer"}});
    }
  }catch(error){fatal=error;outcome="interrupted";options.onUnsafe?.();}
  finally {
    endSeconds??=elapsed();done=true;
    for(const timer of timers)clearTimeout(timer);
    try{
      await emit({type:"end",key,atSeconds:endSeconds,outcome,validationFailures});
      for(const plannedMs of sampleMs)if(!sampled.has(plannedMs))await emit({type:"sample_skipped",key,plannedMs,atSeconds:endSeconds,reason:"task_ended"});
    }
    catch(error){fatal=error;options.onUnsafe?.();}
    await Promise.all(jobs);
  }
  if(fatal)throw fatal;
  return {key,outcome,endSeconds};
}
