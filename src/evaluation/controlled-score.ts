import {fitLocalBaseline} from "./local-baseline.js";
import {baselinePredictor,type Trace,type Prediction} from "./replay.js";
import {z} from "zod";
const seconds=z.number().finite().nonnegative().max(31_536_000);
const endSchema=z.object({type:z.literal("end"),key:z.string(),outcome:z.enum(["verified","failed","interrupted"]),atSeconds:seconds});
const predictionSchema=z.object({type:z.literal("prediction"),key:z.string(),metrics:z.object({activeSeconds:seconds}),
  deliveredSeconds:seconds,late:z.boolean(),result:z.object({status:z.string(),answer:z.unknown(),durationMs:seconds.nullable()})});
const rangeSchema=z.object({lowSeconds:seconds,highSeconds:seconds}).refine(x=>x.highSeconds>=x.lowSeconds);
const mean=(xs:number[])=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
const quantile=(xs:number[],p:number)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)]!:null;
interface Row {key:string;observationIndex:number;split:string;source:string;actualSeconds:number;lowSeconds:number;highSeconds:number;deliveredSeconds:number}
function summarize(rows:Row[]) {
  const groups=new Map<string,Row[]>();
  for(const row of rows){const g=groups.get(row.key)??[];g.push(row);groups.set(row.key,g);}
  const tasks=[...groups.values()].map(group=>{
    const signed=group.map(x=>(x.lowSeconds+x.highSeconds)/2-x.actualSeconds);
    return {mae:mean(signed.map(Math.abs))!,bias:mean(signed)!,
      relative:mean(group.map((x,i)=>Math.abs(signed[i]!)/Math.max(5,x.actualSeconds)))!,
      coverage:mean(group.map(x=>Number(x.lowSeconds<=x.actualSeconds&&x.actualSeconds<=x.highSeconds)))!,
      width:mean(group.map(x=>x.highSeconds-x.lowSeconds))!};
  });
  let seed=20260905;const bootstrap:number[]=[];
  if(tasks.length>=2)for(let i=0;i<2000;i++){
    let sum=0;for(let j=0;j<tasks.length;j++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      sum+=tasks[Math.floor(seed/4294967296*tasks.length)]!.mae;
    }bootstrap.push(sum/tasks.length);
  }
  return {scoredTasks:tasks.length,scoredPredictions:rows.length,maeSeconds:mean(tasks.map(x=>x.mae)),
    signedBiasSeconds:mean(tasks.map(x=>x.bias)),medianTaskRelativeError:quantile(tasks.map(x=>x.relative),0.5),
    coverage:mean(tasks.map(x=>x.coverage)),meanWidthSeconds:mean(tasks.map(x=>x.width)),
    p90TaskMeanAbsoluteErrorSeconds:quantile(tasks.map(x=>x.mae),0.9),
    mae95TaskBootstrap:bootstrap.length?[quantile(bootstrap,0.025),quantile(bootstrap,0.975)]:null};
}
/** Offline only: no live calls, no holdout fitting, no missing-as-zero scores. */
export function scoreControlled(manifest:readonly {key:string;split:string}[],events:readonly unknown[]) {
  if(new Set(manifest.map(x=>x.key)).size!==manifest.length || manifest.some(x=>!["train","calibration","test"].includes(x.split)))throw Error("INVALID_SCORE_MANIFEST");
  const ends=new Map<string,z.infer<typeof endSchema>>(),predictions:z.infer<typeof predictionSchema>[]=[];
  for(const value of events){
    const type=(value as {type?:unknown})?.type;
    if(type==="end"){
      const end=endSchema.parse(value);if(ends.has(end.key))throw Error("DUPLICATE_TASK_END");ends.set(end.key,end);
    }else if(type==="prediction")predictions.push(predictionSchema.parse(value));
  }
  const split=new Map(manifest.map(x=>[x.key,x.split]));
  if([...ends.keys(),...predictions.map(x=>x.key)].some(key=>!split.has(key)))throw Error("UNKNOWN_SCORE_TASK");
  const validTimeline=(p:z.infer<typeof predictionSchema>)=>{
    const end=ends.get(p.key);
    return p.deliveredSeconds>=p.metrics.activeSeconds&&(!end||p.metrics.activeSeconds<end.atSeconds);
  };
  const lateDelivery=(p:z.infer<typeof predictionSchema>)=>{
    const end=ends.get(p.key);return p.late||(end!==undefined&&p.deliveredSeconds>=end.atSeconds);
  };
  const traces:Trace[]=manifest.flatMap(task=>{
    const end=ends.get(task.key);if(!end)return [];
    const times=[...new Set([0,...predictions.filter(p=>p.key===task.key&&validTimeline(p)).map(p=>p.metrics.activeSeconds)])].sort((a,b)=>a-b);
    return [{sampleKey:task.key,observations:times.map(atSeconds=>({atSeconds,state:"running" as const})),
      end:{atSeconds:end.atSeconds,outcome:end.outcome==="verified"?"succeeded_verified":end.outcome}}];
  });
  const local=fitLocalBaseline(traces.filter(x=>split.get(x.sampleKey)==="train"),traces.filter(x=>split.get(x.sampleKey)==="calibration"));
  const rows:Row[]=[],requestRows:Row[]=[];
  for(const [observationIndex,p] of predictions.entries()){
    const end=ends.get(p.key);if(!end||end.outcome!=="verified"||!validTimeline(p))continue;
    const parsed=rangeSchema.safeParse(p.result.answer);
    if(parsed.success&&p.result.status==="answered"&&p.metrics.activeSeconds<=end.atSeconds)requestRows.push({key:p.key,observationIndex,split:split.get(p.key)!,source:"model-request-retrospective",
      actualSeconds:end.atSeconds-p.metrics.activeSeconds,...parsed.data,deliveredSeconds:p.metrics.activeSeconds});
    if(lateDelivery(p))continue;
    const point={atSeconds:p.metrics.activeSeconds,activeSeconds:p.metrics.activeSeconds,state:"running" as const};
    const sources:Array<[string,Prediction|null]>=[
      ["model",p.result.status==="answered"&&parsed.success?parsed.data:null],
      ["existing-local",baselinePredictor()([point])],["historical",local.raw()([point])],["calibrated",local.calibrated()([point])]];
    const age=Math.max(0,p.deliveredSeconds-p.metrics.activeSeconds);
    for(const [source,range] of sources)if(range)rows.push({key:p.key,observationIndex,split:split.get(p.key)!,source,
      actualSeconds:end.atSeconds-p.deliveredSeconds,lowSeconds:Math.max(0,range.lowSeconds-age),
      highSeconds:Math.max(0,range.highSeconds-age),deliveredSeconds:p.deliveredSeconds});
  }
  const view=(source:string)=>Object.fromEntries(["train","calibration","test"].map(s=>[s,summarize(rows.filter(x=>x.source===source&&x.split===s))])) as Record<"train"|"calibration"|"test",ReturnType<typeof summarize>>;
  const pairedView=(source:string)=>Object.fromEntries(["train","calibration","test"].map(s=>{
    const modelRows=rows.filter(x=>x.source==="model"&&x.split===s),baselineRows=rows.filter(x=>x.source===source&&x.split===s);
    const modelIds=new Set(modelRows.map(x=>x.observationIndex)),baselineIds=new Set(baselineRows.map(x=>x.observationIndex));
    return [s,{model:summarize(modelRows.filter(x=>baselineIds.has(x.observationIndex))),
      baseline:summarize(baselineRows.filter(x=>modelIds.has(x.observationIndex)))}];
  })) as Record<"train"|"calibration"|"test",{model:ReturnType<typeof summarize>;baseline:ReturnType<typeof summarize>}>;
  const availability=Object.fromEntries(["train","calibration","test"].map(s=>{
    const attempts=predictions.filter(x=>split.get(x.key)===s);
    const timely=attempts.filter(x=>{const end=ends.get(x.key);return end&&validTimeline(x)&&!lateDelivery(x)&&
      x.result.status==="answered"&&rangeSchema.safeParse(x.result.answer).success;});
    return [s,{plannedTasks:manifest.filter(x=>x.split===s).length,attemptedPredictions:attempts.length,
      timelyAnswered:timely.length,timelyAnswerRate:attempts.length?timely.length/attempts.length:null,
      tasksWithTimelyAnswer:new Set(timely.map(x=>x.key)).size}];
  })) as Record<"train"|"calibration"|"test",{plannedTasks:number;attemptedPredictions:number;timelyAnswered:number;timelyAnswerRate:number|null;tasksWithTimelyAnswer:number}>;
  return {counts:{planned:manifest.length,ended:ends.size,missing:manifest.length-ends.size,
    verified:[...ends.values()].filter(x=>x.outcome==="verified").length,
    failed:[...ends.values()].filter(x=>x.outcome==="failed").length,interrupted:[...ends.values()].filter(x=>x.outcome==="interrupted").length,
    predictions:predictions.length,late:predictions.filter(lateDelivery).length,
    invalidTimeline:predictions.filter(x=>!validTimeline(x)).length,
    abstained:predictions.filter(x=>x.result.status==="abstained").length,
    invalid:predictions.filter(x=>x.result.status==="invalid_answer").length,
    busySkipped:events.filter(x=>(x as {type?:unknown})?.type==="sample_skipped"&&(x as {reason?:unknown}).reason==="busy").length,
    terminalSkipped:events.filter(x=>(x as {type?:unknown})?.type==="sample_skipped"&&(x as {reason?:unknown}).reason==="task_ended").length},
    model:view("model"),existingLocal:view("existing-local"),historical:view("historical"),calibrated:view("calibrated"),
    paired:{existingLocal:pairedView("existing-local"),historical:pairedView("historical"),calibrated:pairedView("calibrated")},availability,
    retrospectiveRequestOnly:summarize(requestRows.filter(x=>x.split==="test")),
    latencyMs:{median:quantile(predictions.flatMap(x=>x.result.durationMs===null?[]:[x.result.durationMs]),0.5),
      p90:quantile(predictions.flatMap(x=>x.result.durationMs===null?[]:[x.result.durationMs]),0.9)},
    baselineDiagnostics:local.diagnostics,rows,requestRows};
}
