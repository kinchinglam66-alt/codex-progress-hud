import {createHash} from 'node:crypto';
import {z} from 'zod';
import {freezeData,versionsSchema,type Features,type Shadow} from './contract.js';
import type {ForecastVersions} from '../forecast-record.js';
import {vectorize} from './features.js';
const finite=z.number().finite();
const vector=z.array(finite).length(10);
const bodySchema=z.object({schemaVersion:z.literal(1),featureVersion:z.literal('residual-prefix-v1'),versions:versionsSchema,
  trainingTurns:z.number().int().nonnegative(),trainingGroups:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(10000),
  validationGroups:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(10000),
  means:vector,scales:z.array(finite.nonnegative()).length(10),
  minimum:z.array(finite.nullable()).length(10),maximum:z.array(finite.nullable()).length(10),
  missingMasks:z.array(z.string().regex(/^[01]{2}$/u)).min(1).max(4),coefficients:vector,
  intercept:finite,lambda:z.union([z.literal(0.1),z.literal(1),z.literal(10),z.literal(100)]),logScale:finite,
}).strict();
const artifactSchema=bodySchema.extend({artifactId:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export type ResidualArtifact=z.infer<typeof artifactSchema>;
const validated=new WeakSet<object>();
export function createArtifact(body:z.infer<typeof bodySchema>):ResidualArtifact{
  const value=bodySchema.parse(body);
  return parseArtifact({...value,artifactId:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
}
export function parseArtifact(value:unknown):ResidualArtifact{
  if(Buffer.byteLength(JSON.stringify(value)??'')>1024*1024)throw Error('RESIDUAL_ARTIFACT_TOO_LARGE');
  const parsed=artifactSchema.parse(value),{artifactId,...body}=parsed;
  if(artifactId!==createHash('sha256').update(JSON.stringify(body)).digest('hex'))throw Error('RESIDUAL_ARTIFACT_DIGEST');
  if(new Set(parsed.trainingGroups).size!==parsed.trainingGroups.length||
    new Set(parsed.validationGroups).size!==parsed.validationGroups.length||
    parsed.validationGroups.some(g=>parsed.trainingGroups.includes(g)))throw Error('RESIDUAL_ARTIFACT_GROUPS');
  for(let i=0;i<10;i++){
    const low=parsed.minimum[i]!,high=parsed.maximum[i]!;
    if((low===null)!==(high===null)||(low!==null&&high!==null&&low>high))throw Error('RESIDUAL_ARTIFACT_RANGE');
  }
  const result=freezeData(parsed);validated.add(result);return result;
}
export const missingMask=(vector:readonly number[])=>`${vector[7]}${vector[8]}`;
export const featureMissing=(vector:readonly number[],index:number)=>(index===1&&vector[7]===1)||(index===3&&vector[8]===1);
export function normalizeVector(vector:readonly number[],model:Pick<ResidualArtifact,'means'|'scales'>):number[]{
  return vector.map((value,i)=>model.scales[i]===0?0:((featureMissing(vector,i)?model.means[i]!:value)-model.means[i]!)/model.scales[i]!);
}
export function predictResidual(artifact:ResidualArtifact|null,features:Features,versions:ForecastVersions):Shadow{
  const fallback=(reason:Shadow['reason'],artifactId:string|null=null):Shadow=>({seconds:null,reason,artifactId});
  if(artifact===null)return fallback('no_artifact');
  let model:ResidualArtifact;try{model=validated.has(artifact)?artifact:parseArtifact(artifact);}catch{return fallback('invalid_artifact');}
  if(Object.keys(model.versions).some(k=>model.versions[k as keyof ForecastVersions]!==versions[k as keyof ForecastVersions]))return fallback('version_mismatch',model.artifactId);
  if(model.trainingTurns<30||model.trainingGroups.length<10)return fallback('insufficient_support',model.artifactId);
  let vector:readonly number[];try{vector=vectorize(features);}catch{return fallback('non_finite',model.artifactId);}
  if(!model.missingMasks.includes(missingMask(vector)))return fallback('unseen_missingness',model.artifactId);
  for(let i=0;i<10;i++)if(!featureMissing(vector,i)){
    const low=model.minimum[i]!,high=model.maximum[i]!;
    if(low===null||high===null||vector[i]!<low||vector[i]!>high)return fallback('out_of_range',model.artifactId);
  }
  const normalized=normalizeVector(vector,model);
  const residual=model.intercept+normalized.reduce((sum,x,i)=>sum+x*model.coefficients[i]!,0);
  const seconds=Math.max(0,Math.expm1(Math.log1p(features.rawSeconds)+residual));
  if(!Number.isFinite(seconds)||seconds>Number.MAX_SAFE_INTEGER)return fallback('non_finite',model.artifactId);
  return {seconds,reason:'predicted',artifactId:model.artifactId};
}
