import {z} from 'zod';

const ordinal=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const version=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export const versionsSchema=z.object({input:version,prompt:version,model:version,algorithm:version}).strict();
export const identitySchema=z.object({groupId:digest,turnId:digest,
  runId:z.string().regex(/^[a-f0-9]{32}$/u),sourceEpoch:ordinal,generation:ordinal}).strict();
export type Identity=z.infer<typeof identitySchema>;
const featureFields={elapsedActiveSeconds:seconds.nullable(),observedActiveSeconds:seconds,
  oldestActionActiveSeconds:seconds.nullable(),outstandingActions:ordinal,completedActions:ordinal,
  failedActions:ordinal,prefixComplete:z.boolean()};
export const prefixFeaturesSchema=z.object(featureFields).strict().refine(x=>x.failedActions<=x.completedActions,
  {message:'failed action count exceeds completed actions'});
export const featuresSchema=z.object({rawSeconds:seconds,...featureFields}).strict().refine(x=>x.failedActions<=x.completedActions,
  {message:'failed action count exceeds completed actions'});
export type Features=z.infer<typeof featuresSchema>;
export const prefixSchema=z.object({identity:identitySchema,predictionId:ordinal,watermark:digest,
  anchorActiveSeconds:seconds,features:prefixFeaturesSchema}).strict();
export type Prefix=z.infer<typeof prefixSchema>;
export const outcomeSchema=z.enum(['normal_end','interrupted','failed','superseded','clock_unknown','recording_gap']);
export type Outcome=z.infer<typeof outcomeSchema>;
export const shadowReasons=['predicted','no_artifact','invalid_artifact','version_mismatch','insufficient_support',
  'out_of_range','unseen_missingness','non_finite','prefix_unavailable'] as const;
export const shadowSchema=z.object({seconds:seconds.nullable(),reason:z.enum(shadowReasons),artifactId:digest.nullable()}).strict()
  .refine(x=>x.reason==='predicted'?(x.seconds!==null&&x.artifactId!==null):x.seconds===null,
    {message:'shadow result does not match its reason'});
export type Shadow=z.infer<typeof shadowSchema>;
export const researchRecordSchema=z.discriminatedUnion('kind',[
  z.object({schemaVersion:z.literal(1),kind:z.literal('unavailable_forecast'),sequence:ordinal,identity:identitySchema,
    predictionId:ordinal,rawSeconds:seconds,deliveredActiveSeconds:seconds,versions:versionsSchema,reason:z.literal('prefix_unavailable')}).strict(),
  z.object({schemaVersion:z.literal(1),kind:z.literal('forecast'),sequence:ordinal,prefix:prefixSchema,
    rawSeconds:seconds,deliveredActiveSeconds:seconds,versions:versionsSchema,shadow:shadowSchema}).strict(),
  z.object({schemaVersion:z.literal(1),kind:z.literal('terminal'),sequence:ordinal,identity:identitySchema,
    endActiveSeconds:seconds,outcome:outcomeSchema,evidenceId:digest,clockReliable:z.boolean()}).strict()
    .refine(x=>x.outcome!=='normal_end'||x.clockReliable,{message:'normal end requires reliable clock'}),
  z.object({schemaVersion:z.literal(1),kind:z.literal('invalidate'),sequence:ordinal,identity:identitySchema,
    reason:z.enum(['conflicting_terminal','clock_unknown','recording_gap'])}).strict(),
]);
export type ResearchRecord=z.infer<typeof researchRecordSchema>;
export const sampleSchema=z.object({identity:identitySchema,predictionId:ordinal,features:featuresSchema,
  actualSeconds:seconds,deliveryLagSeconds:seconds,versions:versionsSchema}).strict();
export type Sample=z.infer<typeof sampleSchema>;

/** Freeze only schema-parsed data: callers retain ownership of their input. */
export function freezeData<T>(value:T):T {
  if(value!==null&&typeof value==='object'){
    for(const child of Object.values(value))freezeData(child);
    Object.freeze(value);
  }
  return value;
}
export function parseResearchRecord(value:unknown):ResearchRecord {
  return freezeData(researchRecordSchema.parse(value));
}
export function identityKey(value:Identity):string {
  const id=identitySchema.parse(value);
  return JSON.stringify([id.groupId,id.turnId,id.runId,id.sourceEpoch,id.generation]);
}
