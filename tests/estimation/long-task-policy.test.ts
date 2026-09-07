import {describe,it,expect} from 'vitest';
import {canRequest,decideTrigger,type RequestContext} from '../../src/estimation/long-task-policy.js';

const base:RequestContext={elapsedSeconds:15,lastRequestSeconds:null,remainingSeconds:1800,
  unknownResults:0,eventAtSeconds:null,contentReady:true,hasNewInformation:true,
  state:'running',statusEvidenceArrived:false,goalInFlight:false,globalInFlight:0,
  conversationStartsLastHour:0};
describe('long-task request eligibility (not spend authorization)',()=>{
  it('keeps hard timing, runtime and resource gates on a pre-dispatch retry',()=>{
    const retry={...base,preDispatchRetry:true,hasNewInformation:false,lastRequestSeconds:15,elapsedSeconds:75};
    expect(canRequest(retry)).toBe(true);
    expect(canRequest({...retry,elapsedSeconds:74})).toBe(false);
    expect(canRequest({...retry,globalInFlight:2})).toBe(false);
    expect(canRequest({...retry,conversationStartsLastHour:12})).toBe(false);
    expect(canRequest({...retry,state:'paused'})).toBe(false);
    expect(canRequest({...retry,state:'terminal'})).toBe(false);
    expect(canRequest({...retry,contentReady:false})).toBe(false);
  });
  it('waits for first observation and fifteen seconds',()=>{
    expect(canRequest({...base,elapsedSeconds:14})).toBe(false);
    expect(canRequest({...base,contentReady:false})).toBe(false);
    expect(canRequest(base)).toBe(true);
  });
  it.each([[1800,300],[1801,600],[7200,600],[7201,900],[28800,900],[28801,1800]])(
    'checks remaining %s at interval %s', (remainingSeconds,delay)=>{
      expect(canRequest({...base,remainingSeconds,lastRequestSeconds:15,elapsedSeconds:15+delay-1})).toBe(false);
      expect(canRequest({...base,remainingSeconds,lastRequestSeconds:15,elapsedSeconds:15+delay})).toBe(true);
    });
  it.each([[1,300],[2,600],[3,1800],[8,1800]])('backs off after %s unknown results',(unknownResults,delay)=>{
    const c={...base,remainingSeconds:null,unknownResults,lastRequestSeconds:15};
    expect(canRequest({...c,elapsedSeconds:15+delay-1})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:15+delay})).toBe(true);
  });
  it('coalesces events without bypassing cooldown',()=>{
    const c={...base,lastRequestSeconds:15,remainingSeconds:50000,eventAtSeconds:70};
    expect(canRequest({...c,elapsedSeconds:79})).toBe(false);
    expect(canRequest({...c,elapsedSeconds:80})).toBe(true);
    expect(canRequest({...c,eventAtSeconds:20,elapsedSeconds:74})).toBe(false);
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
    expect(canRequest({...c,elapsedSeconds:74})).toBe(false);
    expect(canRequest({...c,conversationStartsLastHour:12})).toBe(false);
    expect(canRequest({...c,globalInFlight:2})).toBe(false);
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
  it('applies conversation and in-flight limits even for a fresh goal',()=>{
    expect(canRequest({...base,goalInFlight:true})).toBe(false);
    expect(canRequest({...base,globalInFlight:2})).toBe(false);
    expect(canRequest({...base,conversationStartsLastHour:12})).toBe(false);
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
    const c={...base,elapsedSeconds:314,lastRequestSeconds:15,activeSeconds:314,
      lastRequestActiveSeconds:15,hasNewInformation:false};
    expect(decideTrigger(c)).toMatchObject({reason:null,blockReason:'adaptive_interval',
      eligibleActiveSeconds:315});
    expect(decideTrigger({...c,activeSeconds:315})).toMatchObject({reason:'periodic',
      blockReason:null,eligibleActiveSeconds:315});
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
