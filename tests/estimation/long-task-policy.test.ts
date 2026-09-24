import {describe,it,expect} from 'vitest';
import {canRequest,decideTrigger,type RequestContext} from '../../src/estimation/long-task-policy.js';

const base:RequestContext={elapsedSeconds:15,lastRequestSeconds:null,remainingSeconds:1800,
  unknownResults:0,eventAtSeconds:null,contentReady:true,hasNewInformation:true,
  state:'running',statusEvidenceArrived:false,goalInFlight:false,globalInFlight:0,
  conversationStartsLastHour:0};
describe('long-task request eligibility (not spend authorization)',()=>{
  it('admits a reserved near-expiry check while retaining cooldown and safety gates',()=>{
    const c={...base,lastRequestSeconds:15,elapsedSeconds:95,remainingSeconds:20,
      hasNewInformation:false,nearExpiryRecheck:true};
    expect(decideTrigger(c).reason).toBe('near_expiry');
    expect(canRequest({...c,elapsedSeconds:29.999})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:30})).toBe(true);
    expect(canRequest({...c,state:'waiting'})).toBe(false);
    expect(canRequest({...c,state:'paused'})).toBe(false);
    expect(canRequest({...c,state:'terminal'})).toBe(false);
    expect(canRequest({...c,goalInFlight:true})).toBe(false);
    expect(canRequest({...c,globalInFlight:200})).toBe(true);
    expect(canRequest({...c,conversationStartsLastHour:12})).toBe(true);
    expect(canRequest({...c,contentReady:false})).toBe(false);
    expect(canRequest({...c,remainingSeconds:null})).toBe(false);
    expect(canRequest({...c,remainingSeconds:0})).toBe(false);
  });
  it('keeps hard timing, runtime and resource gates on a pre-dispatch retry',()=>{
    const retry={...base,preDispatchRetry:true,hasNewInformation:false,lastRequestSeconds:15,elapsedSeconds:75};
    expect(canRequest(retry)).toBe(true);
    expect(canRequest({...retry,elapsedSeconds:29.999})).toBe(false);
    expect(decideTrigger({...retry,elapsedSeconds:30}).blockReason).toBe('retry_backoff');
    expect(canRequest({...retry,elapsedSeconds:74.999})).toBe(false);
    expect(canRequest({...retry,globalInFlight:200})).toBe(true);
    expect(canRequest({...retry,conversationStartsLastHour:12})).toBe(true);
    expect(canRequest({...retry,state:'paused'})).toBe(false);
    expect(canRequest({...retry,state:'terminal'})).toBe(false);
    expect(canRequest({...retry,contentReady:false})).toBe(false);
  });
  it('requires first observation but does not spend fifteen seconds waiting',()=>{
    expect(canRequest({...base,elapsedSeconds:0,eventAtSeconds:0})).toBe(true);
    expect(canRequest({...base,contentReady:false})).toBe(false);
    expect(canRequest(base)).toBe(true);
  });
  it.each([[600,180],[601,180],[1800,180],[1801,180],[28800,180],[28801,180]])(
    'checks remaining %s at interval %s', (remainingSeconds,delay)=>{
      expect(canRequest({...base,remainingSeconds,lastRequestSeconds:15,elapsedSeconds:15+delay-1})).toBe(false);
      expect(canRequest({...base,remainingSeconds,lastRequestSeconds:15,elapsedSeconds:15+delay})).toBe(true);
    });
  it.each([[1,180],[2,180],[3,180],[8,180]])('reviews unknown results every 180 seconds (%s)',(unknownResults,delay)=>{
    const c={...base,remainingSeconds:null,unknownResults,lastRequestSeconds:15};
    expect(canRequest({...c,elapsedSeconds:15+delay-1})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:15+delay})).toBe(true);
  });
  it('allows one bounded bootstrap recovery only with new content after cooldown',()=>{
    const c={...base,remainingSeconds:null,unknownResults:1,lastRequestSeconds:15,elapsedSeconds:75,
      hasNewInformation:true,hasNewContent:true,bootstrapRecovery:true};
    expect(decideTrigger(c)).toMatchObject({reason:'bootstrap_recovery',blockReason:null});
    expect(canRequest({...c,elapsedSeconds:74})).toBe(false);
    expect(canRequest({...c,hasNewContent:false})).toBe(false);
    expect(canRequest({...c,state:'paused'})).toBe(false);
    expect(canRequest({...c,state:'terminal'})).toBe(false);
    expect(canRequest({...c,contentReady:false})).toBe(false);
    expect(canRequest({...c,goalInFlight:true})).toBe(false);
  });
  it('excludes a long pause from the bootstrap active-time cooldown',()=>{
    const c={...base,remainingSeconds:null,unknownResults:1,lastRequestSeconds:15,elapsedSeconds:1000,
      activeSeconds:25,lastRequestActiveSeconds:15,hasNewInformation:true,hasNewContent:true,bootstrapRecovery:true};
    expect(decideTrigger(c)).toMatchObject({blockReason:'cooldown',eligibleActiveSeconds:75});
    expect(decideTrigger({...c,activeSeconds:74.999})).toMatchObject({blockReason:'cooldown'});
    expect(decideTrigger({...c,activeSeconds:75})).toMatchObject({reason:'bootstrap_recovery',eligibleActiveSeconds:75});
  });
  it('coalesces events for two seconds while retaining minimum fifteen-second spacing',()=>{
    const c={...base,lastRequestSeconds:15,remainingSeconds:50000,eventAtSeconds:70};
    expect(canRequest({...c,elapsedSeconds:71.999})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:72})).toBe(true);
    expect(canRequest({...c,eventAtSeconds:20,elapsedSeconds:29})).toBe(false);
    expect(canRequest({...c,eventAtSeconds:20,elapsedSeconds:30})).toBe(true);
    expect(canRequest({...c,eventAtSeconds:10,elapsedSeconds:80})).toBe(false);
  });
  it('never calls merely because time passed',()=>{
    expect(canRequest({...base,elapsedSeconds:5000,hasNewInformation:false})).toBe(false);
  });
  it('permits an owner-authorized overdue action recheck without new content',()=>{
    const c={...base,elapsedSeconds:75,lastRequestSeconds:15,remainingSeconds:0,
      hasNewInformation:false,overdueActionRecheck:true};
    expect(canRequest(c)).toBe(true);
    expect(canRequest({...c,overdueActionRecheck:false})).toBe(false);
    expect(canRequest({...c,remainingSeconds:1})).toBe(false);
    expect(canRequest({...c,remainingSeconds:null})).toBe(false);
    expect(canRequest({...c,lastRequestSeconds:null})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:29.999})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:30})).toBe(true);
    expect(canRequest({...c,conversationStartsLastHour:12})).toBe(true);
    expect(canRequest({...c,globalInFlight:200})).toBe(true);
    expect(canRequest({...c,state:'paused'})).toBe(false);
    expect(canRequest({...c,state:'waiting',statusEvidenceArrived:false,eventAtSeconds:60})).toBe(false);
  });
  it('suppresses quiet states except newly arrived status evidence in waiting',()=>{
    for(const state of ['waiting','paused','terminal'] as const)
      expect(canRequest({...base,state})).toBe(false);
    expect(canRequest({...base,state:'waiting',statusEvidenceArrived:true,eventAtSeconds:5})).toBe(true);
    expect(canRequest({...base,state:'paused',statusEvidenceArrived:true,eventAtSeconds:5})).toBe(false);
    expect(canRequest({...base,state:'waiting',statusEvidenceArrived:true,eventAtSeconds:null})).toBe(false);
  });
  it('retains same-conversation exclusion without a global concurrency ceiling',()=>{
    expect(canRequest({...base,goalInFlight:true})).toBe(false);
    expect(canRequest({...base,globalInFlight:200})).toBe(true);
    expect(canRequest({...base,conversationStartsLastHour:120})).toBe(true);
    expect(canRequest({...base,globalInFlight:1,conversationStartsLastHour:11})).toBe(true);
  });
  it('fails closed on invalid clocks and counters',()=>{
    expect(canRequest({...base,elapsedSeconds:NaN})).toBe(false);
    expect(canRequest({...base,lastRequestSeconds:16})).toBe(false);
    expect(canRequest({...base,eventAtSeconds:16})).toBe(false);
    expect(canRequest({...base,remainingSeconds:-1})).toBe(false);
    expect(canRequest({...base,globalInFlight:-1})).toBe(false);
    expect(canRequest({...base,unknownResults:0.5})).toBe(false);
  });
  it('selects a periodic trigger from active progress and exposes its active anchor',()=>{
    const c={...base,elapsedSeconds:194,lastRequestSeconds:15,activeSeconds:194,
      lastRequestActiveSeconds:15,hasNewInformation:false};
    expect(decideTrigger(c)).toMatchObject({reason:null,blockReason:'adaptive_interval',
      eligibleActiveSeconds:195});
    expect(decideTrigger({...c,elapsedSeconds:195,activeSeconds:195})).toMatchObject({reason:'periodic',
      blockReason:null,eligibleActiveSeconds:195});
  });
  it('does not treat wall time during a pause as active progress',()=>{
    const c={...base,elapsedSeconds:3615,lastRequestSeconds:15,activeSeconds:15,
      lastRequestActiveSeconds:15,hasNewInformation:false,state:'paused' as const};
    expect(decideTrigger(c).blockReason).toBe('runtime_ineligible');
  });
  it('keeps ordinary periodic checks available after one overdue reservation',()=>{
    const c={...base,elapsedSeconds:315,lastRequestSeconds:15,remainingSeconds:0,
      activeSeconds:315,lastRequestActiveSeconds:15,hasNewInformation:false,
      overdueAlreadyChecked:true};
    expect(decideTrigger(c)).toMatchObject({reason:'periodic',blockReason:null});
  });
});
