import {describe,it,expect} from 'vitest';
import {currentRequestCorrelation,requestCorrelation,withRequestCorrelation,projectRequestCorrelation} from '../../src/estimation/request-correlation.js';

describe('local request correlation',()=>{
  it('keeps a flight ID across preparation and dispatch without serializing input',async()=>{
    const signal=new AbortController().signal,id=requestCorrelation(signal);
    for(let i=0;i<2;i++)await withRequestCorrelation(signal,async()=>{
      await Promise.resolve();expect(currentRequestCorrelation()).toBe(id);
    });
    expect(currentRequestCorrelation()).toBeUndefined();
    expect(projectRequestCorrelation(id)).toBe(id);
  });
  it('isolates concurrent requests and new signals after restart',async()=>{
    const signals=[new AbortController().signal,new AbortController().signal];
    const ids=await Promise.all(signals.map(s=>withRequestCorrelation(s,async()=>{await Promise.resolve();return currentRequestCorrelation();})));
    expect(new Set(ids).size).toBe(2);
    expect(requestCorrelation(new AbortController().signal)).not.toBe(ids[0]);
  });
  it('does not leak request context after failures or accept arbitrary identity text',async()=>{
    await expect(withRequestCorrelation(new AbortController().signal,async()=>{throw Error('before dispatch');})).rejects.toThrow('before dispatch');
    expect(currentRequestCorrelation()).toBeUndefined();
    expect(projectRequestCorrelation('private conversation')).toBeUndefined();
    expect(projectRequestCorrelation(undefined)).toBeUndefined();
  });
});
