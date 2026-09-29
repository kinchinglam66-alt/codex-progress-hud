import {progressStateSchema} from './progress-state.js';
import {pendingMilestoneSchema} from './pending-milestone.js';

const object=(value:unknown):Record<string,unknown>|undefined=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

/** Per-request provider constraint, not evidence of semantic correctness.
 * Never mutate the shared schema or carry references into another request.
 * Local applyProgress validation remains mandatory even with strict output.
 */
export function bindProgressReviewOutputSchema(schema:unknown,input:unknown):unknown {
  const copy=structuredClone(schema),properties=object(object(copy)?.properties);
  const review=object(properties?.progressReview),fields=object(review?.properties);
  // Custom/minimal schemas without this protocol retain their existing shape.
  if(!properties||!review||!fields)return copy;
  const raw=object(input)?.progressState;
  const state=raw===undefined?undefined:progressStateSchema.parse(raw);
  const pendingRaw=object(input)?.pendingMilestone;
  const pending=pendingRaw===undefined?undefined:pendingMilestoneSchema.parse(pendingRaw);
  const pendingReview=object(properties.pendingMilestoneReview),pendingFields=object(pendingReview?.properties);
  if(pendingReview&&pendingFields){
    if(!pending||!state||pending.scope!==state.scope){
      properties.pendingMilestoneReview={type:'null',description:'No in-scope historical candidate to review.'};
    }else{
      pendingReview.type='object';
      pendingFields.candidateId={type:'string',enum:[pending.id]};
      const refs=[...new Set(state.operations.map(o=>o.evidenceRef))];
      pendingFields.evidenceRefs={type:'array',maxItems:refs.length?8:0,items:refs.length?{type:'string',enum:refs}:{type:'string'}};
    }
  }
  if(!state?.milestone){
    properties.progressReview={type:'null',description:'No current milestone is available to review.'};
    return copy;
  }
  // A milestone-triggered ETA is only useful as a review opportunity if the
  // provider actually returns a review. The model can still say "unknown" and
  // cite no evidence; requiring the object does not assert completion.
  review.type='object';
  fields.milestoneId={type:'string',enum:[state.milestone.id]};
  const evidence=object(fields.evidenceRefs);
  if(!evidence)throw Error('PROGRESS_REVIEW_SCHEMA_INVALID');
  const refs=[...new Set(state.operations.map(o=>o.evidenceRef))];
  // Empty enum is invalid JSON Schema. An empty allowed set permits only [].
  fields.evidenceRefs={...evidence,...(refs.length?{
    items:{type:'string',enum:refs},
  }:{items:{type:'string'},maxItems:0})};
  return copy;
}
