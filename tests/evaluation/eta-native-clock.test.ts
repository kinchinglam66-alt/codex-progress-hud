import {it,expect} from 'vitest';
import {NativeEtaClock,classifyApprovalWait,type NativeEtaClockEvent} from '../../src/core/eta-native-clock.js';
import {measureEtaWindow,ETA_TIME_BASIS} from '../../src/core/eta-time-contract.js';
import {scoreWallClockPrediction} from '../../src/evaluation/wall-clock-score.js';

const event=(sequence:number,ms:number,patch:Partial<NativeEtaClockEvent>={}):NativeEtaClockEvent=>({
  threadId:'t',turnId:'r',streamId:'s',sequence,monoMs:ms,wallMs:10000+ms,evidenceRef:`event:${sequence}`,
  kind:sequence===1?'start':'state',...(sequence===1?{}:{state:'system_or_running' as const}),...patch});
const start=()=>new NativeEtaClock({threadId:'t',turnId:'r',approvalFeedComplete:true},event(1,0));
const terminal=(sequence:number,ms:number,patch:Partial<NativeEtaClockEvent>={})=>event(sequence,ms,
  {kind:'terminal',outcome:'completed',finalReplyDelivered:true,...patch});
const value=(c:NativeEtaClock)=>{const t=c.snapshot().timeline;return measureEtaWindow(t,t.startMs,t.endMs);};

