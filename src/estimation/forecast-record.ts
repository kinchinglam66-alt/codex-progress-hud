import {z} from 'zod';

export type PaceReason = 'eligible'|'missing_measurements'|'insufficient_intervals'
  |'incompatible_units'|'unknown_clock'|'parallel_work'|'invalid_composition';

export interface ForecastVersions {
  input:string;
  prompt:string;
  model:string;
  algorithm:string;
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
  versions:ForecastVersions;
}

const seconds=z.number().finite().nonnegative().max(31_536_000);
const ordinal=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const forecastSchema=z.object({
  schemaVersion:z.literal(1),predictionId:ordinal,generation:ordinal,
  snapshotActiveSeconds:seconds,acceptedAt:z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rawSeconds:seconds.nullable(),shadowSeconds:seconds.nullable(),
  paceReason:z.enum(['eligible','missing_measurements','insufficient_intervals','incompatible_units',
    'unknown_clock','parallel_work','invalid_composition']),
  calibration:z.literal('uncalibrated'),
  versions:z.object({input:identifier,prompt:identifier,model:identifier,algorithm:identifier}).strict(),
}).strict();

export function makeForecastRecord(value:ForecastRecord):Readonly<ForecastRecord> {
  const parsed=forecastSchema.parse(value) as ForecastRecord;
  const versions=Object.freeze({...parsed.versions});
  return Object.freeze({...parsed,versions});
}
