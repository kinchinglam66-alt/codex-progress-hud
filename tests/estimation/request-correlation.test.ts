import {describe,it,expect} from 'vitest';
import {currentRequestCorrelation,requestCorrelation,withRequestCorrelation,projectRequestCorrelation,correlatedPreparationSignal} from '../../src/estimation/request-correlation.js';

describe('local request correlation',()=>{
  it('preserves one flight across fresh preparation signals while isolating concurrent flights',async()=>{
    const flight=new AbortController(),other=new AbortController(),revoke=new AbortController();
    const first=correlatedPreparationSignal(flight.signal,revoke.signal);
    const second=correlatedPreparationSignal(flight.signal,revoke.signal);
    expect(first).not.toBe(second);
    for(const signal of [first,second,flight.signal])
      await withRequestCorrelation(signal,async()=>{await Promise.resolve();expect(currentRequestCorrelation()).toBe(requestCorrelation(flight.signal));});
    expect(requestCorrelation(correlatedPreparationSignal(other.signal,revoke.signal))).not.toBe(requestCorrelation(first));
    expect(currentRequestCorrelation()).toBeUndefined();
  });
  it.each(['flight','revocation'] as const)('preserves %s cancellation and reason',kind=>{
    const flight=new AbortController(),revoke=new AbortController();
    const signal=correlatedPreparationSignal(flight.signal,revoke.signal),reason=Error('synthetic cancellation');
    (kind==='flight'?flight:revoke).abort(reason);
    expect(signal.aborted).toBe(true);expect(signal.reason).toBe(reason);
    expect(correlatedPreparationSignal(flight.signal,revoke.signal).reason).toBe(reason);
  });
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
