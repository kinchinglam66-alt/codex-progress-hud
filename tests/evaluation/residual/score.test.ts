import {expect,it} from 'vitest';
import {scoreResidual} from '../../../src/evaluation/residual/score.js';
import {trainResidual} from '../../../src/evaluation/residual/train.js';
import {samples} from './fixtures.js';
it('reports paired errors at request and delivery with independent-group coverage',()=>{
  const model=trainResidual(samples(),samples(100,10)),report=scoreResidual(samples(200,10),model);
  expect(report.metrics.request.raw.maeSeconds).toBe(61);
  expect(report.metrics.request.raw.biasSeconds).toBe(-61);
  expect(report.metrics.request.residual.maeSeconds).toBeCloseTo(0,8);
  expect(report.metrics.delivery.raw.maeSeconds).toBe(61);
  expect(report.coverage.predicted).toBe(10);expect(report.insufficientEvidence).toBe(false);
});
it('does not score its own training/validation groups as unseen tests',()=>{
  const model=trainResidual(samples(),samples(100,10));
  expect(()=>scoreResidual(samples(),model)).toThrow();expect(()=>scoreResidual(samples(100,1),model)).toThrow();
});
it('reports missing shadow coverage rather than selecting only good predictions',()=>{
  const model=trainResidual(samples(),samples(100,10)),test=samples(200,10);test[0]!.features.rawSeconds=600;
  const report=scoreResidual(test,model);expect(report.coverage).toMatchObject({eligible:10,predicted:9});
  expect(report.fallbacks.out_of_range).toBe(1);
});
it('counts unavailable prefixes and missing terminals without manufacturing labels',()=>{
  const model=trainResidual(samples(),samples(100,10)),test=samples(200,1);
  const attempts=[{identity:test[0]!.identity,predictionId:test[0]!.predictionId,reason:'eligible' as const},
    {identity:samples(201,1)[0]!.identity,predictionId:1,reason:'prefix_unavailable' as const},
    {identity:samples(202,1)[0]!.identity,predictionId:1,reason:'missing_terminal' as const}];
  expect(scoreResidual(test,model,attempts).coverage).toMatchObject({eligible:3,predicted:1,fraction:1/3});
  expect(()=>scoreResidual(test,model,[{...attempts[0]!,reason:'prefix_unavailable'}])).toThrow('RESIDUAL_SCORE_ATTEMPTS');
  expect(()=>scoreResidual([],model,[attempts[0]!])).toThrow('RESIDUAL_SCORE_ATTEMPTS');
  expect(()=>scoreResidual([...test,...test],model,[attempts[0]!])).toThrow('RESIDUAL_SCORE_ATTEMPTS');
});
