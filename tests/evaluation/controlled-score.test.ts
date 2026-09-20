import {expect,it} from "vitest";
import {scoreControlled} from "../../src/evaluation/controlled-score.js";
const manifest=[{key:"sample_a",split:"test"},{key:"sample_b",split:"test"}];
const prediction=(key:string,at:number,delivery:number,late=false)=>({type:"prediction",key,metrics:{activeSeconds:at},deliveredSeconds:delivery,late,
  result:{status:"answered",answer:{lowSeconds:8,highSeconds:12},durationMs:(delivery-at)*1000}});
it('retains but does not score a delivery before the observation anchor',()=>{
  const invalid={...prediction('sample_a',8,2),result:{status:'answered',answer:{lowSeconds:8,highSeconds:12},durationMs:1000}};
  const report=scoreControlled(manifest,[{type:'end',key:'sample_a',outcome:'verified',atSeconds:10},invalid]);
  expect(report.counts).toMatchObject({predictions:1,invalidTimeline:1});
  expect(report.rows).toEqual([]);expect(report.requestRows).toEqual([]);
  expect(report.availability.test).toMatchObject({attemptedPredictions:1,timelyAnswered:0});
});
it('excludes predictions requested at or after the terminal boundary',()=>{
  for(const at of [10,11]){
    const report=scoreControlled(manifest,[{type:'end',key:'sample_a',outcome:'verified',atSeconds:10},prediction('sample_a',at,at+1)]);
    expect(report.rows).toEqual([]);expect(report.requestRows).toEqual([]);
    expect(report.counts).toMatchObject({invalidTimeline:1});
  }
});
it('infers late delivery from the terminal boundary even when the producer flag is false',()=>{
  const report=scoreControlled(manifest,[{type:'end',key:'sample_a',outcome:'verified',atSeconds:10},prediction('sample_a',0,10)]);
  expect(report.counts).toMatchObject({late:1,invalidTimeline:0});
  expect(report.rows).toEqual([]);expect(report.requestRows).toHaveLength(1);
});
it("ages delivered intervals, excludes late and censored predictions, and retains missing tasks",()=>{
  const report=scoreControlled(manifest,[
    {type:"end",key:"sample_a",outcome:"verified",atSeconds:10},prediction("sample_a",0,2),prediction("sample_a",0,12,true),
    {type:"end",key:"sample_b",outcome:"interrupted",atSeconds:8},prediction("sample_b",0,1)]);
  expect(report.model.test).toMatchObject({scoredTasks:1,maeSeconds:0,coverage:1,meanWidthSeconds:4});
  expect(report.counts).toMatchObject({planned:2,verified:1,interrupted:1,predictions:3,late:1});
  expect(report.rows[0]).toMatchObject({actualSeconds:8,lowSeconds:6,highSeconds:10});
});
it("reports unavailable accuracy as null, never zero error",()=>{
  const report=scoreControlled(manifest,[]);
  expect(report.model.test.maeSeconds).toBeNull();expect(report.counts.missing).toBe(2);
});
it("compares model and baseline only on identical answered observations",()=>{
  const training=Array.from({length:5},(_,i)=>({key:`sample_train_${i}`,split:"train"}));
  const events=[...training.map(x=>({type:"end",key:x.key,outcome:"verified",atSeconds:10})),
    {type:"end",key:"sample_a",outcome:"verified",atSeconds:10},
    {type:"end",key:"sample_b",outcome:"verified",atSeconds:10},
    prediction("sample_a",0,2),
    {...prediction("sample_b",0,2),result:{status:"abstained",answer:null,durationMs:2000}}];
  const report=scoreControlled([...training,...manifest],events);
  expect(report.historical.test.scoredPredictions).toBe(2);
  expect(report.paired.historical.test.model.scoredPredictions).toBe(1);
  expect(report.paired.historical.test.baseline.scoredPredictions).toBe(1);
  expect(report.availability.test).toMatchObject({plannedTasks:2,attemptedPredictions:2,timelyAnswered:1,timelyAnswerRate:0.5});
});
