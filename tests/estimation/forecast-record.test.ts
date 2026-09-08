import {expect, it} from 'vitest';
import {makeForecastRecord, type ForecastRecord} from '../../src/estimation/forecast-record.js';

const value: ForecastRecord = {schemaVersion:1,predictionId:1,generation:1,
  snapshotActiveSeconds:60,acceptedAt:90000,rawSeconds:600,shadowSeconds:null,
  paceReason:'missing_measurements',calibration:'uncalibrated',
  versions:{input:'facts-v1',prompt:'sha256-test',model:'test-model',algorithm:'pace-v1'}};

it('deep-clones and freezes an accepted forecast record',()=>{
  const input=structuredClone(value);
  const row=makeForecastRecord(input);
  input.versions.model='changed';
  expect(row.versions.model).toBe('test-model');
  expect(Object.isFrozen(row)).toBe(true);
  expect(Object.isFrozen(row.versions)).toBe(true);
});

it('rejects non-finite, unbounded, unsafe and extra forecast fields',()=>{
  for(const bad of [
    {...value,rawSeconds:Infinity},
    {...value,snapshotActiveSeconds:31_536_001},
    {...value,predictionId:Number.MAX_SAFE_INTEGER+1},
    {...value,versions:{...value.versions,model:'bad version'}},
    {...value,extra:'not allowed'},
    {...value,versions:{...value.versions,extra:'not allowed'}},
  ]) expect(()=>makeForecastRecord(bad as ForecastRecord)).toThrow();
});

it('freezes and validates the admitted measurement projection',()=>{
  const row=makeForecastRecord({...value,shadowSeconds:40,paceReason:'eligible',measurement:{
    source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3}});
  expect(row.measurement).toEqual({source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3});
  expect(Object.isFrozen(row.measurement)).toBe(true);
  for(const bad of [
    {...value,shadowSeconds:40,paceReason:'eligible',measurement:{source:'other'}},
    {...value,shadowSeconds:40,paceReason:'eligible',measurement:{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:2}},
    {...value,shadowSeconds:null,paceReason:'missing_measurements',measurement:{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3}},
    {...value,shadowSeconds:40,paceReason:'missing_measurements',measurement:{source:'vitest_json',clock:'tool_execution',remainingUnitsProvenance:'model_hypothesis',sampleCount:3}},
  ]) expect(()=>makeForecastRecord(bad as ForecastRecord)).toThrow();
});
