import {createHash} from 'node:crypto';
import {z} from 'zod';

const seconds=z.number().finite().min(0).max(31_536_000);
const ref=z.string().regex(/^[a-z]+_[a-f0-9]{32}$/u);
export const progressEstimateSchema=z.object({remainingSeconds:seconds,errorPercent:z.number().finite().min(0).max(1000)}).strict();
const prediction=progressEstimateSchema.extend({observedActiveSeconds:seconds});
export const nextMilestoneSchema=z.object({
  definition:z.string().trim().min(1).max(512),
  completionCriterion:z.enum(['operation_end','semantic']),
  criterion:z.string().trim().min(1).max(512),
  operationRef:ref.nullable(),estimate:progressEstimateSchema.nullable(),
}).strict();
export const progressReviewSchema=z.object({
  milestoneId:ref.nullable(),assessment:z.enum(['in_progress','inferred_complete','unknown']),
  evidenceRefs:z.array(ref).max(8),changedAssumptions:z.array(z.string().min(1).max(256)).max(4),
}).strict();
const operationSchema=z.object({operationRef:ref,evidenceRef:ref,state:z.enum(['running','ended']),description:z.string().max(512)}).strict();
const milestoneOutcomeSchema=z.object({milestoneId:ref,operationRef:ref,evidenceRef:ref,
  prediction:prediction.nullable(),sourceStartedAtMs:z.number().int().nonnegative(),sourceEndedAtMs:z.number().int().nonnegative(),
  operationWallSeconds:seconds,actualRemainingActiveSeconds:seconds.nullable(),
  limitation:z.enum(['active_clock_mapping_unavailable','current_runtime_segment'])}).strict().refine(v=>
    (v.limitation==='active_clock_mapping_unavailable')===(v.actualRemainingActiveSeconds===null)&&v.sourceEndedAtMs>=v.sourceStartedAtMs&&
    Math.abs(v.operationWallSeconds-(v.sourceEndedAtMs-v.sourceStartedAtMs)/1000)<0.000001);
