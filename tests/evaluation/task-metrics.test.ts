import { expect, it } from "vitest";
import { evaluateTraces, comparePredictors, type Trace, type Predictor } from "../../src/evaluation/replay.js";

const dense:Trace={sampleKey:"sample_dense",observations:Array.from({length:10},(_,atSeconds)=>({atSeconds,state:"running",progress:0.1})),
  end:{atSeconds:10,outcome:"succeeded_verified"}};
const sparse:Trace={sampleKey:"sample_sparse",observations:[{atSeconds:0,state:"running",progress:0.9}],
  end:{atSeconds:100,outcome:"succeeded_verified"}};
const predictor:()=>Predictor=()=>prefix=>{
  const point=prefix.at(-1)!;
  return point.progress===0.1?{lowSeconds:9-point.atSeconds,highSeconds:11-point.atSeconds}:{lowSeconds:0,highSeconds:0};
};
it("weights tasks equally rather than letting ten dense observations outweigh one sparse task",()=>{
  const result=evaluateTraces([dense,sparse],predictor);
  expect(result.metrics.maeSeconds).toBeCloseTo(100/11);
  expect(result.taskMetrics).toMatchObject({totalTasks:2,tasksWithAttempts:2,scoredTasks:2,
    maeSeconds:50,meanAbstentionRate:0,meanInvalidRate:0});
  expect(result.taskMetrics.coverage).toBeCloseTo(0.5);
  expect(result.taskMetrics.meanWidthSeconds).toBeCloseTo(1);
});
it("counts all five outcomes once per task including tasks with no running observations",()=>{
  const outcomes=["succeeded_verified","completed_unverified","failed","interrupted","unfinished"] as const;
  const traces=outcomes.map((outcome,i)=>({...sparse,sampleKey:`sample_${i}`,
    observations:[{atSeconds:0,state:i===4?"waiting" as const:"running" as const}],end:{atSeconds:100,outcome}}));
  const result=evaluateTraces(traces,predictor);
  expect(result.taskOutcomes).toEqual({succeeded_verified:1,completed_unverified:1,failed:1,interrupted:1,unfinished:1});
  expect(result.taskMetrics).toMatchObject({totalTasks:5,tasksWithAttempts:4,scoredTasks:1});
  expect(result.rows.filter(r=>r.actualSeconds!==null)).toHaveLength(1);
});
it("reports per-task abstention and invalid rates independently of score eligibility",()=>{
  const result=evaluateTraces([dense,sparse],()=>prefix=>{
    if(prefix.at(-1)!.progress===0.9) throw Error("fixture");
    return null;
  });
  expect(result.taskMetrics).toMatchObject({scoredTasks:0,maeSeconds:null,coverage:null,
    meanWidthSeconds:null,meanAbstentionRate:0.5,meanInvalidRate:0.5});
});
it("uses the common prefix mask for matched task metrics and retains all-view refusal",()=>{
  const result=comparePredictors([dense,sparse],[predictor,()=>prefix=>prefix.at(-1)!.progress===0.9?null:predictor()(prefix)]);
  expect(result.commonScored).toBe(10);
  for(const item of result.predictors) {
    expect(item.matchedTaskMetrics).toMatchObject({totalTasks:2,tasksWithAttempts:1,scoredTasks:1,maeSeconds:0});
    expect(item.matchedTaskMetrics.coverage).toBeCloseTo(1);
    expect(item.matchedTaskMetrics.meanWidthSeconds).toBeCloseTo(2);
  }
  expect(result.predictors[1]!.all.taskMetrics.meanAbstentionRate).toBe(0.5);
});
it("empty or entirely unmatched views never imply zero prediction error",()=>{
  expect(evaluateTraces([],predictor).taskMetrics).toMatchObject({totalTasks:0,tasksWithAttempts:0,scoredTasks:0,
    maeSeconds:null,coverage:null,meanAbstentionRate:null,meanInvalidRate:null});
  const result=comparePredictors([dense],[predictor,()=>()=>null]);
  expect(result.predictors[0]!.matchedTaskMetrics).toMatchObject({totalTasks:1,tasksWithAttempts:0,scoredTasks:0,maeSeconds:null});
});
