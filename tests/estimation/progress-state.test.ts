import {expect,it} from 'vitest';
import {applyProgress,createProgressState,observeProgress,progressScope,progressStateSchema} from '../../src/estimation/progress-state.js';
import {observerInputSchema,observerResponseSchema} from '../../src/estimation/observer-contract.js';
import {decideTrigger,type RequestContext} from '../../src/estimation/long-task-policy.js';
const state=()=>createProgressState(progressScope('a','turn',1,0));
const start={kind:'tool',text:'test run',event:{ordinal:7,kind:'tool_start',atMs:1000,pairOrdinal:0,counterpartMissing:true}};
const end={kind:'tool',text:'tests failed',event:{ordinal:9,kind:'tool_result',atMs:3000,pairOrdinal:0}};
const semantic={definition:'完成针对性测试',completionCriterion:'semantic' as const,criterion:'测试结果已分析',operationRef:null,estimate:{remainingSeconds:100,errorPercent:50}};
const total={remainingSeconds:300,errorPercent:50};
it.each(['te_'+'a'.repeat(32),'ev_'+'b'.repeat(32)])('diagnoses wrong evidence %s without discarding numeric ETA',evidence=>{
 const s=state();applyProgress(s,semantic,null,total,10);
 expect(applyProgress(s,undefined,{milestoneId:s.milestone!.id,assessment:'inferred_complete',evidenceRefs:[evidence],changedAssumptions:[]},total,20)).toBe('progress_review_evidence_not_in_scope');
 expect(s.reviewApplication).toEqual({revision:2,outcome:'evidence_not_in_scope'});
 expect(s.review).toBeNull();expect(s.milestone!.judgment).toBe('in_progress');
 expect(s.previousTurnEstimate).toEqual({...total,observedActiveSeconds:20});
 expect(progressStateSchema.parse(s).reviewApplication).toEqual(s.reviewApplication);
});
it('accepts exact current operation evidence and resets diagnostic for absent reviews',()=>{
 const s=state();observeProgress(s,[start]);applyProgress(s,semantic,null,total,10);
 const review={milestoneId:s.milestone!.id,assessment:'inferred_complete' as const,evidenceRefs:[s.operations[0]!.evidenceRef],changedAssumptions:[]};
 expect(applyProgress(s,undefined,review,total,20)).toBeNull();
 expect(s.reviewApplication?.outcome).toBe('applied');expect(s.review).toEqual(review);
 applyProgress(s,undefined,null,total,30);expect(s.reviewApplication?.outcome).toBe('not_provided');
 applyProgress(s,undefined,undefined,total,40);expect(s.reviewApplication?.outcome).toBe('not_provided');
});
it('does not let an accepted model review undo observed completion',()=>{
 const s=state();observeProgress(s,[start]);
 applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:s.operations[0]!.operationRef},null,total,10);
 observeProgress(s,[start,end]);
 applyProgress(s,undefined,{milestoneId:s.milestone!.id,assessment:'unknown',evidenceRefs:[s.operations[0]!.evidenceRef],changedAssumptions:[]},total,20);
 expect(s.reviewApplication?.outcome).toBe('applied');
 expect(s.milestone?.judgment).toBe('observed_complete');
});
it.each(['other-task','other-turn'])('rejects cross-scope operation evidence (%s)',key=>{
 const s=state(),other=createProgressState(progressScope(key,key,1,0));
 observeProgress(s,[start]);observeProgress(other,[start]);applyProgress(s,semantic,null,total,10);
 applyProgress(s,undefined,{milestoneId:s.milestone!.id,assessment:'inferred_complete',evidenceRefs:[other.operations[0]!.evidenceRef],changedAssumptions:[]},total,20);
 expect(s.reviewApplication?.outcome).toBe('evidence_not_in_scope');expect(s.review).toBeNull();
});
it('rejects stale milestone even with valid evidence; still accepts independent next milestone',()=>{
 const s=state();observeProgress(s,[start]);applyProgress(s,semantic,null,total,10);const old=s.milestone!.id;
 applyProgress(s,{...semantic,definition:'new stage'},null,total,20);
 expect(applyProgress(s,semantic,{milestoneId:old,assessment:'inferred_complete',evidenceRefs:[s.operations[0]!.evidenceRef],changedAssumptions:[]},total,30)).toBe('progress_review_milestone_mismatch');
 expect(s.reviewApplication?.outcome).toBe('milestone_mismatch');expect(s.milestone!.definition).toBe(semantic.definition);
});
it.each([null,9,Number.NaN,25])('compares milestone prediction only with a valid active-clock mapping: %s',mapped=>{
 const s=state();observeProgress(s,[start]);
 applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:s.operations[0]!.operationRef},null,total,10);
 observeProgress(s,[start,end],()=>mapped);
 expect(s.lastObservedMilestone?.actualRemainingActiveSeconds).toBe(mapped===25?15:null);
 expect(s.lastObservedMilestone?.forecastErrorSeconds).toBe(mapped===25?85:null);
 expect(s.lastObservedMilestone?.limitation).toBe(mapped===25?'current_runtime_segment':'active_clock_mapping_unavailable');
});
it('retains a signed miss instead of turning an overrun into a zero or a wall-clock comparison',()=>{
 const s=state();observeProgress(s,[start]);
 applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:s.operations[0]!.operationRef},null,total,10);
 observeProgress(s,[start,end],()=>145);
 expect(s.lastObservedMilestone?.actualRemainingActiveSeconds).toBe(135);
 expect(s.lastObservedMilestone?.forecastErrorSeconds).toBe(-35);
 expect(s.lastObservedMilestone?.operationWallSeconds).toBe(2);
 expect(progressStateSchema.safeParse({...s,lastObservedMilestone:{...s.lastObservedMilestone,forecastErrorSeconds:2}}).success).toBe(false);
});
it('retains observed operation duration and previous prediction without fabricating active remaining time',()=>{
 const s=state();observeProgress(s,[start]);
 applyProgress(s,{...semantic,completionCriterion:'operation_end',operationRef:s.operations[0]!.operationRef},null,total,10);
 observeProgress(s,[start,end]);
 expect(s.lastObservedMilestone).toMatchObject({operationWallSeconds:2,actualRemainingActiveSeconds:null,
  forecastErrorSeconds:null,prediction:{remainingSeconds:100,observedActiveSeconds:10},limitation:'active_clock_mapping_unavailable'});
 const previous=structuredClone(s.lastObservedMilestone);
 applyProgress(s,semantic,null,total,20);
 expect(s.lastObservedMilestone).toEqual(previous);
 expect(progressStateSchema.safeParse(s).success).toBe(true);
});
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
 expect(s.pairedResultSequence).toBe(1);
});
it('counts a paired result for semantic review without inventing milestone completion',()=>{
 const s=state();applyProgress(s,semantic,null,total,10);
 observeProgress(s,[start,end]);
 expect(s.pairedResultSequence).toBe(1);
 expect(s.observedEventSequence).toBe(0);
 expect(s.milestone?.judgment).toBe('in_progress');
 observeProgress(s,[start,end]);expect(s.pairedResultSequence).toBe(1);
 expect(s.milestoneApplication?.outcome).toBe('accepted');
});
it('does not recount evicted operations when a long native prefix is scanned again',()=>{
 const s=state();applyProgress(s,semantic,null,total,10);
 const messages=Array.from({length:41},(_,i)=>[
  {kind:'tool',text:`command ${i}`,event:{kind:'tool_start',ordinal:i*2,pairOrdinal:i,atMs:i*2000}},
  {kind:'tool',text:`result ${i}`,event:{kind:'tool_result',ordinal:i*2+1,pairOrdinal:i,atMs:i*2000+1000}},
 ]).flat();
 observeProgress(s,messages.slice(0,80));expect(s.pairedResultSequence).toBe(40);
 observeProgress(s,messages.slice(0,80));expect(s.pairedResultSequence).toBe(40);
 observeProgress(s,messages);expect(s.pairedResultSequence).toBe(41);
 expect(s.operations).toHaveLength(32);
});
it('seeds legacy checkpoints without inventing a new result event',()=>{
 const s=state();delete s.pairedResultOrdinal;delete s.pairedResultSequence;
 observeProgress(s,[start,end]);expect(s.pairedResultSequence).toBeUndefined();
 expect(s.pairedResultOrdinal).toBe(9);
 observeProgress(s,[start,end]);expect(s.pairedResultSequence).toBeUndefined();
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
 expect(s.lastObservedMilestone).toBeUndefined();
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
 expect(s.milestoneApplication?.outcome).toBe('inconsistent_estimate');
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
it.each([[600,180],[601,180],[1800,180],[1801,180],[null,180]])('keeps fallback interval %s independent of milestone countdown (%s seconds)',(remaining,interval)=>{
 expect(decideTrigger({...context,milestoneRemainingSeconds:remaining,activeSeconds:interval-1}).blockReason).toBe('adaptive_interval');
 expect(decideTrigger({...context,milestoneRemainingSeconds:remaining,activeSeconds:interval}).reason).toBe('periodic');
});
it('retains real backoff for critical events and excludes paused time',()=>{
 expect(decideTrigger({...context,eventSequence:2,consumedEventSequence:1,eventReason:'important_event',eventAtSeconds:290,retryBackoff:true}).blockReason).toBe('retry_backoff');
 expect(decideTrigger({...context,activeSeconds:0,state:'paused'}).blockReason).toBe('runtime_ineligible');
 expect(decideTrigger({...context,activeSeconds:0}).blockReason).toBe('no_active_progress');
});
