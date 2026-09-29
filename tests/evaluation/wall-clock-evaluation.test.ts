import {it,expect} from 'vitest';
import {evaluateWallClockTask,summarizeWallClockTasks} from '../../src/evaluation/wall-clock-evaluation.js';
import {ETA_TIME_BASIS} from '../../src/core/eta-time-basis.js';
const fixture=()=>({basis:ETA_TIME_BASIS,threadId:'t',turnId:'r',controller:'independent_native_controller',
  controllerEvidenceRef:'frozen-controller:1',approvalFeedComplete:true,auditStatus:'compliant_observed',
  events:[{threadId:'t',turnId:'r',streamId:'s',sequence:1,monoMs:0,wallMs:10000,evidenceRef:'native:1',kind:'start'},
    {threadId:'t',turnId:'r',streamId:'s',sequence:2,monoMs:180000,wallMs:190000,evidenceRef:'native:2',kind:'terminal',outcome:'completed',finalReplyDelivered:true}],
  predictions:[{basis:ETA_TIME_BASIS,predictionId:'p',threadId:'t',turnId:'r',anchorMs:10000,deliveredAtMs:20000,
    remainingSeconds:180,displayedRemainingSeconds:170,deliveryEvidenceRefs:['render:1']}],taskTokens:1000,etaTokens:[100] as Array<number|null>});
it('connects independent native timeline, actual render samples and task scoring',()=>{
  const r=evaluateWallClockTask(fixture());
  expect(r).toMatchObject({labelSource:'independent_native_controller',primaryPredictions:1,meanAbsoluteErrorSeconds:0,tokenRatio:0.1});
});
it('does not elevate incomplete approval evidence to primary scoring',()=>{
  expect(evaluateWallClockTask({...fixture(),approvalFeedComplete:false})).toMatchObject({primaryPredictions:0,meanAbsoluteErrorSeconds:null,numericCoverage:1});
});
it.each(['violation','unreviewable'])('keeps %s sample but excludes accuracy',auditStatus=>{
  expect(evaluateWallClockTask({...fixture(),auditStatus})).toMatchObject({primaryPredictions:0,meanAbsoluteErrorSeconds:null,numericCoverage:1,primaryScorableCoverage:0});
});
it('does not report unknown usage as zero',()=>{
  expect(evaluateWallClockTask({...fixture(),etaTokens:[100,null]})).toMatchObject({etaTokens:null,knownEtaTokens:100,unknownEtaUsageCount:1,tokenRatio:null});
});
it('retains cancelled task and missing numerical forecast without scoring completion',()=>{
  const f=fixture();f.events[1]!.outcome='interrupted';
  expect(evaluateWallClockTask(f)).toMatchObject({outcome:'interrupted',primaryPredictions:0,meanAbsoluteErrorSeconds:null});
});
it('does not double-score duplicate records or select between conflicting duplicates',()=>{
  const f=fixture();f.predictions.push({...f.predictions[0]!});
  expect(evaluateWallClockTask(f)).toMatchObject({primaryPredictions:1,duplicateRecords:1,numericCoverage:1,primaryScorableCoverage:1});
  f.predictions[1]!.remainingSeconds=999;
  expect(evaluateWallClockTask(f).primaryPredictions).toBe(0);
});
it('rejects legacy protocol and duplicate task bindings',()=>{
  expect(()=>evaluateWallClockTask({...fixture(),basis:'legacy'})).toThrow();
  const r=evaluateWallClockTask(fixture());expect(()=>summarizeWallClockTasks([r,r])).toThrow('duplicate_task_binding');
});
it('task equal aggregate does not pool unequal call counts',()=>{
  const a=evaluateWallClockTask(fixture()),b={...a,threadId:'other',primaryPredictions:10,meanAbsoluteErrorSeconds:100,meanRelativeError:1};
  expect(summarizeWallClockTasks([a,b])).toMatchObject({tasks:2,taskEqualMeanAbsoluteErrorSeconds:50,taskEqualMeanRelativeError:0.5});
});
it('keeps malformed prediction rows as protocol failures',()=>{
  const f=fixture();f.predictions.push({wrong:'shape'} as any);
  expect(evaluateWallClockTask(f).rows[1]).toMatchObject({primaryEligible:false,reason:'prediction_protocol_failure'});
});
