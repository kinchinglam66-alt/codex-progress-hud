import {progressStateSchema} from './progress-state.js';

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
  if(!state?.milestone){
    properties.progressReview={type:'null',description:'No current milestone is available to review.'};
    return copy;
  }
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
