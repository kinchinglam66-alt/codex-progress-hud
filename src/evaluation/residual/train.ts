import {identityKey,sampleSchema,type Sample} from '../../estimation/residual/contract.js';
import {vectorize} from '../../estimation/residual/features.js';
import {createArtifact,featureMissing,missingMask,normalizeVector,predictResidual,type ResidualArtifact} from '../../estimation/residual/predict.js';

/** Equal total weight per turn, independent of snapshot frequency. */
export function turnWeights(samples:readonly Sample[]):number[]{
  const counts=new Map<string,number>();for(const s of samples){const key=identityKey(s.identity);counts.set(key,(counts.get(key)??0)+1);}
  return samples.map(s=>1/counts.get(identityKey(s.identity))!);
}
function solve(matrix:number[][],target:number[]):number[]{
  const n=target.length,a=matrix.map((row,i)=>[...row,target[i]!]);
  for(let col=0;col<n;col++){
    let pivot=col;for(let row=col+1;row<n;row++)if(Math.abs(a[row]![col]!)>Math.abs(a[pivot]![col]!))pivot=row;
    [a[col],a[pivot]]=[a[pivot]!,a[col]!];const divisor=a[col]![col]!;
    if(!Number.isFinite(divisor)||Math.abs(divisor)<1e-12)throw Error('RESIDUAL_SINGULAR_FIT');
    for(let j=col;j<=n;j++)a[col]![j]=a[col]![j]!/divisor;
    for(let row=0;row<n;row++)if(row!==col){const factor=a[row]![col]!;for(let j=col;j<=n;j++)a[row]![j]=a[row]![j]!-factor*a[col]![j]!;}
  }
  const result=a.map(row=>row[n]!);if(result.some(x=>!Number.isFinite(x)))throw Error('RESIDUAL_NON_FINITE_FIT');return result;
}
export function trainResidual(rawTrain:readonly Sample[],rawValidation:readonly Sample[]):ResidualArtifact{
  const train=rawTrain.map(s=>sampleSchema.parse(s)),validation=rawValidation.map(s=>sampleSchema.parse(s));
  const trainingGroups=[...new Set(train.map(s=>s.identity.groupId))].sort(),validationGroups=[...new Set(validation.map(s=>s.identity.groupId))].sort();
  const trainingTurns=new Set(train.map(s=>identityKey(s.identity))).size;
  if(trainingTurns<30||trainingGroups.length<10||!validation.length)throw Error('RESIDUAL_INSUFFICIENT_SUPPORT');
  if(validationGroups.some(g=>trainingGroups.includes(g)))throw Error('RESIDUAL_SPLIT_OVERLAP');
  const versions=train[0]!.versions;
  if([...train,...validation].some(s=>JSON.stringify(s.versions)!==JSON.stringify(versions)))throw Error('RESIDUAL_MIXED_VERSIONS');
  const weights=turnWeights(train),vectors=train.map(s=>vectorize(s.features));
  const means:number[]=[],scales:number[]=[],minimum:(number|null)[]=[],maximum:(number|null)[]=[];
  for(let i=0;i<10;i++){
    let mass=0,total=0,low=Infinity,high=-Infinity;
    for(let j=0;j<train.length;j++)if(!featureMissing(vectors[j]!,i)){const x=vectors[j]![i]!,w=weights[j]!;mass+=w;total+=w*x;low=Math.min(low,x);high=Math.max(high,x);}
    const mean=mass?total/mass:0;means.push(mean);minimum.push(mass?low:null);maximum.push(mass?high:null);
    let variance=0;for(let j=0;j<train.length;j++)if(!featureMissing(vectors[j]!,i))variance+=weights[j]!*(vectors[j]![i]!-mean)**2;
    scales.push(mass&&high!==low?Math.sqrt(variance/mass):0);
  }
  const normalized=vectors.map(v=>[1,...normalizeVector(v,{means,scales})]);
  const targets=train.map(s=>Math.log1p(s.actualSeconds)-Math.log1p(s.features.rawSeconds));
  const weighted=targets.map((z,i)=>({z,w:weights[i]!})).sort((a,b)=>a.z-b.z);
  const half=weights.reduce((a,b)=>a+b,0)/2;let cumulative=0,logScale=weighted.at(-1)!.z;
  for(const item of weighted){cumulative+=item.w;if(cumulative>=half){logScale=item.z;break;}}
  let best:ResidualArtifact|undefined,bestLoss=Infinity;
  for(const lambda of [0.1,1,10,100] as const){
    const matrix=Array.from({length:11},()=>Array<number>(11).fill(0)),target=Array<number>(11).fill(0);
    for(let n=0;n<train.length;n++){const x=normalized[n]!,w=weights[n]!;for(let i=0;i<11;i++){
      target[i]=target[i]!+w*x[i]!*targets[n]!;for(let j=0;j<11;j++)matrix[i]![j]=matrix[i]![j]!+w*x[i]!*x[j]!;
    }}
    for(let i=1;i<11;i++)matrix[i]![i]=matrix[i]![i]!+lambda;
    const [intercept,...coefficients]=solve(matrix,target);
    const model=createArtifact({schemaVersion:1,featureVersion:'residual-prefix-v1',versions,trainingTurns,trainingGroups,validationGroups,
      means,scales,minimum,maximum,missingMasks:[...new Set(vectors.map(missingMask))].sort(),coefficients,intercept:intercept!,lambda,logScale});
    // Select hyperparameters on the same support that runtime inference accepts.
    // Unsupported validation rows remain coverage evidence, but cannot be
    // silently scored as predictions that production would never emit.
    const eligible=validation.map(sample=>({sample,shadow:predictResidual(model,sample.features,sample.versions)}))
      .filter((row):row is {sample:Sample;shadow:{seconds:number;reason:'predicted';artifactId:string}}=>row.shadow.reason==='predicted');
    if(!eligible.length)continue;
    const validationWeights=turnWeights(eligible.map(row=>row.sample));let loss=0;
    for(let i=0;i<eligible.length;i++){
      const row=eligible[i]!;
      loss+=validationWeights[i]!*Math.abs(Math.log1p(row.shadow.seconds)-Math.log1p(row.sample.actualSeconds));
    }
    if(!Number.isFinite(loss))throw Error('RESIDUAL_NON_FINITE_VALIDATION');
    if(loss<=bestLoss+1e-12){bestLoss=loss;best=model;}
  }
  if(!best)throw Error('RESIDUAL_VALIDATION_UNSUPPORTED');
  return best;
}
