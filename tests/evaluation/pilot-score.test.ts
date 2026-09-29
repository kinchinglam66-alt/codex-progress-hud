import {it,expect} from 'vitest';
import {scorePilotGoal} from '../../src/evaluation/pilot-score.js';
import {ETA_TIME_BASIS} from '../../src/core/eta-time-basis.js';
const label={session:'s',key:'k',generation:1,outcome:'completed',confirmedBy:'user',completedActiveSeconds:3600};
const records=[{session:'s',key:'k',generation:1,kind:'result',accepted:true,status:'interpreted',at:125000,requestedAt:120000,
  observedActiveSeconds:600,activeSeconds:605,estimate:{remainingSeconds:2400,errorPercent:30},usage:null}];
it('never silently scores versioned wall-clock rows using legacy active-time labels',()=>{
  expect(scorePilotGoal(records.map(r=>({...r,timeBasis:ETA_TIME_BASIS})),label)).toMatchObject({attempts:0,predictions:0});
});
it('scores against independently labelled active work, not wall time or model completion',()=>{
  const score=scorePilotGoal(records,label);
  expect(score.points[0]).toMatchObject({actualRemainingSeconds:3000,absoluteErrorSeconds:600,relativeError:0.2,covered:true,latencyMs:5000,phase:'early'});
  expect(score).toMatchObject({eligible:true,attempts:1,predictions:1,meanAbsoluteErrorSeconds:600,coverage:1});
});
it('does not manufacture an accuracy score for interrupted or unconfirmed goals',()=>{
  expect(scorePilotGoal(records,{session:'s',key:'k',generation:1,outcome:'interrupted',confirmedBy:'user'})).toMatchObject({eligible:false,meanAbsoluteErrorSeconds:null});
  expect(scorePilotGoal(records,{session:'s',key:'k',generation:1,outcome:'replaced',confirmedBy:'user',censoredActiveSeconds:900})).toMatchObject({eligible:false});
  expect(()=>scorePilotGoal(records,{...label,outcome:'interrupted'})).toThrow();
  expect(()=>scorePilotGoal(records,{...label,confirmedBy:'observer'})).toThrow();
});
it('counts unavailable outcomes but excludes stale predictions and unrelated goals',()=>{
  const more=[...records,{...records[0],estimate:null},{...records[0],accepted:false},{...records[0],key:'other'}];
  expect(scorePilotGoal(more,label)).toMatchObject({attempts:3,predictions:1,availability:1/3});
});
it.each([{activeTimeKnown:false},{timingUncertain:true}])('retains attempts but excludes uncertain clock evidence %j',flags=>{
  expect(scorePilotGoal([{...records[0],...flags}],label)).toMatchObject({attempts:1,predictions:0,meanAbsoluteErrorSeconds:null});
});
it('continues to score explicitly known clocks',()=>{
  expect(scorePilotGoal([{...records[0],activeTimeKnown:true,timingUncertain:false}],label)).toMatchObject({predictions:1});
});
it.each([3600,3601])('retains but does not score delivery at or after completion (%s)',activeSeconds=>{
  expect(scorePilotGoal([{...records[0],activeSeconds}],label)).toMatchObject({
    eligible:true,attempts:1,predictions:0,availability:0,meanAbsoluteErrorSeconds:null,points:[],
  });
});
it('still scores delivery just before completion without moving the request anchor',()=>{
  const score=scorePilotGoal([{...records[0],activeSeconds:3599.5}],label);
  expect(score).toMatchObject({attempts:1,predictions:1});
  expect(score.points[0]).toMatchObject({actualRemainingSeconds:3000,actualRemainingAtDeliverySeconds:0.5});
});
it.each([{generation:2},{snapshotActiveSeconds:601},{acceptedAt:125001},{acceptedAt:119999}])('rejects inconsistent forecast anchors %j',mismatch=>{
  const forecast={schemaVersion:1,predictionId:1,generation:1,snapshotActiveSeconds:600,acceptedAt:125000,
    rawSeconds:2400,shadowSeconds:null,paceReason:'missing_measurements',calibration:'uncalibrated',
    versions:{input:'v1',prompt:'v1',model:'v1',algorithm:'v1'},...mismatch};
  expect(scorePilotGoal([{...records[0],forecast}],label)).toMatchObject({attempts:1,predictions:0});
});
it('reads versioned forecast metadata while preserving legacy raw scoring',()=>{
  const forecast={schemaVersion:1,predictionId:1,generation:1,snapshotActiveSeconds:600,acceptedAt:125000,
    rawSeconds:2400,shadowSeconds:2100,paceReason:'eligible',calibration:'uncalibrated',
    measurement:{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3},
    versions:{input:'facts-v1',prompt:'prompt-v1',model:'model-v1',algorithm:'pace-v1'}};
  const score=scorePilotGoal([{...records[0],forecast}],label);
  expect(score).toMatchObject({attempts:1,predictions:1});
  expect(score.points[0]).toMatchObject({shadowRemainingSeconds:2100});
  expect(scorePilotGoal([{...records[0],at:125005,forecast}],label)).toMatchObject({predictions:1});
});
