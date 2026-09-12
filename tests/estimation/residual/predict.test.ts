import {expect,it} from 'vitest';
import {trainResidual} from '../../../src/evaluation/residual/train.js';
import {predictResidual,parseArtifact} from '../../../src/estimation/residual/predict.js';
import {samples,versions} from '../../evaluation/residual/fixtures.js';
it('falls back without an artifact or across unsupported versions/ranges',()=>{
  const model=trainResidual(samples(),samples(100,10)),features=samples()[0]!.features;
  expect(predictResidual(null,features,versions).reason).toBe('no_artifact');
  expect(predictResidual(model,features,{...versions,model:'other'}).reason).toBe('version_mismatch');
  expect(predictResidual(model,{...features,rawSeconds:600},versions).reason).toBe('out_of_range');
  expect(predictResidual(model,{...features,elapsedActiveSeconds:10},versions).reason).toBe('unseen_missingness');
});
it('rejects tampered coefficients and extra payloads',()=>{
  const model=trainResidual(samples(),samples(100,10));
  expect(()=>parseArtifact({...model,intercept:999})).toThrow();
  expect(()=>parseArtifact({...model,text:'secret'})).toThrow();
  expect(()=>parseArtifact({...model,coefficients:[Infinity]})).toThrow();
});
