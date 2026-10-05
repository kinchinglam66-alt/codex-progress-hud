import {z} from 'zod';
import type {ObserverResponse} from './observer-contract.js';

const pathSchema=z.enum(['continue_work','report_blocker','unknown']);
const estimateSchema=z.object({remainingSeconds:z.number().finite().min(0).max(31_536_000),
  errorPercent:z.number().finite().min(0).max(1000)}).strict();
/** All estimates share the current observation's time anchor. Alternatives are never summed. */
export const estimateConditionsSchema=z.object({selectedPath:pathSchema,
  continueWork:estimateSchema.nullable(),reportBlocker:estimateSchema.nullable(),milestonePath:pathSchema}).strict();
export const estimateConditionAssessmentSchema=z.object({selectedPath:pathSchema,displayPath:pathSchema,
  issue:z.enum(['consistent','conditional','missing_conditions','unknown_path','missing_branch','estimate_mismatch',
    'outlook_mismatch','milestone_mismatch','milestone_exceeds_turn'])}).strict();
export type EstimateConditionAssessment=z.infer<typeof estimateConditionAssessmentSchema>;

export const estimateConditionsInstructions = `ETA conditions protocol v1: In the SAME response return estimateConditions with selectedPath (continue_work, report_blocker, unknown), continueWork and reportBlocker (each a full-turn estimate or null), and milestonePath. These are alternative scenarios, not consecutive phases: never add or average them. continue_work means the turn continues investigation, implementation, validation and reporting, NOT guaranteed success or only the next tool. report_blocker means the turn stops with a blocker report; a tool error alone does not establish that route. For an identified running task, provide a best-effort estimate for its selected scenario; unsupported alternative scenarios may remain null. If selecting a known path, top-level estimate must exactly equal that scenario's remainingSeconds AND errorPercent. If keeping a rough numeric estimate without a defensible path, use selectedPath unknown; it will be displayed as condition unknown, not an unconditional promise. Associate nextMilestone with milestonePath; a same-path milestone must not exceed the full-turn estimate. With no milestone use milestonePath unknown. completionOutlook describes which ending is expected; selectedPath describes the condition on the number and is NOT a claim that this path will occur. With uncertain outlook you may retain a conditional estimate. Do not imply tool recovery finishes the whole task. Preserve native lifecycle authority and never change runtime, retry, or invoke another model to repair this output.`;

/** Semantic consistency only, not validation of prediction accuracy or a change to its value. */
export function assessEstimateCondition(response:ObserverResponse):EstimateConditionAssessment|undefined {
  if(response.estimate===null)return;
  const c=response.estimateConditions;
  const selectedPath=c?.selectedPath??'unknown';
  const fail=(issue:EstimateConditionAssessment['issue']):EstimateConditionAssessment=>({selectedPath,displayPath:'unknown',issue});
  if(!c)return fail('missing_conditions');
  if(c.selectedPath==='unknown')return fail('unknown_path');
  const branch=c.selectedPath==='continue_work'?c.continueWork:c.reportBlocker;
  if(!branch)return fail('missing_branch');
  if(branch.remainingSeconds!==response.estimate.remainingSeconds||branch.errorPercent!==response.estimate.errorPercent)return fail('estimate_mismatch');
  const outlook=response.completionOutlook?.path;
  if(outlook&&outlook!=='uncertain'&&(outlook==='deliver_result'?'continue_work':'report_blocker')!==c.selectedPath)return fail('outlook_mismatch');
  if(response.nextMilestone){
    if(c.milestonePath!==c.selectedPath)return fail('milestone_mismatch');
    if(response.nextMilestone.estimate&&response.nextMilestone.estimate.remainingSeconds>response.estimate.remainingSeconds)return fail('milestone_exceeds_turn');
  }
  return {selectedPath,displayPath:selectedPath,issue:!outlook||outlook==='uncertain'||response.basis==='insufficient_context'?'conditional':'consistent'};
}