export const progressStateSchema=z.object({
  version:z.literal(1),scope:ref,revision:z.number().int().nonnegative(),observedEventSequence:z.number().int().nonnegative(),
  milestone:z.object({id:ref,definition:z.string().max(512),completionCriterion:z.enum(['operation_end','semantic']),criterion:z.string().max(512),operationRef:ref.nullable(),
    prediction:prediction.nullable(),trackingStartedActiveSeconds:seconds,
    judgment:z.enum(['in_progress','observed_complete','inferred_complete','unknown']),evidenceRefs:z.array(ref).max(8),
  }).strict().nullable(),
  previousTurnEstimate:prediction.nullable(),review:progressReviewSchema.nullable(),operations:z.array(operationSchema).max(32),
  lastObservedMilestone:milestoneOutcomeSchema.optional(),
  reviewApplication:z.object({revision:z.number().int().nonnegative(),outcome:z.enum(['applied','not_provided','milestone_mismatch','evidence_not_in_scope'])}).strict().optional(),
}).strict();
export type ProgressState=z.infer<typeof progressStateSchema>;
export type NextMilestone=z.infer<typeof nextMilestoneSchema>;
export type ProgressReview=z.infer<typeof progressReviewSchema>;
export const milestoneTelemetrySchema=z.object({id:ref,judgment:z.enum(['in_progress','observed_complete','inferred_complete','unknown']),prediction:prediction.nullable()}).strict();
type Message={kind:string;text:string;scope?:string|undefined;event?:{ordinal:number;kind:string;atMs:number;pairOrdinal?:number|undefined;counterpartMissing?:boolean|undefined}|undefined};
const digest=(prefix:string,value:unknown)=>`${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32)}`;
export const progressScope=(session:string,turn:string,epoch:number|null,generation:number)=>digest('scope',[session,turn,epoch,generation]);
export function createProgressState(scope:string):ProgressState {
  return {version:1,scope,revision:0,observedEventSequence:0,milestone:null,previousTurnEstimate:null,review:null,operations:[]};
}
/** Only locally paired source events can confirm operation_end; assistant prose never does. */
export function observeProgress(state:ProgressState,messages:readonly Message[],activeAt?:(atMs:number)=>number|null):boolean {
  const starts=new Map(messages.filter(m=>m.scope!=='background'&&m.event?.kind==='tool_start'&&m.event.pairOrdinal!==undefined).map(m=>[m.event!.pairOrdinal,m]));
  let changed=false;
  for(const message of messages){
    const event=message.event;if(!event||message.scope==='background'||(event.kind==='tool_result'&&event.counterpartMissing))continue;
    const start=event.kind==='tool_start'?message:event.kind==='tool_result'&&event.pairOrdinal!==undefined?starts.get(event.pairOrdinal):undefined;
    if(!start?.event)continue;
    // Include source scope, timestamp and content: an ordinal alone is not a durable identity.
    const operationRef=digest('op',[state.scope,start.event.atMs,start.event.ordinal,start.text]);
    const evidenceRef=digest('ev',[operationRef,event.kind,event.atMs,event.ordinal,message.text]);
    const old=state.operations.find(o=>o.operationRef===operationRef);
    if(old&&!old.description)old.description=start.text.slice(0,512);
    const status=event.kind==='tool_result'?'ended':'running';
    if(old?.state==='ended'||old?.state===status)continue;
    const operation={operationRef,evidenceRef,state:status as 'running'|'ended',description:start.text.slice(0,512)};
    if(old)Object.assign(old,operation);else state.operations.push(operation);
    const milestone=state.milestone;
    if(status==='ended'&&milestone?.completionCriterion==='operation_end'&&milestone.operationRef===operationRef&&milestone.judgment!=='observed_complete'){
      milestone.judgment='observed_complete';milestone.evidenceRefs=[evidenceRef];state.observedEventSequence++;changed=true;
      const completedActive=activeAt?.(event.atMs)??null;
      const anchor=milestone.prediction?.observedActiveSeconds;
      const actual=completedActive!==null&&Number.isFinite(completedActive)&&anchor!==undefined&&completedActive>=anchor
        ?completedActive-anchor:null;
      const outcome=milestoneOutcomeSchema.safeParse({milestoneId:milestone.id,operationRef,evidenceRef,
        prediction:milestone.prediction?{...milestone.prediction}:null,sourceStartedAtMs:start.event.atMs,
        sourceEndedAtMs:event.atMs,operationWallSeconds:(event.atMs-start.event.atMs)/1000,
        actualRemainingActiveSeconds:actual,limitation:actual===null?'active_clock_mapping_unavailable':'current_runtime_segment'});
      // Persist across the next milestone, but never convert a wall duration
      // into remaining active time at the earlier forecast anchor.
      if(outcome.success)state.lastObservedMilestone=outcome.data;
    }
  }
  if(state.operations.length>32)state.operations.splice(0,state.operations.length-32);
  return changed;
}
/** Invalid semantic additions are isolated from the independently valid turn estimate. */
export function applyProgress(state:ProgressState,next:NextMilestone|null|undefined,review:ProgressReview|null|undefined,
  turnEstimate:z.infer<typeof progressEstimateSchema>|null,anchor:number):string|null {
  state.revision++;
  if(turnEstimate)state.previousTurnEstimate={...turnEstimate,observedActiveSeconds:anchor};
  let reviewError:string|null=null;
  state.reviewApplication={revision:state.revision,outcome:'not_provided'};
  if(review){
    const outcome=!state.milestone||review.milestoneId!==state.milestone.id?'milestone_mismatch':
      review.evidenceRefs.some(r=>!state.operations.some(o=>o.evidenceRef===r))?'evidence_not_in_scope':'applied';
    state.reviewApplication={revision:state.revision,outcome};
    const valid=outcome==='applied';
    if(!valid)reviewError=`progress_review_${outcome}`;
    if(valid){state.review=structuredClone(review);if(state.milestone&&state.milestone.judgment!=='observed_complete'){
      state.milestone.judgment=review.assessment;state.milestone.evidenceRefs=[...review.evidenceRefs];
    }}
  }
  if(next===undefined)return reviewError; // Legacy response keeps state; explicit null hides the subline.
  if(next===null){state.milestone=null;return reviewError;}
  if((next.completionCriterion==='operation_end'&&(!next.operationRef||!state.operations.some(o=>o.operationRef===next.operationRef&&o.state==='running')))||
     (next.estimate&&turnEstimate&&next.estimate.remainingSeconds>turnEstimate.remainingSeconds))return 'invalid_milestone';
  const same=state.milestone&&state.milestone.definition===next.definition&&state.milestone.criterion===next.criterion&&
    state.milestone.operationRef===next.operationRef&&state.milestone.completionCriterion===next.completionCriterion&&
    !['observed_complete','inferred_complete'].includes(state.milestone.judgment);
  state.milestone={id:same?state.milestone!.id:digest('ms',[state.scope,state.revision,next]),
    definition:next.definition,criterion:next.criterion,completionCriterion:next.completionCriterion,operationRef:next.operationRef,
    prediction:next.estimate?{...next.estimate,observedActiveSeconds:anchor}:null,
    trackingStartedActiveSeconds:same?state.milestone!.trackingStartedActiveSeconds:anchor,
    judgment:'in_progress',evidenceRefs:[]};
  return reviewError;
}
