import {z} from 'zod';
import {completionOutlookSchema,turnEvidenceSchema} from './completion-outlook.js';
import {estimateConditionsSchema} from './estimate-conditions.js';
import {nextMilestoneSchema,progressReviewSchema,progressStateSchema} from './progress-state.js';
import {pendingMilestoneSchema,pendingMilestoneReviewSchema} from './pending-milestone.js';
import {ETA_TIME_BASIS} from '../core/eta-time-contract.js';
import {TASK_OBJECTIVE_TARGET} from '../core/task-objective.js';

const seconds = z.number().finite().nonnegative().max(31_536_000);
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measurementRef = z.string().regex(/^pm_[a-f0-9]{32}$/u);
const eventSchema = z.object({ordinal, kind:z.enum(['user','assistant','tool_start','tool_result']),
  atMs:z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pairOrdinal:ordinal.optional(), counterpartMissing:z.boolean().optional()}).strict();
const packingLossSchema = z.object({suppliedMessages:ordinal,retainedMessages:ordinal,
  droppedByKind:z.object({user:ordinal,assistant:ordinal,tool:ordinal}).strict(),
  clippedMessages:ordinal}).strict();
const representationSchema=z.object({
  mode:z.enum(['full','compressed','incomplete']),
  sourceComplete:z.boolean(),
  missingImages:ordinal.optional(),
  inferenceEligible:z.boolean().optional(),
  sourceGaps:z.array(z.enum(['missing_image','upstream_truncated','unsupported_payload','unattributed_record','deduplication_window','unreadable_record'])).optional(),
  originalRecords:ordinal,
  sessionCoveredRecords:ordinal.optional(),
  sourceRepresentation:z.enum(['raw_history','upstream_compacted']).optional(),
  checkpointBootstrapped:z.boolean().optional(),
  checkpointEncodedBytes:ordinal.optional(),
  checkpointItemCount:ordinal.optional(),
  compressedThroughOrdinal:ordinal.nullable(),
  sizing:z.enum(['tokenizer','conservative']),
  importedThroughOrdinal:ordinal.nullable().optional(),
  importedRecords:ordinal.optional(),
  importedEncodedBytes:ordinal.optional(),
  stagedRecords:ordinal.optional(),
  stagedEncodedBytes:ordinal.optional(),
  stagedThroughOrdinal:ordinal.nullable().optional(),
  acceptedThroughOrdinal:ordinal.nullable().optional(),
  confirmedCompactions:ordinal.optional(),
  confirmedCompactionThroughOrdinal:ordinal.nullable().optional(),
  compressionState:z.enum(['none','confirmed']).optional(),
  residentBound:z.enum(['policy_assumed','unverified']).optional(),
  retainedSummaryReserveBytes:ordinal.optional(),
  contextCapacityBytes:ordinal.optional(),
  budgetStatus:z.enum(['trusted','unconfigured','exhausted']).optional(),
}).strict();
const historySummarySchema=z.object({
  text:z.string().min(1),
  firstOrdinal:ordinal,
  lastOrdinal:ordinal,
}).strict().refine(value=>value.firstOrdinal<=value.lastOrdinal);
const workPartSchema=z.object({
  workClass:z.enum(['file_processing','batch_processing','other']),
  unit:z.enum(['file','batch','unknown']),
  remainingUnits:z.number().int().positive().max(1_000_000).nullable(),
  priorSeconds:seconds,
  measurementRef:measurementRef.nullable().transform(value=>value??undefined).optional(),
}).strict();
const workSchema=z.object({composition:z.enum(['serial','unknown']),
  changeReason:z.enum(['routine','scope_change','failure','unknown']),
  parts:z.array(workPartSchema).min(1).max(8)}).strict();
