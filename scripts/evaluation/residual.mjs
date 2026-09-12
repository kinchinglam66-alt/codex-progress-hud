import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readResidualSegments} from '../../dist/estimation/residual/recorder.js';
import {buildDataset,splitSamples,attemptSchema} from '../../dist/evaluation/residual/dataset.js';
import {trainResidual} from '../../dist/evaluation/residual/train.js';
import {parseArtifact} from '../../dist/estimation/residual/predict.js';
import {scoreResidual} from '../../dist/evaluation/residual/score.js';

async function json(path,max=128*1024*1024){if((await stat(path)).size>max)throw Error('RESIDUAL_INPUT_TOO_LARGE');return JSON.parse(await readFile(path,'utf8'));}
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
try{
  const [action,...args]=process.argv.slice(2),options={};
  const allowed=action==='dataset'?['input','output','group-map']:action==='train'?['dataset','manifest','output']:action==='score'?['dataset','manifest','artifact','output']:[];
  if(!allowed.length||args.length%2)throw Error('RESIDUAL_ARGUMENTS');
  for(let i=0;i<args.length;i+=2){const name=args[i].slice(2);if(!args[i].startsWith('--')||!allowed.includes(name)||name in options)throw Error('RESIDUAL_ARGUMENTS');options[name]=resolve(args[i+1]);}
  const required=allowed.filter(n=>n!=='group-map');if(required.some(n=>!options[n]))throw Error('RESIDUAL_ARGUMENTS');
  if(action==='dataset'){
    const recorded=await readResidualSegments(options.input),dataset=buildDataset(recorded.records);
    let grouping='opaque_conversation';
    if(options['group-map']){
      const mapping=await json(options['group-map'],1024*1024);
      if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw Error('RESIDUAL_GROUP_MAP');
      for(const [key,value] of Object.entries(mapping))if(!/^[a-f0-9]{64}$/u.test(key)||typeof value!=='string'||value.length<1||value.length>256)throw Error('RESIDUAL_GROUP_MAP');
      dataset.samples=dataset.samples.map(s=>({...s,identity:{...s.identity,groupId:mapping[s.identity.groupId]===undefined?s.identity.groupId:
        createHash('sha256').update(JSON.stringify(['benchmark-problem',mapping[s.identity.groupId]])).digest('hex')}}));grouping='explicit_problem_map';
      dataset.attempts=dataset.attempts.map(s=>({...s,identity:{...s.identity,groupId:mapping[s.identity.groupId]===undefined?s.identity.groupId:
        createHash('sha256').update(JSON.stringify(['benchmark-problem',mapping[s.identity.groupId]])).digest('hex')}}));
    }
    const manifest={train:[],validation:[],test:[]};
    for(const group of [...new Set(dataset.attempts.map(s=>s.identity.groupId))].sort()){
      const bucket=parseInt(createHash('sha256').update(`residual-split-v1:${group}`).digest('hex').slice(0,8),16)%10;
      manifest[bucket<6?'train':bucket<8?'validation':'test'].push(group);
    }
    await mkdir(options.output); // Exclusive directory reservation prevents evidence overwrite.
    await save(resolve(options.output,'dataset.json'),{schemaVersion:1,grouping,samples:dataset.samples,attempts:dataset.attempts,
      excluded:{dataset:dataset.excluded,recording:recorded.excluded}});
    await save(resolve(options.output,'manifest.json'),manifest);
  }else{
    const dataset=await json(options.dataset);if(dataset.schemaVersion!==1||!Array.isArray(dataset.samples))throw Error('RESIDUAL_DATASET');
    const manifest=await json(options.manifest,1024*1024),split=splitSamples(dataset.samples,manifest);
    if(dataset.attempts!==undefined){
      if(!Array.isArray(dataset.attempts))throw Error('RESIDUAL_DATASET');
      dataset.attempts=dataset.attempts.map(a=>attemptSchema.parse(a));
      const assigned=new Set([...manifest.train,...manifest.validation,...manifest.test]);
      if(dataset.attempts.some(a=>!assigned.has(a.identity.groupId)))throw Error('RESIDUAL_SPLIT_UNASSIGNED');
    }
    if(action==='train')await save(options.output,trainResidual(split.train,split.validation));
    else await save(options.output,{...scoreResidual(split.test,parseArtifact(await json(options.artifact,1024*1024)),
      dataset.attempts?.filter(a=>manifest.test.includes(a.identity.groupId))),
      grouping:dataset.grouping,excluded:dataset.excluded});
  }
  process.stdout.write('RESIDUAL_LOCAL_COMMAND_COMPLETE\n');
}catch(error){
  // Never print input contents, credentials or stack arguments.
  const message=error instanceof Error&&/^RESIDUAL_[A-Z_]+$/u.test(error.message)?error.message:'RESIDUAL_COMMAND_FAILED';
  process.stderr.write(message+'\n');process.exitCode=1;
}
