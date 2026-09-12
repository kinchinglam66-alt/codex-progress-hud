import {identityKey,sampleSchema,type Sample} from '../../estimation/residual/contract.js';
import {parseArtifact,predictResidual,type ResidualArtifact} from '../../estimation/residual/predict.js';
import {attemptSchema,type Attempt} from './dataset.js';
const mean=(values:number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
function quantile(values:number[],fraction:number):number|null{
  if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);
  if(fraction===0.5){const mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]!:((sorted[mid-1]!+sorted[mid]!)/2);}
  return sorted[Math.max(0,Math.ceil(fraction*sorted.length)-1)]!;
}
interface Pair {sample:Sample;raw:number;scale:number;residual:number}
function metrics(pairs:Pair[],key:'raw'|'scale'|'residual',delivery:boolean){
  const groups=new Map<string,{errors:number[];logs:number[];hits:number[];under:number[]}>();
  for(const pair of pairs){
    const s=pair.sample,id=identityKey(s.identity),lag=delivery?s.deliveryLagSeconds:0;
    const actual=s.actualSeconds-lag,predicted=Math.max(0,pair[key]-lag),error=predicted-actual;
    const values=groups.get(id)??{errors:[],logs:[],hits:[],under:[]};
    values.errors.push(error);values.logs.push(Math.abs(Math.log1p(predicted)-Math.log1p(actual)));
    values.hits.push(Number(Math.abs(error)/Math.max(actual,60)<=0.3));values.under.push(Math.max(0,-error));groups.set(id,values);
  }
  const turns=[...groups.values()];return {maeSeconds:mean(turns.map(t=>mean(t.errors.map(Math.abs))!)),
    biasSeconds:mean(turns.map(t=>mean(t.errors)!)),medianAbsoluteLogError:quantile(turns.map(t=>quantile(t.logs,0.5)!),0.5),
    medianTurnMaxUnderestimateSeconds:quantile(turns.map(t=>Math.max(...t.under)),0.5),
    p90TurnMaxUnderestimateSeconds:quantile(turns.map(t=>Math.max(...t.under)),0.9),
    within30PercentWith60SecondFloor:mean(turns.map(t=>mean(t.hits)!))};
}
export function scoreResidual(rawSamples:readonly Sample[],artifact:ResidualArtifact,rawAttempts?:readonly Attempt[]){
  const model=parseArtifact(artifact),samples=rawSamples.map(s=>sampleSchema.parse(s));
  const attempts=rawAttempts===undefined?samples.map(s=>({identity:s.identity,predictionId:s.predictionId,reason:'eligible' as const})):rawAttempts.map(a=>attemptSchema.parse(a));
  if([...samples,...attempts].some(s=>model.trainingGroups.includes(s.identity.groupId)||model.validationGroups.includes(s.identity.groupId)))throw Error('RESIDUAL_SCORE_LEAKAGE');
  const attemptKeys=new Set(attempts.map(a=>JSON.stringify([identityKey(a.identity),a.predictionId])));
  const eligibleKeys=new Set(attempts.filter(a=>a.reason==='eligible').map(a=>JSON.stringify([identityKey(a.identity),a.predictionId])));
  const sampleKeys=new Set(samples.map(s=>JSON.stringify([identityKey(s.identity),s.predictionId])));
  if(attemptKeys.size!==attempts.length||sampleKeys.size!==samples.length||eligibleKeys.size!==sampleKeys.size||
    [...sampleKeys].some(key=>!eligibleKeys.has(key)))throw Error('RESIDUAL_SCORE_ATTEMPTS');
  if(samples.some(s=>s.deliveryLagSeconds>s.actualSeconds))throw Error('RESIDUAL_SCORE_CLOCK');
  const pairs:Pair[]=[],fallbacks:Record<string,number>={};
  for(const attempt of attempts)if(attempt.reason!=='eligible')fallbacks[attempt.reason]=(fallbacks[attempt.reason]??0)+1;
  for(const sample of samples){
    const shadow=predictResidual(model,sample.features,sample.versions);
    if(shadow.seconds===null){fallbacks[shadow.reason]=(fallbacks[shadow.reason]??0)+1;continue;}
    const scale=Math.max(0,Math.expm1(Math.log1p(sample.features.rawSeconds)+model.logScale));
    if(!Number.isFinite(scale)||scale>Number.MAX_SAFE_INTEGER){fallbacks.non_finite_scale=(fallbacks.non_finite_scale??0)+1;continue;}
    pairs.push({sample,raw:sample.features.rawSeconds,scale,residual:shadow.seconds});
  }
  const groupCount=new Set(attempts.map(s=>s.identity.groupId)).size;
  const pairedGroups=new Set(pairs.map(p=>p.sample.identity.groupId)).size;
  const clocks=(rows:Pair[])=>({request:{raw:metrics(rows,'raw',false),scale:metrics(rows,'scale',false),residual:metrics(rows,'residual',false)},
    delivery:{raw:metrics(rows,'raw',true),scale:metrics(rows,'scale',true),residual:metrics(rows,'residual',true)}});
  return {schemaVersion:1,artifactId:model.artifactId,target:'current_turn_active_seconds',grouping:'opaque_conversation',
    counts:{groups:groupCount,turns:new Set(attempts.map(s=>identityKey(s.identity))).size,predictions:attempts.length,labelledPredictions:samples.length,pairedGroups},
    coverage:{eligible:attempts.length,predicted:pairs.length,fraction:attempts.length?pairs.length/attempts.length:null},fallbacks,
    insufficientEvidence:groupCount<10||pairedGroups<10,metrics:clocks(pairs),
    observedAgeStrata:Object.fromEntries([['under60',0,60],['60to600',60,600],['over600',600,Infinity]].map(([name,low,high])=>{
      const rows=pairs.filter(p=>p.sample.features.observedActiveSeconds>=(low as number)&&p.sample.features.observedActiveSeconds<(high as number));
      return [name,{predictions:rows.length,metrics:clocks(rows)}];
    })),
    phaseStrata:'unavailable_without_whole_turn_duration',
    limitations:['normal_end_is_not_solution_verification','equivalent_tasks_in_different_conversations_require_explicit_group_mapping',
      'paired_metrics_exclude_fallbacks_see_coverage','synthetic_fixtures_do_not_establish_accuracy'],
  };
}
