import {expect,it} from 'vitest';
import {applyProgress,createProgressState,observeProgress,progressScope,progressStateSchema} from '../../src/estimation/progress-state.js';
import {observerInputSchema,observerResponseSchema} from '../../src/estimation/observer-contract.js';
import {decideTrigger,type RequestContext} from '../../src/estimation/long-task-policy.js';
const state=()=>createProgressState(progressScope('a','turn',1,0));
const start={kind:'tool',text:'test run',event:{ordinal:7,kind:'tool_start',atMs:1000,pairOrdinal:0,counterpartMissing:true}};
const end={kind:'tool',text:'tests failed',event:{ordinal:9,kind:'tool_result',atMs:3000,pairOrdinal:0}};
const semantic={definition:'完成针对性测试',completionCriterion:'semantic' as const,criterion:'测试结果已分析',operationRef:null,estimate:{remainingSeconds:100,errorPercent:50}};
const total={remainingSeconds:300,errorPercent:50};
it('keeps explicit cross-call state and a common snapshot anchor',()=>{
 const s=state();expect(applyProgress(s,semantic,null,total,10)).toBeNull();
 expect(s.milestone?.prediction?.observedActiveSeconds).toBe(10);expect(s.previousTurnEstimate?.observedActiveSeconds).toBe(10);
 expect(progressStateSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
 const id=s.milestone!.id;applyProgress(s,semantic,{milestoneId:id,assessment:'in_progress',evidenceRefs:[],changedAssumptions:['测试仍在运行']},total,40);
 expect(s.milestone?.id).toBe(id);expect(s.milestone?.trackingStartedActiveSeconds).toBe(10);expect(s.review?.changedAssumptions).toHaveLength(1);
});
it('binds a running operation with missing future counterpart and confirms its end, not success',()=>{
 const s=state();observeProgress(s,[start]);expect(s.operations).toHaveLength(1);
 applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:s.operations[0]!.operationRef},null,total,10);
 expect(observeProgress(s,[start,end])).toBe(true);expect(s.milestone?.judgment).toBe('observed_complete');
 expect(s.observedEventSequence).toBe(1);expect(observeProgress(s,[end,start,end])).toBe(false);expect(s.observedEventSequence).toBe(1);
});
it('never confirms a milestone from assistant prose or missing result pairing',()=>{
 const s=state();observeProgress(s,[start]);applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:s.operations[0]!.operationRef},null,total,10);
 expect(observeProgress(s,[{kind:'assistant',text:'Done'}, {...end,event:{...end.event,counterpartMissing:true}}])).toBe(false);
 expect(s.milestone?.judgment).toBe('in_progress');
});
it('does not promote model inference to local evidence or dispatch events',()=>{
 const s=state();applyProgress(s,semantic,null,total,10);
 applyProgress(s,undefined,{milestoneId:s.milestone!.id,assessment:'inferred_complete',evidenceRefs:[],changedAssumptions:[]},total,20);
 expect(s.milestone?.judgment).toBe('inferred_complete');expect(s.observedEventSequence).toBe(0);
});
it.each(['a2','b'])('isolates operation identities by conversation %s',key=>{
 const a=state(),b=createProgressState(progressScope(key,'turn',1,0));observeProgress(a,[start]);observeProgress(b,[start]);
 expect(a.operations[0]!.operationRef).not.toBe(b.operations[0]!.operationRef);
});
it('separates turns and source epochs and does not expose native identities in input',()=>{
 expect(progressScope('secret','turn2',1,0)).not.toBe(progressScope('secret','turn',1,0));
 expect(progressScope('secret','turn',2,0)).not.toBe(progressScope('secret','turn',1,0));
 expect(JSON.stringify(createProgressState(progressScope('secret','turn',1,0)))).not.toContain('secret');
});
it('discards inconsistent milestone without losing valid total',()=>{
 const s=state();expect(applyProgress(s,{...semantic,estimate:{remainingSeconds:400,errorPercent:50}},null,total,10)).toBe('invalid_milestone');
 expect(s.previousTurnEstimate).toEqual({...total,observedActiveSeconds:10});expect(s.milestone).toBeNull();
});
it('rejects unknown operation refs and ignores forged evidence',()=>{
 const s=state();expect(applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:'op_'+'a'.repeat(32)},null,total,10)).toBe('invalid_milestone');
 applyProgress(s,semantic,null,total,10);applyProgress(s,undefined,{milestoneId:s.milestone!.id,assessment:'inferred_complete',evidenceRefs:['ev_'+'b'.repeat(32)],changedAssumptions:[]},total,20);
 expect(s.milestone?.judgment).toBe('in_progress');
});
it('keeps legacy output valid and accepts independently null estimates',()=>{
 const base={relation:'continue',status:'running',summary:'work',estimate:null};
 expect(observerResponseSchema.safeParse(base).success).toBe(true);
 expect(observerResponseSchema.safeParse({...base,nextMilestone:semantic,progressReview:null}).success).toBe(true);
 expect(observerResponseSchema.safeParse({...base,nextMilestone:{...semantic,estimate:null}}).success).toBe(true);
 expect(observerResponseSchema.safeParse({...base,progressReview:{assessment:'observed_complete'}}).success).toBe(false);
 const s=state();applyProgress(s,semantic,null,null,10);expect(s.previousTurnEstimate).toBeNull();expect(s.milestone?.prediction).not.toBeNull();
 expect(observerInputSchema.safeParse({goalSummary:null,activeSeconds:10,runtime:'running',messages:[{kind:'user',text:'work',truncated:false}],truncated:false,progressState:s}).success).toBe(true);
});
it('changes milestone identity on definition change and hides explicit null',()=>{
 const s=state();applyProgress(s,semantic,null,total,10);const id=s.milestone!.id;
 applyProgress(s,{...semantic,definition:'检查集成'},null,total,20);expect(s.milestone!.id).not.toBe(id);
 applyProgress(s,null,null,total,30);expect(s.milestone).toBeNull();
});
const context:RequestContext={elapsedSeconds:300,lastRequestSeconds:0,remainingSeconds:4000,milestoneRemainingSeconds:null,
 unknownResults:0,eventAtSeconds:null,contentReady:true,hasNewInformation:false,activeSeconds:300,lastRequestActiveSeconds:0,
 state:'running',statusEvidenceArrived:false,goalInFlight:false,globalInFlight:99,conversationStartsLastHour:99};
it.each([[600,60],[601,120],[1800,120],[1801,300],[null,300]])('uses shorter milestone %s for active interval %s',(remaining,interval)=>{
 expect(decideTrigger({...context,milestoneRemainingSeconds:remaining,activeSeconds:interval-1}).blockReason).toBe('adaptive_interval');
 expect(decideTrigger({...context,milestoneRemainingSeconds:remaining,activeSeconds:interval}).reason).toBe('periodic');
});
it('retains real backoff for critical events and excludes paused time',()=>{
 expect(decideTrigger({...context,eventSequence:2,consumedEventSequence:1,eventReason:'important_event',eventAtSeconds:290,retryBackoff:true}).blockReason).toBe('retry_backoff');
 expect(decideTrigger({...context,activeSeconds:0,state:'paused'}).blockReason).toBe('runtime_ineligible');
 expect(decideTrigger({...context,activeSeconds:0}).blockReason).toBe('no_active_progress');
});
