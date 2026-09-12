import {expect,it} from 'vitest';
import {parseResearchRecord} from '../../../src/estimation/residual/contract.js';

export const forecast = () => ({schemaVersion:1,kind:'forecast',sequence:1,
  prefix:{identity:{groupId:'a'.repeat(64),turnId:'b'.repeat(64),runId:'c'.repeat(32),sourceEpoch:1,generation:1},
    predictionId:1,watermark:'d'.repeat(64),anchorActiveSeconds:10,
    features:{elapsedActiveSeconds:null,observedActiveSeconds:10,oldestActionActiveSeconds:null,
      outstandingActions:1,completedActions:2,failedActions:1,prefixComplete:false}},
  rawSeconds:60,deliveredActiveSeconds:12,
  versions:{input:'i1',prompt:'p1',model:'m1',algorithm:'a1'},
  shadow:{seconds:null,reason:'no_artifact',artifactId:null}});

it('isolates persisted forecast data from later mutation',()=>{
  const input=forecast();const row=parseResearchRecord(input);
  input.prefix.features.completedActions=999;
  expect(row.kind).toBe('forecast');
  if(row.kind!=='forecast')throw Error('wrong kind');
  expect(row.prefix.features.completedActions).toBe(2);
  expect(Object.isFrozen(row.prefix.features)).toBe(true);
  expect(Object.isFrozen(row.versions)).toBe(true);
});
it('rejects text injection and invalid numeric/identity fields',()=>{
  for(const patch of [{rawSeconds:Infinity},{rawSeconds:-1},{sequence:1.5},{sequence:Number.MAX_SAFE_INTEGER+1},{text:'secret'}])
    expect(()=>parseResearchRecord({...forecast(),...patch})).toThrow();
  const bad=forecast();bad.prefix.identity.groupId='private-title';
  expect(()=>parseResearchRecord(bad)).toThrow();
  expect(()=>parseResearchRecord({...forecast(),prefix:{...forecast().prefix,features:{...forecast().prefix.features,command:'secret'}}})).toThrow();
});
it('requires consistent shadow evidence and permits a zero ETA',()=>{
  expect(parseResearchRecord({...forecast(),rawSeconds:0})).toMatchObject({rawSeconds:0});
  expect(()=>parseResearchRecord({...forecast(),shadow:{seconds:2,reason:'no_artifact',artifactId:null}})).toThrow();
  expect(()=>parseResearchRecord({...forecast(),shadow:{seconds:null,reason:'predicted',artifactId:null}})).toThrow();
});
it('validates source-backed terminal and correction shapes',()=>{
  const identity=forecast().prefix.identity;
  expect(parseResearchRecord({schemaVersion:1,kind:'terminal',sequence:2,identity,endActiveSeconds:70,
    outcome:'normal_end',evidenceId:'e'.repeat(64),clockReliable:true})).toMatchObject({kind:'terminal',endActiveSeconds:70});
  expect(()=>parseResearchRecord({schemaVersion:1,kind:'terminal',sequence:2,identity,endActiveSeconds:70,
    outcome:'normal_end',evidenceId:'e'.repeat(64),clockReliable:false})).toThrow();
  expect(parseResearchRecord({schemaVersion:1,kind:'invalidate',sequence:3,identity,reason:'clock_unknown'})).toMatchObject({kind:'invalidate'});
});