it('counts a silent 30-minute download and reaches the actual reply boundary',()=>{
  const c=start();c.accept(terminal(2,1800000));
  expect(value(c)).toMatchObject({seconds:1800,excludedHumanSeconds:0,reliable:true});
  const r=scoreWallClockPrediction(c.snapshot().timeline,{basis:ETA_TIME_BASIS,predictionId:'p',threadId:'t',turnId:'r',
    anchorMs:10000,deliveredAtMs:50000,remainingSeconds:1800,displayedRemainingSeconds:1760,deliveryEvidenceRefs:['display:1']});
  expect(r.primaryEligible).toBe(true);expect(r.delivery?.absoluteErrorSeconds).toBe(0);
});
it('deducts only the period after all relevant background work stops',()=>{
  const c=start();c.accept(event(2,100000,{state:'blocking_unknown'}));
  c.accept(event(3,300000,{state:'confirmed_human_block',humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false}));
  c.accept(event(4,500000));c.accept(terminal(5,600000));
  expect(value(c)).toMatchObject({seconds:400,excludedHumanSeconds:200,unknownBlockingSeconds:200,reliable:false});
});
it('counts automatic review even if the command waits',()=>{
  expect(classifyApprovalWait({actor:'automatic',wholeTurnBlocked:true,relevantWorkRunning:false,impactKnown:true}).state).toBe('system_or_running');
});
it('does not mistake a human prompt alone for a stop',()=>{
  expect(classifyApprovalWait({actor:'human',impactKnown:false})).toMatchObject({state:'blocking_unknown'});
});
it('marks uncertain overlap while preserving elapsed time',()=>{
  expect(classifyApprovalWait({actor:'human',relevantWorkRunning:true,impactKnown:false})).toMatchObject({state:'blocking_unknown'});
});
it('accepts confirmed human full block but requires all proof fields',()=>{
  expect(classifyApprovalWait({actor:'human',wholeTurnBlocked:true,relevantWorkRunning:false,impactKnown:true}).state).toBe('confirmed_human_block');
  const c=start();expect(()=>c.accept(event(2,100,{state:'confirmed_human_block'}))).toThrow('human_block_not_proven');
});
it.each(['interrupted','failed'] as const)('preserves %s instead of fabricating successful completion',outcome=>{
  const c=start();c.accept(terminal(2,480000,{outcome}));expect(c.snapshot().timeline.outcome).toBe(outcome);
});
it('requires final delivery confirmation, not just a completed label',()=>{
  const c=start();c.accept(terminal(2,480000,{finalReplyDelivered:false}));
  expect(c.snapshot().timeline.outcome).toBe('unknown');
});
it('is idempotent for duplicate last event, including duplicate terminal',()=>{
  const c=start(),e=terminal(2,100);c.accept(e);expect(c.accept(e)).toBe('duplicate');expect(value(c).seconds).toBe(0.1);
});
it('rejects conflicting duplicate and out-of-order event',()=>{
  const c=start();c.accept(event(2,100));
  expect(()=>c.accept(event(2,101))).toThrow('conflicting_clock_event');
  expect(()=>c.accept(event(1,0))).toThrow('clock_event_order');
});
it('rejects cross-turn and cross-thread events',()=>{
  const c=start();expect(()=>c.accept(event(2,100,{turnId:'other'}))).toThrow('clock_binding_mismatch');
  expect(()=>c.accept(event(2,100,{threadId:'other'}))).toThrow('clock_binding_mismatch');
});
it('retains disconnect interval rather than resetting time after restart',()=>{
  const c=start();c.accept(event(2,100000,{kind:'disconnect'}));
  c.accept(event(1,0,{kind:'reconnect',streamId:'s2',wallMs:310000}));
  c.accept(event(2,10000,{streamId:'s2',wallMs:320000}));
  c.accept(terminal(3,300000,{streamId:'s2',wallMs:610000}));
  expect(value(c)).toMatchObject({grossSeconds:600,seconds:600,recordingGapSeconds:200,reliable:false});
});
it('never carries a pre-restart human block proof into the new stream',()=>{
  const c=start();c.accept(event(2,100000,{state:'confirmed_human_block',humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false}));
  c.accept(event(1,0,{kind:'reconnect',streamId:'s2',wallMs:310000}));
  c.accept(terminal(2,300000,{streamId:'s2',wallMs:610000}));
  expect(value(c)).toMatchObject({excludedHumanSeconds:0,unknownBlockingSeconds:300,recordingGapSeconds:200});
});
it('marks a missing native event as a gap',()=>{
  const c=start();c.accept(terminal(3,1000));expect(value(c)).toMatchObject({recordingGapSeconds:1,reliable:false});
});
it('rejects reversed clocks and marks forward wall clock jumps unverified',()=>{
  const c=start();expect(()=>c.accept(event(2,1,{wallMs:9999}))).toThrow('clock_reversed');
  c.accept(terminal(2,1000,{wallMs:20000}));expect(value(c).reliable).toBe(false);
});
it('refuses to certify start/end history as a complete approval feed',()=>{
  const c=new NativeEtaClock({threadId:'t',turnId:'r',approvalFeedComplete:false},event(1,0));
  c.accept(terminal(2,1800000));expect(value(c)).toMatchObject({seconds:1800,reliable:false});
  expect(c.snapshot().problems).toContain('approval_feed_incomplete');
});
it('does not allow post-terminal work to reopen the same turn',()=>{
  const c=start();c.accept(terminal(2,100));expect(()=>c.accept(event(3,200))).toThrow('clock_already_terminal');
});
it('snapshots cannot mutate internal evidence',()=>{
  const c=start();c.accept(terminal(2,100));c.snapshot().timeline.segments[0]!.kind='recording_gap';
  expect(value(c).reliable).toBe(true);
});
it('does not certify contradictory or unverified approval facts',()=>{
  expect(classifyApprovalWait({actor:'human',wholeTurnBlocked:true,relevantWorkRunning:true,impactKnown:true}).state).toBe('blocking_unknown');
  expect(classifyApprovalWait({actor:'human',wholeTurnBlocked:true,relevantWorkRunning:false,impactKnown:false}).state).toBe('blocking_unknown');
});
it('rejects reuse of a previous process clock after reconnect',()=>{
  const c=start();c.accept(event(1,0,{kind:'reconnect',streamId:'s2',wallMs:11000}));
  expect(()=>c.accept(event(1,0,{kind:'reconnect',streamId:'s',wallMs:12000}))).toThrow('reused_clock_stream');
});