export const observerResponseSchema = z.object({
  pendingMilestoneReview:pendingMilestoneReviewSchema.nullable().optional(),
  completionOutlook:completionOutlookSchema.nullable().optional(),
  estimateConditions:estimateConditionsSchema.nullable().optional(),
  relation: z.enum(['continue', 'replace', 'unknown']),
  status: z.enum(['running', 'waiting', 'completed', 'unknown']),
  summary: z.string().trim().min(1).max(2048).nullable(),
  basis: z.enum(['known_wait','remaining_work','recent_pace','insufficient_context']).nullable().optional(),
  estimate: z.object({remainingSeconds: seconds,
    errorPercent: z.number().finite().min(0).max(1000)}).strict().nullable(),
  work:workSchema.nullable().optional(),
  nextMilestone:nextMilestoneSchema.nullable().optional(),
  progressReview:progressReviewSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if ((value.relation === 'replace' && value.summary === null) ||
      (value.relation === 'unknown' && (value.status !== 'unknown' || value.estimate !== null || value.summary !== null)) ||
      (value.status === 'completed' && value.estimate !== null) ||
      ((value.relation === 'unknown' || value.status === 'unknown' || value.status === 'completed') && value.work !== undefined && value.work !== null)) {
    context.addIssue({code: 'custom', message: 'inconsistent observer interpretation'});
  }
});
export type ObserverResponse = z.infer<typeof observerResponseSchema>;
const observationSchema = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  summaryThroughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeTimeKnown: z.boolean(), historyComplete: z.boolean(),
  currentAction: z.object({text: z.string().min(1), elapsedSeconds: seconds}).strict().nullable(),
  previousEstimate: z.object({remainingSeconds: seconds,
    errorPercent: z.number().finite().min(0).max(1000), observedActiveSeconds: seconds}).strict().nullable(),
  omittedCategories: z.array(z.enum(['user', 'assistant', 'tool', 'summary'])).max(4)
}).strict();
export const observerInputSchema = z.object({
  pendingMilestone:pendingMilestoneSchema.optional(),
  turnEvidence:turnEvidenceSchema.optional(),
  executionObservations:z.object({schemaVersion:z.literal(1),snapshotAtMs:ordinal,throughOrdinal:ordinal,
    samples:z.array(z.object({startOrdinal:ordinal,endOrdinal:ordinal,startedAtMs:ordinal,endedAtMs:ordinal,
      elapsedSeconds:seconds,clock:z.literal('wall'),overlapsOtherTool:z.boolean(),
      operationKey:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()
      .refine(v=>v.startOrdinal<v.endOrdinal&&v.startedAtMs<=v.endedAtMs&&
        Math.abs(v.elapsedSeconds-(v.endedAtMs-v.startedAtMs)/1000)<0.000001)).max(5),
    comparableGroups:z.array(z.object({operationKey:z.string().regex(/^[a-f0-9]{64}$/),
      sampleEndOrdinals:z.array(ordinal).min(1).max(5),count:z.number().int().min(1).max(5),
      medianSeconds:seconds,minSeconds:seconds,maxSeconds:seconds,minimumSampleCountMet:z.boolean()}).strict()).max(5).optional(),
    reportedSamples:z.array(z.object({endOrdinal:ordinal,reportedSeconds:seconds,
      provenance:z.literal('native_reported_duration'),startTimeKnown:z.literal(false),
      overlapKnown:z.literal(false),activeTimeKnown:z.literal(false)}).strict()).max(5).optional(),
    extrapolationAllowed:z.literal(false)}).strict().refine(v=>{
      const keys=new Set<string>();
      return (v.comparableGroups??[]).every(g=>{
        if(keys.has(g.operationKey))return false;keys.add(g.operationKey);
        const matched=v.samples.filter(s=>s.operationKey===g.operationKey&&!s.overlapsOtherTool);
        const values=matched.map(s=>s.elapsedSeconds).sort((a,b)=>a-b);
        return matched.length===g.count&&g.sampleEndOrdinals.length===g.count&&
          new Set(g.sampleEndOrdinals).size===g.count&&matched.every(s=>g.sampleEndOrdinals.includes(s.endOrdinal))&&
          g.minSeconds===values[0]&&g.maxSeconds===values[values.length-1]&&
          g.medianSeconds===(values[Math.floor((values.length-1)/2)]!+values[Math.floor(values.length/2)]!)/2&&
          g.minimumSampleCountMet===(g.count>=3);
      });
    }).refine(v=>new Set([...v.samples,...(v.reportedSamples??[])].map(s=>s.endOrdinal)).size===v.samples.length+(v.reportedSamples?.length??0))
    .refine(v=>new Set(v.samples.map(s=>s.startOrdinal)).size===v.samples.length)
    .refine(v=>(v.reportedSamples??[]).every(s=>s.endOrdinal<=v.throughOrdinal&&!v.samples.some(p=>p.endOrdinal===s.endOrdinal)))
    .refine(v=>v.samples.every(s=>
      s.endOrdinal<=v.throughOrdinal&&s.endedAtMs<=v.snapshotAtMs)).optional(),
  imageContextPending:z.boolean().optional(),
  progressState:progressStateSchema.optional(),
  goalSummary: z.string().min(1).max(2048).nullable(),
  timeBasis:z.literal(ETA_TIME_BASIS).optional(),
  predictionTarget:z.literal(TASK_OBJECTIVE_TARGET).optional(),
  objectiveTargetId:z.string().regex(/^objective_[a-f0-9]{64}$/).optional(),
  activeSeconds: seconds,
  nativeTiming:z.object({requestActiveSeconds:seconds}).strict().optional(),
  runtime: z.enum(['running', 'waiting', 'paused']),
  messages: z.array(z.object({kind: z.enum(['user', 'assistant', 'tool']),
    text: z.string().min(1), truncated: z.boolean(), scope:z.enum(['current','background']).optional(), event:eventSchema.optional()}).strict()
    .refine(message=>!message.event || (message.kind==='tool'
      ? message.event.kind==='tool_start'||message.event.kind==='tool_result'
      : message.event.kind===message.kind && message.event.pairOrdinal===undefined && message.event.counterpartMissing===undefined))).min(1),
  truncated: z.boolean(),
  paceMeasurements:z.array(z.object({
    measurementRef,
    workClass:z.literal('file_processing'),
    unit:z.literal('file'),
    sampleCount:z.number().int().min(3).max(5),
    medianSecondsPerUnit:seconds,
    clock:z.literal('tool_execution'),
  }).strict()).max(8).optional(),
  packingLoss:packingLossSchema.optional(),
  observation: observationSchema.optional(),
  representation:representationSchema.optional(),
  historySummary:historySummarySchema.optional(),
}).strict()
  .refine(value=>(value.predictionTarget!==undefined)===(value.objectiveTargetId!==undefined))
  .refine(value=>!value.nativeTiming||value.nativeTiming.requestActiveSeconds<=value.activeSeconds)
  .refine(value => !value.packingLoss || (value.packingLoss.retainedMessages === value.messages.length &&
    value.packingLoss.clippedMessages === value.messages.filter(m=>m.truncated).length &&
    value.packingLoss.suppliedMessages === value.packingLoss.retainedMessages +
      Object.values(value.packingLoss.droppedByKind).reduce((a,b)=>a+b,0)))
  .refine(value => !value.observation ||
    (value.observation.summaryThroughSequence <= value.observation.sequence &&
      (!value.observation.previousEstimate ||
        value.observation.previousEstimate.observedActiveSeconds <= value.activeSeconds)))
  .refine(value => !value.representation ||
    (value.representation.mode==='compressed'
      ? value.representation.compressedThroughOrdinal!==null
      : value.representation.compressedThroughOrdinal===null))
  .refine(value=>{
    const representation=value.representation;
    if(!representation)return value.historySummary===undefined;
    if(representation.sourceComplete&&(representation.sourceGaps?.length??0)>0)return false;
    if(((representation.missingImages??0)>0)!==(representation.sourceGaps?.includes('missing_image')===true))return false;
    if(representation.inferenceEligible===true&&!isInferenceEligible(representation))return false;
    if((representation.missingImages??0)>0&&representation.sourceComplete)return false;
    if(representation.originalRecords<value.messages.length)return false;
    if(value.observation&&value.observation.historyComplete!==representation.sourceComplete)return false;
    if(representation.mode==='compressed')return value.historySummary!==undefined&&
      value.historySummary.lastOrdinal===representation.compressedThroughOrdinal;
    if(value.historySummary!==undefined)return false;
    return representation.mode==='full'?representation.sourceComplete&&representation.originalRecords===value.messages.length:
      !representation.sourceComplete;
  });
export type ObserverInput = z.infer<typeof observerInputSchema>;

/** Missing attachments are the only approved incomplete-context exception. */
export function isInferenceEligible(value:{sourceComplete:boolean;mode:string;inferenceEligible?:boolean|undefined;missingImages?:number|undefined;sourceGaps?:readonly string[]|undefined}):boolean {
  if(value.inferenceEligible===false||!Number.isSafeInteger(value.missingImages??0)||(value.missingImages??0)<0)return false;
  if(value.sourceComplete)return value.mode!=='incomplete'&&!(value.missingImages??0)&&!(value.sourceGaps?.length);
  return value.inferenceEligible===true&&(value.missingImages??0)>0&&value.sourceGaps?.length===1&&value.sourceGaps[0]==='missing_image';
}
