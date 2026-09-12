import {expect,it} from 'vitest';
import {buildDataset,splitSamples} from '../../../src/evaluation/residual/dataset.js';
import {parseResearchRecord,type ResearchRecord} from '../../../src/estimation/residual/contract.js';
const identity={groupId:'a'.repeat(64),turnId:'b'.repeat(64),runId:'c'.repeat(32),sourceEpoch:1,generation:1};
function rows():ResearchRecord[]{return [parseResearchRecord({schemaVersion:1,kind:'forecast',sequence:1,
  prefix:{identity,predictionId:1,watermark:'d'.repeat(64),anchorActiveSeconds:30,features:{elapsedActiveSeconds:null,
    observedActiveSeconds:30,oldestActionActiveSeconds:0,outstandingActions:0,completedActions:2,failedActions:0,prefixComplete:false}},
  rawSeconds:60,deliveredActiveSeconds:35,versions:{input:'i',prompt:'p',model:'m',algorithm:'a'},shadow:{seconds:null,reason:'no_artifact',artifactId:null}}),
  parseResearchRecord({schemaVersion:1,kind:'terminal',sequence:2,identity,endActiveSeconds:70,outcome:'normal_end',evidenceId:'e'.repeat(64),clockReliable:true})];}
it('joins active anchors, not wall time, and keeps raw ETA as a feature',()=>{
  expect(buildDataset(rows()).samples[0]).toMatchObject({actualSeconds:40,deliveryLagSeconds:5,features:{rawSeconds:60,elapsedActiveSeconds:null}});
});
it('does not double count repeats and invalidates conflicting forecasts',()=>{
  const input=rows();expect(buildDataset([...input,...input]).samples).toHaveLength(1);
  expect(buildDataset([...input,{...input[0]!,rawSeconds:90} as ResearchRecord]).samples).toHaveLength(0);
});
it('excludes missing, interrupted and corrected labels',()=>{
  expect(buildDataset(rows().slice(0,1)).excluded.missing_terminal).toBe(1);
  const input=rows(),terminal=input[1]!;
  expect(buildDataset([input[0]!,{...terminal,outcome:'interrupted'} as ResearchRecord]).samples).toEqual([]);
  expect(buildDataset([...input,parseResearchRecord({schemaVersion:1,kind:'invalidate',sequence:3,identity,reason:'clock_unknown'})]).samples).toEqual([]);
});
it('rejects delivery after completion instead of turning it into a zero error',()=>{
  const input=rows();expect(buildDataset([{...input[0]!,deliveredActiveSeconds:71} as ResearchRecord,input[1]!]).excluded.invalid_clock).toBe(1);
});
it('keeps all turns in a group together and rejects overlapping or missing assignments',()=>{
  const samples=buildDataset(rows()).samples,g=identity.groupId;
  expect(()=>splitSamples(samples,{train:[g],validation:[],test:[g]})).toThrow();
  expect(()=>splitSamples(samples,{train:[],validation:[],test:[]})).toThrow();
  expect(splitSamples(samples,{train:[g],validation:[],test:[]}).train).toHaveLength(1);
});
it('invalidates both identities when a run sequence is reused for a different identity',()=>{
  const input=rows(),other={...identity,turnId:'f'.repeat(64)};
  expect(buildDataset([...input,parseResearchRecord({schemaVersion:1,kind:'invalidate',sequence:1,identity:other,reason:'clock_unknown'})]).samples).toEqual([]);
});
