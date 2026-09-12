import {expect,it} from 'vitest';
import {requestFits,type ContextCapacity,type RequestSizer} from '../../src/estimation/context-capacity.js';

const sizer:RequestSizer={kind:'tokenizer',count:(serialized)=>serialized.length};
const capacity:ContextCapacity={contextTokens:10,outputReserveTokens:5,requestBytes:null,source:'configured'};

it('accepts a request at the available token boundary and rejects one over it',()=>{
  expect(requestFits('12345',capacity,sizer)).toBe(true);
  expect(requestFits('123456',capacity,sizer)).toBe(false);
});

it('checks UTF-8 byte overflow independently from token capacity',()=>{
  const byteCapacity:ContextCapacity={...capacity,requestBytes:4};
  expect(requestFits('éé',byteCapacity,{kind:'tokenizer',count:()=>1})).toBe(true);
  expect(requestFits('ééé',byteCapacity,{kind:'tokenizer',count:()=>1})).toBe(false);
});

it('allows a zero-sized request when capacity is valid',()=>{
  expect(requestFits('',capacity,sizer)).toBe(true);
});

it('rejects invalid capacity values instead of choosing a default',()=>{
  const invalidCapacities:ContextCapacity[]=[
    {...capacity,contextTokens:0},
    {...capacity,contextTokens:-1},
    {...capacity,contextTokens:1.5},
    {...capacity,contextTokens:Number.NaN},
    {...capacity,contextTokens:Number.POSITIVE_INFINITY},
    {...capacity,contextTokens:Number.MAX_SAFE_INTEGER+1},
    {...capacity,outputReserveTokens:-1},
    {...capacity,outputReserveTokens:10},
    {...capacity,outputReserveTokens:1.5},
    {...capacity,outputReserveTokens:Number.NaN},
    {...capacity,requestBytes:0},
    {...capacity,requestBytes:-1},
    {...capacity,requestBytes:1.5},
    {...capacity,requestBytes:Number.NaN},
    {...capacity,source:'unknown' as 'configured'},
  ];
  for(const invalid of invalidCapacities)expect(()=>requestFits('ok',invalid,sizer)).toThrow();
});

it('rejects malformed requests and sizer results',()=>{
  expect(()=>requestFits(123 as unknown as string,capacity,sizer)).toThrow();
  const invalidSizers:RequestSizer[]=[
    {kind:'unsupported' as 'tokenizer',count:()=>1},
    {kind:'tokenizer',count:()=>-1},
    {kind:'tokenizer',count:()=>1.5},
    {kind:'tokenizer',count:()=>Number.NaN},
    {kind:'tokenizer',count:()=>Number.POSITIVE_INFINITY},
    {kind:'tokenizer',count:()=>Number.MAX_SAFE_INTEGER+1},
  ];
  for(const invalidSizer of invalidSizers)expect(()=>requestFits('ok',capacity,invalidSizer)).toThrow();
});

it('does not swallow a sizing counter failure',()=>{
  const failure=new Error('counter unavailable');
  expect(()=>requestFits('ok',capacity,{kind:'conservative',count:()=>{throw failure;}})).toThrow(failure);
});
