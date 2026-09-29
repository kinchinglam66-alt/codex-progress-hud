import {describe,it,expect} from 'vitest';
import {ETA_TIME_BASIS,etaTimelineSchema,measureEtaWindow,projectWallCountdown,type EtaTimeline} from '../../src/core/eta-time-contract.js';
import {scoreWallClockPrediction} from '../../src/evaluation/wall-clock-score.js';

const segment=(startMs:number,endMs:number,kind:EtaTimeline['segments'][number]['kind']='system_or_running')=>({startMs,endMs,kind,evidenceRefs:['native:1'],
  ...(kind==='confirmed_human_block'?{humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false}:{})});
const timeline=(patch:Partial<EtaTimeline>={}):EtaTimeline=>({basis:ETA_TIME_BASIS,threadId:'t',turnId:'r',
  startMs:0,endMs:1800000,outcome:'completed',clockVerified:true,boundaryEvidenceRefs:['native:completed'],
  segments:[segment(0,1800000)],...patch});
const prediction=(patch:Record<string,unknown>={})=>({basis:ETA_TIME_BASIS,predictionId:'p',threadId:'t',turnId:'r',
  anchorMs:0,deliveredAtMs:40000,remainingSeconds:1800,displayedRemainingSeconds:1760,deliveryEvidenceRefs:['display:1'],...patch});

describe('wall clock contract',()=>{
  it('counts a 30 minute download including silent model time',()=>{
    expect(measureEtaWindow(timeline(),0,1800000).seconds).toBe(1800);
  });
  it.each(['model queue','network retry','automatic approval','parallel tests'])('counts %s without summing parallel jobs',()=>{
    expect(scoreWallClockPrediction(timeline(),prediction()).delivery?.absoluteErrorSeconds).toBe(0);
  });
  it('deducts only confirmed full human block, not work overlapping approval',()=>{
    const t=timeline({segments:[segment(0,180000),segment(180000,780000,'confirmed_human_block'),segment(780000,1800000)]});
    expect(measureEtaWindow(t,0,1800000)).toMatchObject({seconds:1200,excludedHumanSeconds:600,reliable:true});
    expect(projectWallCountdown(t,180000,780000,500).remainingSeconds).toBe(500);
  });
  it('keeps unknown approval overlap in clock but excludes primary scoring',()=>{
    const t=timeline({segments:[segment(0,100000,'blocking_unknown'),segment(100000,1800000)]});
    const r=scoreWallClockPrediction(t,prediction());
    expect(r.primaryEligible).toBe(false);
    expect(r.sensitivity?.anchor).toMatchObject({seconds:1800,unknownBlockingSeconds:100,
      sensitivityBounds:{lowerSeconds:1700,upperSeconds:1800}});
  });
  it('does not deduct a human-labelled wait with background work',()=>{
    expect(()=>etaTimelineSchema.parse(timeline({segments:[{...segment(0,1800000,'confirmed_human_block'),relevantWorkRunning:true}]}))).toThrow();
  });
  it('requires affirmative full blockage proof',()=>{
    expect(()=>etaTimelineSchema.parse(timeline({segments:[{...segment(0,1800000),kind:'confirmed_human_block'}]}))).toThrow();
  });
  it.each(['interrupted','failed','unknown','running'] as const)('does not score %s as completion',outcome=>{
    const r=scoreWallClockPrediction(timeline({outcome}),prediction());
    expect(r.primaryEligible).toBe(false); expect(r.delivery).toBeNull();
  });
  it('normal completed reply can be scored regardless of answer correctness',()=>{
    expect(scoreWallClockPrediction(timeline(),prediction()).primaryEligible).toBe(true);
  });
  it('counts same-turn recovery and does not reset clock',()=>{
    const t=timeline({segments:[segment(0,600000),segment(600000,900000),segment(900000,1800000)]});
    expect(measureEtaWindow(t,0,1800000).seconds).toBe(1800);
  });
  it('does not interpolate recorder restart gap into scorable coverage',()=>{
    const t=timeline({segments:[segment(0,100000,'recording_gap'),segment(100000,1800000)]});
    const r=scoreWallClockPrediction(t,prediction());
    expect(r.primaryEligible).toBe(false); expect(r.sensitivity?.anchor.sensitivityBounds).toBeNull();
  });
  it('scores actual displayed value, not a substituted simulated countdown',()=>{
    const r=scoreWallClockPrediction(timeline(),prediction({displayedRemainingSeconds:1800}));
    expect(r.anchor?.absoluteErrorSeconds).toBe(0); expect(r.delivery?.signedErrorSeconds).toBe(40);
  });
  it('subtracts preparation time once when projecting display',()=>{
    expect(projectWallCountdown(timeline(),0,40000,1800).remainingSeconds).toBe(1760);
  });
  it.each([{threadId:'other'},{turnId:'other'},{anchorMs:50000},{deliveredAtMs:1800000},
    {remainingSeconds:null},{displayedRemainingSeconds:null}])('excludes invalid/missing prediction %j',patch=>{
    expect(scoreWallClockPrediction(timeline(),prediction(patch)).primaryEligible).toBe(false);
  });
  it('keeps short remaining errors separate from relative error',()=>{
    const r=scoreWallClockPrediction(timeline(),prediction({anchorMs:1770000,deliveredAtMs:1780000,remainingSeconds:30,displayedRemainingSeconds:20}));
    expect(r.delivery).toMatchObject({relativeError:null,shortRemaining:true,absoluteErrorSeconds:0});
  });
  it('does not reinterpret old active-time records',()=>{
    expect(()=>scoreWallClockPrediction(timeline(),prediction({basis:'active-v1'}))).toThrow();
  });
  it('does not score an unverified clock',()=>{
    expect(scoreWallClockPrediction(timeline({clockVerified:false}),prediction()).primaryEligible).toBe(false);
  });
  it.each([
    {segments:[segment(0,1000000),segment(900000,1800000)]},
    {segments:[segment(0,900000),segment(1000000,1800000)]},
    {segments:[segment(0,900000)]},
  ])('rejects overlapping or incomplete interval partitions',({segments})=>{
    expect(()=>etaTimelineSchema.parse(timeline({segments}))).toThrow();
  });
  it('rejects windows outside the turn',()=>{
    expect(()=>measureEtaWindow(timeline(),-1,1000)).toThrow();
  });
  it('does not let an earlier unknown block invalidate a later fully verified window',()=>{
    const t=timeline({segments:[segment(0,100000,'blocking_unknown'),segment(100000,1800000)]});
    expect(scoreWallClockPrediction(t,prediction({anchorMs:100000,deliveredAtMs:140000})).primaryEligible).toBe(true);
  });
});
