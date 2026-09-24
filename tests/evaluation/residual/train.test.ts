import {expect,it} from 'vitest';
import {trainResidual} from '../../../src/evaluation/residual/train.js';
import {predictResidual,parseArtifact} from '../../../src/estimation/residual/predict.js';
import {samples,versions} from './fixtures.js';
it('learns a constant log bias with an unpenalized intercept',()=>{
  const model=trainResidual(samples(),samples(100,10));
  expect(predictResidual(model,samples()[0]!.features,versions).seconds).toBeCloseTo(121,8);
  expect(model.intercept).toBeCloseTo(Math.log(2),8);
  expect(model.lambda).toBe(100);
  expect(parseArtifact(JSON.parse(JSON.stringify(model)))).toEqual(model);
  expect(trainResidual(samples(),samples(100,10))).toEqual(model);
});
it('refuses inadequate support, cross-group leakage and mixed versions',()=>{
  expect(()=>trainResidual(samples(1,29),samples(100,10))).toThrow();
  expect(()=>trainResidual(samples(),samples(1,1))).toThrow();
  expect(()=>trainResidual([...samples(),{...samples(50,1)[0]!,versions:{...versions,model:'different'}}],samples(100,10))).toThrow();
});
it('does not let repeated snapshots overweight a turn',()=>{
  const data=samples();data[0]!.actualSeconds=1000;
  const first=trainResidual(data,samples(100,10));
  const second=trainResidual([...data,...Array.from({length:10},()=>({...data[0]!,predictionId:2}))],samples(100,10));
  expect(second.intercept).toBeCloseTo(first.intercept,10);
});
it('refuses validation rows that runtime inference would entirely abstain from',()=>{
  const unseenMask=samples(100,10).map(sample=>({...sample,features:{...sample.features,elapsedActiveSeconds:10}}));
  expect(()=>trainResidual(samples(),unseenMask)).toThrow('RESIDUAL_VALIDATION_UNSUPPORTED');
  const outsideRange=samples(100,10).map(sample=>({...sample,features:{...sample.features,rawSeconds:600}}));
  expect(()=>trainResidual(samples(),outsideRange)).toThrow('RESIDUAL_VALIDATION_UNSUPPORTED');
});
