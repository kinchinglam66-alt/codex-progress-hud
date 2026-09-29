/** Prediction endpoint is separate from the elapsed-time accounting basis. */
export const TASK_OBJECTIVE_TARGET = 'current-turn-task-objective-v1' as const;
export const taskObjectiveInstructions = `Task objective protocol v1: ONLY when currentObservation.predictionTarget is current-turn-task-objective-v1, the ETA endpoint is achievement of the current turn's agreed task objective and applicable verification/delivery, NOT the next approval, question, blocker report, or merely any final reply. This endpoint overrides legacy turn-end instructions; timeBasis still specifies elapsed-time accounting. Preserve all unresolved requirements of this turn; never shrink 100 requested repairs to 50 because execution stopped. Never forecast hypothetical future scope. If achievement duration is not defensible, return null estimate. For this target estimateConditions.continueWork refers to objective achievement, while reportBlocker is diagnostic only: never select report_blocker for a numeric top-level estimate. Approval requests are an independent attention signal: while relevant work continues, status remains running and elapsed time continues. Deduct only confirmed full user-caused blocks. Neither elapsed time, a model claim, a tool ending nor native turn completion proves objective achievement. The host alone controls product lifecycle status: normal native end defaults to completed when achievement evidence is insufficient. That display convention is not verified achievement or an accuracy-scoring certificate; never infer success from it or control lifecycle with your response. Interruption, cancellation and failure are not successful achievement. Do not execute tools or seek additional calls.`;
export type ObjectiveState = 'ongoing'|'completed'|'interrupted'|'unverified';
export interface ObjectiveEvidence {
  targetId:string;
  verdict:'achieved'|'not_achieved';
  evidenceRefs:readonly string[];
}
export interface AttentionEvidence {
  required:boolean;
  evidenceRef:string;
  relevantWorkRunning:boolean|undefined;
}
/** Product status, not an accuracy-scoring certificate. Only trusted adapters
 * supply evidence; estimator replies never override native execution state.
 * Normal end defaults to completed even when achievement cannot be verified.
 * The legacy unverified type remains readable for older snapshots only. */
export function objectiveState(targetId:string,outcome:'completed'|'interrupted'|'failed'|undefined,
  evidence?:ObjectiveEvidence):ObjectiveState {
  if(!outcome)return 'ongoing';
  // Conflicting achievement claims must never turn failed/interrupted execution
  // into successful completion. Preserve interruption for review.
  if(outcome==='interrupted'||outcome==='failed')return 'interrupted';
  const verified=evidence?.targetId===targetId&&evidence.evidenceRefs.length>0&&
    evidence.evidenceRefs.every(ref=>typeof ref==='string'&&ref.trim().length>0);
  if(verified&&evidence.verdict==='achieved')return 'completed';
  if(verified&&evidence.verdict==='not_achieved')return 'interrupted';
  return 'completed';
}
