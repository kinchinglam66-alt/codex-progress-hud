import {z} from 'zod';

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
  originalRecords:ordinal,
  sessionCoveredRecords:ordinal.optional(),
  compressedThroughOrdinal:ordinal.nullable(),
  sizing:z.enum(['tokenizer','conservative']),
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
  relation: z.enum(['continue', 'replace', 'unknown']),
  status: z.enum(['running', 'waiting', 'completed', 'unknown']),
  summary: z.string().trim().min(1).max(2048).nullable(),
  basis: z.enum(['known_wait','remaining_work','recent_pace','insufficient_context']).nullable().optional(),
  estimate: z.object({remainingSeconds: seconds,
    errorPercent: z.number().finite().min(0).max(1000)}).strict().nullable(),
  work:workSchema.nullable().optional(),
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
  goalSummary: z.string().min(1).max(2048).nullable(),
  activeSeconds: seconds,
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
    if(representation.originalRecords<value.messages.length)return false;
    if(value.observation&&value.observation.historyComplete!==representation.sourceComplete)return false;
    if(representation.mode==='compressed')return value.historySummary!==undefined&&
      value.historySummary.lastOrdinal===representation.compressedThroughOrdinal;
    if(value.historySummary!==undefined)return false;
    return representation.mode==='full'?representation.sourceComplete&&representation.originalRecords===value.messages.length:
      !representation.sourceComplete;
  });
export type ObserverInput = z.infer<typeof observerInputSchema>;
