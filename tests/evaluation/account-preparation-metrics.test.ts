import {expect,it} from 'vitest';
import {createAccountPreparationMetrics,readAccountCacheDiagnostic} from '../../src/evaluation/account-preparation-metrics.js';
import {createSessionAccountReuseIssuer} from '../../src/estimation/session-account-reuse.js';

it('separates full preparation from successful one-use claim and final validation',async()=>{
  let clock=0;
  const metrics=createAccountPreparationMetrics(()=>clock);
  const issuer=createSessionAccountReuseIssuer({now:()=>clock,monotonicNow:()=>clock});
  const signal=new AbortController().signal;
  const prepared=await metrics.prepare(async()=>{
    clock+=5000;
    return {sentinel:'preserved',reuse:issuer.issue({observedAt:0,observedMonotonic:0,expiresAt:300000,
      validateLocal:async()=>{clock+=1000;return true;}})};
  });
  expect(prepared.sentinel).toBe('preserved');
  const proof=await prepared.reuse!.claim(signal);
  expect(await proof!.validate(signal)).toBe(true);
  expect(proof!.valid()).toBe(true);
  expect(await prepared.reuse!.claim(signal)).toBeNull();
  expect(metrics.snapshot()).toEqual({prepareCalls:1,prepareSucceeded:1,prepareMs:5000,reuseIssued:1,
    claimCalls:2,claimHits:1,claimMs:1000,validateCalls:1,validatePassed:1,validateMs:1000,timingUnavailable:0});
  prepared.reuse!.invalidate();
  expect(proof!.valid()).toBe(false);
});

it('keeps failed full checks distinct from reuse misses and does not retry',async()=>{
  let clock=0,calls=0;
  const metrics=createAccountPreparationMetrics(()=>clock),failure=Error('original');
  await expect(metrics.prepare(async()=>{calls++;clock+=25;throw failure;})).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(metrics.snapshot()).toMatchObject({prepareCalls:1,prepareSucceeded:0,prepareMs:25,claimCalls:0});
});

it('records a real expired proof as a miss without reviving it',async()=>{
  let clock=0;
  const metrics=createAccountPreparationMetrics(()=>clock);
  const issuer=createSessionAccountReuseIssuer({now:()=>clock,monotonicNow:()=>clock});
  const prepared=await metrics.prepare(async()=>({reuse:issuer.issue({observedAt:0,observedMonotonic:0,
    expiresAt:300000,validateLocal:async()=>true})}));
  clock=30000;
  expect(await prepared.reuse!.claim(new AbortController().signal)).toBeNull();
  expect(metrics.snapshot()).toMatchObject({claimCalls:1,claimHits:0,validateCalls:0});
});

it('does not let a broken diagnostics clock change account or proof outcomes',async()=>{
  const metrics=createAccountPreparationMetrics(()=>{throw Error('clock failure');});
  const issuer=createSessionAccountReuseIssuer({now:()=>0,monotonicNow:()=>0});
  const prepared=await metrics.prepare(async()=>({reuse:issuer.issue({observedAt:0,observedMonotonic:0,
    expiresAt:300000,validateLocal:async()=>true})}));
  const proof=await prepared.reuse!.claim(new AbortController().signal);
  expect(await proof!.validate(new AbortController().signal)).toBe(true);
  expect(metrics.snapshot()).toMatchObject({prepareSucceeded:1,claimHits:1,validatePassed:1,timingUnavailable:3});
});

it('returns isolated numeric snapshots without serializing the prepared identity',async()=>{
  const metrics=createAccountPreparationMetrics(()=>0);
  const before=metrics.snapshot();
  const prepared=await metrics.prepare(async()=>({accountLabel:'private',reuse:undefined}));
  expect(prepared.accountLabel).toBe('private');
  expect(before.prepareCalls).toBe(0);
  const after=metrics.snapshot();after.prepareCalls=900;
  expect(metrics.snapshot().prepareCalls).toBe(1);
  expect(JSON.stringify(metrics.snapshot())).not.toContain('private');
});

it('preserves final guard rejection and permanent invalidation after a metadata change',async()=>{
  let checks=0;
  const metrics=createAccountPreparationMetrics(()=>0);
  const issuer=createSessionAccountReuseIssuer({now:()=>0,monotonicNow:()=>0});
  const prepared=await metrics.prepare(async()=>({reuse:issuer.issue({observedAt:0,observedMonotonic:0,
    expiresAt:300000,validateLocal:async()=>++checks===1})}));
  const signal=new AbortController().signal,proof=await prepared.reuse!.claim(signal);
  expect(await proof!.validate(signal)).toBe(false);
  expect(proof!.valid()).toBe(false);
  expect(await prepared.reuse!.claim(signal)).toBeNull();
  expect(metrics.snapshot()).toMatchObject({claimCalls:2,claimHits:1,validateCalls:1,validatePassed:0});
});

it('records a backwards timing clock as unavailable without changing successful preparation',async()=>{
  let time=10;
  const metrics=createAccountPreparationMetrics(()=>time);
  const prepared=await metrics.prepare(async()=>{time=5;return {reuse:undefined,value:'ok'};});
  expect(prepared.value).toBe('ok');
  expect(metrics.snapshot()).toMatchObject({prepareSucceeded:1,prepareMs:0,timingUnavailable:1});
});

it('copies only bounded numeric cache diagnostics and enumerated reasons, not cached evidence',()=>{
 const value={candidateCount:1,hitCount:1,missCount:2,localGuardCount:1,localGuardMs:999.5,lastMissReason:'explicit',
  accountLabel:'DO_NOT_SERIALIZE',invocation:{env:{TOKEN:'PRIVATE'}}};
 const copy=readAccountCacheDiagnostic(value);
 expect(copy).toEqual({candidateCount:1,hitCount:1,missCount:2,localGuardCount:1,localGuardMs:999.5,lastMissReason:'explicit'});
 value.hitCount=900;expect(copy!.hitCount).toBe(1);
 expect(JSON.stringify(copy)).not.toMatch(/DO_NOT_SERIALIZE|PRIVATE|TOKEN/);
 expect(readAccountCacheDiagnostic({...value,lastMissReason:'SECRET_REMOTE_ERROR'})).toBeNull();
 expect(readAccountCacheDiagnostic({...value,localGuardMs:NaN})).toBeNull();
 expect(readAccountCacheDiagnostic({...value,hitCount:-1})).toBeNull();
 expect(readAccountCacheDiagnostic({get candidateCount(){throw Error('private');}})).toBeNull();
});
