import {it,expect} from 'vitest';
import {scorePilotGoal} from '../../src/evaluation/pilot-score.js';
const label={session:'s',key:'k',generation:1,outcome:'completed',confirmedBy:'user',completedActiveSeconds:3600};
const records=[{session:'s',key:'k',generation:1,kind:'result',accepted:true,status:'interpreted',at:125000,requestedAt:120000,
  observedActiveSeconds:600,activeSeconds:605,estimate:{remainingSeconds:2400,errorPercent:30},usage:null}];
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
