import {expect,it} from 'vitest';
import {vectorize} from '../../../src/estimation/residual/features.js';

const value={rawSeconds:0,elapsedActiveSeconds:null,observedActiveSeconds:0,
  oldestActionActiveSeconds:null,outstandingActions:1,completedActions:0,failedActions:0,prefixComplete:false};
it('preserves zero and unknown distinction in a stable vector',()=>{
  const vector=vectorize(value);
  expect(vector).toEqual([0,0,0,0,Math.log(2),0,0,1,1,0]);
  expect(Object.isFrozen(vector)).toBe(true);
  expect(vectorize({...value,elapsedActiveSeconds:0,oldestActionActiveSeconds:0})).toEqual([0,0,0,0,Math.log(2),0,0,0,0,0]);
});
it('rejects malformed features instead of masking them as missing',()=>{
  expect(()=>vectorize({...value,rawSeconds:NaN})).toThrow();
  expect(()=>vectorize({...value,outstandingActions:-1})).toThrow();
  expect(()=>vectorize({...value,failedActions:3})).toThrow();
});
