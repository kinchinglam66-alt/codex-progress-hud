import {identityKey,identitySchema,parseResearchRecord,sampleSchema,freezeData,prefixFailureSchema,type ResearchRecord,type Sample,type Identity} from '../../estimation/residual/contract.js';
import {z} from 'zod';

export const attemptSchema=z.object({identity:identitySchema,predictionId:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reason:z.enum(['eligible','prefix_unavailable','invalidated','missing_terminal','invalid_clock','normal_end','interrupted','failed','superseded','clock_unknown','recording_gap']),
  detail:prefixFailureSchema.optional()}).strict();
export type Attempt=z.infer<typeof attemptSchema>;
export function buildDataset(records:readonly ResearchRecord[]):{samples:Sample[];attempts:Attempt[];excluded:Record<string,number>}{
  const forecasts=new Map<string,Extract<ResearchRecord,{kind:'forecast'}>>(),terminals=new Map<string,Extract<ResearchRecord,{kind:'terminal'}>>();
  const attempts=new Map<string,Attempt>();
  const invalid=new Set<string>(),conflicts=new Set<string>(),sequences=new Map<string,{serialized:string;key:string}>(),excluded:Record<string,number>={};
  const count=(reason:string)=>{excluded[reason]=(excluded[reason]??0)+1;};
  for(const input of records){
    const row=parseResearchRecord(input),id=row.kind==='forecast'?row.prefix.identity:row.identity,key=identityKey(id);
    const seqKey=JSON.stringify([id.runId,row.sequence]),serialized=JSON.stringify(row),previous=sequences.get(seqKey);
    if(previous!==undefined){if(previous.serialized===serialized)continue;invalid.add(key);invalid.add(previous.key);count('conflicting_sequence');}
    else sequences.set(seqKey,{serialized,key});
    if(row.kind==='unavailable_forecast'){
      const prediction=JSON.stringify([key,row.predictionId]);
      attempts.set(prediction,{identity:row.identity,predictionId:row.predictionId,reason:'prefix_unavailable',
        ...(row.detail===undefined?{}:{detail:row.detail})});continue;
    }
    if(row.kind==='invalidate'){invalid.add(key);continue;}
    if(row.kind==='terminal'){
      const prior=terminals.get(key);
      if(prior&&(prior.outcome!==row.outcome||prior.endActiveSeconds!==row.endActiveSeconds||prior.clockReliable!==row.clockReliable))invalid.add(key);
      else terminals.set(key,row);
    }else{
      const prediction=JSON.stringify([key,row.prefix.predictionId]),prior=forecasts.get(prediction);
      if(prior&&JSON.stringify({...prior,sequence:0})!==JSON.stringify({...row,sequence:0}))conflicts.add(prediction);
      else forecasts.set(prediction,row);
    }
  }
  const samples:Sample[]=[];
  for(const [prediction,row] of forecasts){
    const key=identityKey(row.prefix.identity),terminal=terminals.get(key);
    const attempt=(reason:Attempt['reason'])=>{attempts.set(prediction,{identity:row.prefix.identity,predictionId:row.prefix.predictionId,reason});};
    if(attempts.has(prediction))continue;
    if(invalid.has(key)||conflicts.has(prediction)){attempt('invalidated');continue;}
    if(!terminal){attempt('missing_terminal');continue;}
    if(terminal.outcome!=='normal_end'||!terminal.clockReliable){attempt(terminal.outcome);continue;}
    const actualSeconds=terminal.endActiveSeconds-row.prefix.anchorActiveSeconds,
      deliveryLagSeconds=row.deliveredActiveSeconds-row.prefix.anchorActiveSeconds;
    if(actualSeconds<0||deliveryLagSeconds<0||deliveryLagSeconds>actualSeconds){attempt('invalid_clock');continue;}
    samples.push(freezeData(sampleSchema.parse({identity:row.prefix.identity,predictionId:row.prefix.predictionId,
      features:{...row.prefix.features,rawSeconds:row.rawSeconds},actualSeconds,deliveryLagSeconds,versions:row.versions})));
    attempt('eligible');
  }
  for(const attempt of attempts.values())if(attempt.reason!=='eligible')count(attempt.reason);
  return {samples,attempts:[...attempts.values()],excluded};
}
export const splitManifestSchema=z.object({train:z.array(z.string()),validation:z.array(z.string()),test:z.array(z.string())}).strict();
export type SplitManifest=z.infer<typeof splitManifestSchema>;
export function splitSamples(samples:readonly Sample[],manifest:SplitManifest):{train:Sample[];validation:Sample[];test:Sample[]}{
  const parsed=splitManifestSchema.parse(manifest),owners=new Map<string,keyof SplitManifest>();
  for(const phase of ['train','validation','test'] as const)for(const group of parsed[phase]){
    if(owners.has(group))throw Error('RESIDUAL_SPLIT_OVERLAP');owners.set(group,phase);
  }
  const result:{train:Sample[];validation:Sample[];test:Sample[]}={train:[],validation:[],test:[]};
  for(const raw of samples){const sample=sampleSchema.parse(raw),phase=owners.get(sample.identity.groupId);
    if(!phase)throw Error('RESIDUAL_SPLIT_UNASSIGNED');result[phase].push(freezeData(sample));}
  return result;
}
