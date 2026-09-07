import {expect,it} from 'vitest';
import {transitionValue} from '../../src/ui/eta-transition.js';

it('converges to the aging target without extending its countdown',()=>{
  const transition={startedActiveSeconds:10,offsetSeconds:-4};
  expect(transitionValue(104,10,transition)).toBe(100);
  expect(transitionValue(103,11,transition)).toBe(101);
  expect(transitionValue(102,12,transition)).toBe(102);
  expect(transitionValue(101,13,transition)).toBe(101);
});
it('supports downward transitions and never makes negative countdowns',()=>{
  expect(transitionValue(96,10,{startedActiveSeconds:10,offsetSeconds:4})).toBe(100);
  expect(transitionValue(95,11,{startedActiveSeconds:10,offsetSeconds:4})).toBe(97);
  expect(transitionValue(0,10,{startedActiveSeconds:10,offsetSeconds:-4})).toBe(0);
});
it('rejects malformed clocks instead of emitting nonfinite display values',()=>{
  expect(()=>transitionValue(NaN,10,null)).toThrow();
  expect(()=>transitionValue(10,Infinity,null)).toThrow();
  expect(()=>transitionValue(10,1,{startedActiveSeconds:0,offsetSeconds:Infinity})).toThrow();
});
