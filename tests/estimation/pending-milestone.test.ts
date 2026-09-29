import {it,expect} from 'vitest';
import {createProgressState,type NextMilestone} from '../../src/estimation/progress-state.js';
import {retainPendingMilestone,reviewPendingMilestone,pendingMilestoneSchema} from '../../src/estimation/pending-milestone.js';
const scope='scope_'+'a'.repeat(32),op='op_'+'b'.repeat(32),ev='ev_'+'c'.repeat(32);
const next:NextMilestone={definition:'tests finish',criterion:'paired result',completionCriterion:'operation_end',operationRef:op,estimate:{remainingSeconds:40,errorPercent:50}};
const state=()=>({...createProgressState(scope),operations:[{operationRef:op,evidenceRef:ev,state:'running' as const,description:'test'}]});
it('retains a bounded clone at the original prediction anchor without making it active',()=>{
 const input=structuredClone(next),s=state();const pending=retainPendingMilestone(input,s,10,2,null,100)!;
 expect(pendingMilestoneSchema.safeParse(pending).success).toBe(true);
 input.definition='changed';expect(pending.forecast.definition).toBe('tests finish');
 expect(pending.observedActiveSeconds).toBe(10);expect(s.milestone).toBeNull();expect(s.observedEventSequence).toBe(0);
 expect(retainPendingMilestone(next,s,10,2,null,100)).toEqual(pending);
});
it('declines invalid operation, missing boundary and inconsistent numeric forecasts',()=>{
 expect(retainPendingMilestone(next,createProgressState(scope),10,2,null,100)).toBeNull();
 expect(retainPendingMilestone(next,state(),10,undefined,null,100)).toBeNull();
 expect(retainPendingMilestone(next,state(),10,2,null,20)).toBeNull();
 expect(retainPendingMilestone(next,state(),NaN,2,null,100)).toBeNull();
});
it('accepts unknown without evidence but not a claimed completion without a matching ended operation',()=>{
 const s=state(),p=retainPendingMilestone(next,s,10,2,null,100)!;
 expect(reviewPendingMilestone(p,{candidateId:p.id,assessment:'unknown',evidenceRefs:[]},s)).toBe('reviewed');
 expect(reviewPendingMilestone(p,{candidateId:p.id,assessment:'inferred_complete',evidenceRefs:[ev]},s)).toBe('insufficient_evidence');
 const ended={...s,operations:s.operations.map(o=>({...o,state:'ended' as const}))};
 expect(reviewPendingMilestone(p,{candidateId:p.id,assessment:'inferred_complete',evidenceRefs:[ev]},ended)).toBe('reviewed');
 expect(reviewPendingMilestone(p,{candidateId:p.id,assessment:'in_progress',evidenceRefs:[ev]},ended)).toBe('insufficient_evidence');
 expect(ended.milestone).toBeNull();
});
it('rejects cross-scope ids and evidence unavailable at the request snapshot',()=>{
 const s=state(),p=retainPendingMilestone(next,s,10,2,null,100)!;
 const review={candidateId:p.id,assessment:'inferred_complete' as const,evidenceRefs:['ev_'+'d'.repeat(32)]};
 expect(reviewPendingMilestone(p,review,s)).toBe('evidence_not_in_snapshot');
 expect(reviewPendingMilestone(p,review,{...s,scope:'scope_'+'f'.repeat(32)})).toBe('candidate_mismatch');
 expect(reviewPendingMilestone(undefined,review,s)).toBe('candidate_mismatch');
 expect(reviewPendingMilestone(p,null,s)).toBe('not_provided');
});
