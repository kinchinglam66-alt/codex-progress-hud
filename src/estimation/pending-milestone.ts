import {createHash} from 'node:crypto';
import {z} from 'zod';
import {nextMilestoneSchema,type NextMilestone,type ProgressState} from './progress-state.js';

export const pendingMilestoneInstructions='Pending milestone review v1: pendingMilestone is a historical forecast withheld because source progress advanced during inference. It is not the current accepted milestone or a fact. In the SAME ETA response return pendingMilestoneReview for its exact id: in_progress, inferred_complete, superseded, or unknown, using only progressState.operations evidenceRefs available in THIS snapshot. Non-unknown judgments require relevant evidence; operation_end completion needs the matching ended operation. Use unknown with [] when evidence is insufficient. Never use candidate timing, elapsed time, or reaching zero as completion evidence. Review as of this input snapshot, not the later response arrival. Return null when no pending candidate exists. Keep this separate from progressReview of the current accepted milestone and from nextMilestone selection. Neither review changes native completion, pause, interruption or authorization; do not run tools or request extra calls.';

const ref=z.string().regex(/^[a-z]+_[a-f0-9]{32}$/u);
const seconds=z.number().finite().min(0).max(31_536_000);
const ordinal=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Historical forecast only: never a current milestone or a native completion event. */
export const pendingMilestoneSchema=z.object({
  version:z.literal(1),id:z.string().regex(/^pc_[a-f0-9]{32}$/u),scope:ref,
  forecast:nextMilestoneSchema,observedActiveSeconds:seconds,sourceRevision:ordinal,
  evidenceCutoff:ordinal.nullable(),
}).strict();
export const pendingMilestoneReviewSchema=z.object({
  candidateId:z.string().regex(/^pc_[a-f0-9]{32}$/u),
  assessment:z.enum(['in_progress','inferred_complete','superseded','unknown']),
  evidenceRefs:z.array(ref).max(8),
}).strict();
export type PendingMilestone=z.infer<typeof pendingMilestoneSchema>;
export type PendingMilestoneReview=z.infer<typeof pendingMilestoneReviewSchema>;
export type PendingReviewOutcome='reviewed'|'not_provided'|'candidate_mismatch'|'evidence_not_in_snapshot'|'insufficient_evidence';
export const pendingMilestoneTelemetrySchema=z.object({id:z.string().regex(/^pc_[a-f0-9]{32}$/u),
  observedActiveSeconds:seconds,sourceRevision:ordinal,completionCriterion:z.enum(['operation_end','semantic']),
  estimate:z.object({remainingSeconds:seconds,errorPercent:z.number().finite().min(0).max(1000)}).strict().nullable(),
}).strict();
export type PendingMilestoneTelemetry=z.infer<typeof pendingMilestoneTelemetrySchema>;

export function retainPendingMilestone(next:NextMilestone|null|undefined,state:ProgressState,
  observedActiveSeconds:number,sourceRevision:number|undefined,evidenceCutoff:number|null,
  totalRemainingSeconds:number|null):PendingMilestone|null {
  if(!next||sourceRevision===undefined)return null;
  if(next.estimate&&totalRemainingSeconds!==null&&next.estimate.remainingSeconds>totalRemainingSeconds)return null;
  if(next.completionCriterion==='operation_end'&&!state.operations.some(o=>o.operationRef===next.operationRef&&o.state==='running'))return null;
  const body={version:1 as const,scope:state.scope,forecast:structuredClone(next),observedActiveSeconds,sourceRevision,evidenceCutoff};
  const parsed=pendingMilestoneSchema.safeParse({...body,id:'pc_'+createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0,32)});
  return parsed.success?parsed.data:null;
}

/** Only the exact request snapshot may support the historical review, never arrival-time evidence. */
export function reviewPendingMilestone(candidate:PendingMilestone|undefined,review:PendingMilestoneReview|null|undefined,
  snapshot:ProgressState):PendingReviewOutcome {
  if(!review)return 'not_provided';
  if(!candidate||candidate.scope!==snapshot.scope||candidate.id!==review.candidateId)return 'candidate_mismatch';
  if(review.evidenceRefs.some(ref=>!snapshot.operations.some(o=>o.evidenceRef===ref)))return 'evidence_not_in_snapshot';
  if(review.assessment!=='unknown'&&!review.evidenceRefs.length)return 'insufficient_evidence';
  if(candidate.forecast.completionCriterion==='operation_end'&&['inferred_complete','in_progress'].includes(review.assessment)){
    const required=review.assessment==='inferred_complete'?'ended':'running';
    if(!snapshot.operations.some(o=>o.operationRef===candidate.forecast.operationRef&&o.state===required&&review.evidenceRefs.includes(o.evidenceRef)))return 'insufficient_evidence';
  }
  return 'reviewed';
}
