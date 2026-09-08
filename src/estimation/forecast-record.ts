import {z} from 'zod';

export type PaceReason = 'eligible'|'missing_measurements'|'insufficient_intervals'
  |'incompatible_units'|'unknown_clock'|'parallel_work'|'invalid_composition';

export interface ForecastVersions {
  input:string;
  prompt:string;
  model:string;
  algorithm:string;
}

export interface ForecastMeasurement {
  source:'vitest_json';
  clock:'tool_execution';
  remainingUnitsProvenance:'model_hypothesis';
  sampleCount:number;
}

export interface ForecastRecord {
  schemaVersion:1;
  predictionId:number;
  generation:number;
  snapshotActiveSeconds:number;
  acceptedAt:number;
  rawSeconds:number|null;
  shadowSeconds:number|null;
  paceReason:PaceReason;
  calibration:'uncalibrated';
  measurement?:ForecastMeasurement;
  versions:ForecastVersions;
}

const seconds=z.number().finite().nonnegative().max(31_536_000);
const ordinal=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export const forecastMeasurementSchema=z.object({source:z.literal('vitest_json'),clock:z.literal('tool_execution'),
  remainingUnitsProvenance:z.literal('model_hypothesis'),sampleCount:z.number().int().min(3).max(5)}).strict();
const forecastSchema=z.object({
  schemaVersion:z.literal(1),predictionId:ordinal,generation:ordinal,
  snapshotActiveSeconds:seconds,acceptedAt:z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rawSeconds:seconds.nullable(),shadowSeconds:seconds.nullable(),
  paceReason:z.enum(['eligible','missing_measurements','insufficient_intervals','incompatible_units',
    'unknown_clock','parallel_work','invalid_composition']),
  calibration:z.literal('uncalibrated'),
  measurement:forecastMeasurementSchema.optional(),
  versions:z.object({input:identifier,prompt:identifier,model:identifier,algorithm:identifier}).strict(),
}).strict().superRefine((value,ctx)=>{
  if(value.measurement!==undefined && (value.paceReason!=='eligible'||value.shadowSeconds===null))
    ctx.addIssue({code:'custom',path:['measurement'],message:'measurement requires an eligible shadow forecast'});
});

export function makeForecastRecord(value:ForecastRecord):Readonly<ForecastRecord> {
  const parsed=forecastSchema.parse(value) as ForecastRecord;
  const versions=Object.freeze({...parsed.versions});
  const measurement=parsed.measurement===undefined?undefined:Object.freeze({...parsed.measurement});
  return Object.freeze({...parsed,...(measurement===undefined?{}:{measurement}),versions});
}
