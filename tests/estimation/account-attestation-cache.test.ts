import {expect,it} from 'vitest';
import {createAccountAttestationCache,type AccountAttestationCacheValue} from '../../src/estimation/account-attestation-cache.js';

const signal=()=>new AbortController().signal;
const value=():AccountAttestationCacheValue=>({
  accountFingerprint:'a'.repeat(64),
  routeFingerprint:'b'.repeat(64),
  assetsFingerprint:'c'.repeat(64),
  invocation:{executable:'private',args:['metadata'],env:{},cwd:'private',input:''},
});

it('publishes one immutable entry and returns the original clocks without renewing its TTL',async()=>{
  let wall=1_000,mono=20;
  const cache=createAccountAttestationCache({now:()=>wall,monotonicNow:()=>mono});
  const original=value();
  expect(cache.publish({value:original,observedAt:wall,observedMonotonic:mono,expiresAt:301_000,binding:'account:a',metadata:'metadata:a'},cache.generation())).toBe(true);

  wall=1_100;mono=120;
  const first=await cache.acquire(signal(),async()=>true);
  expect(first).toMatchObject({observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'account:a',metadata:'metadata:a',value:original});
  expect(cache.diagnostics()).toMatchObject({candidateCount:1,hitCount:1,missCount:0,localGuardCount:1});

  wall=30_999;mono=30_019;
  expect(await cache.acquire(signal(),async()=>true)).not.toBeNull();
  wall=31_000;mono=30_020;
  expect(await cache.acquire(signal(),async()=>true)).toBeNull();
  expect(cache.diagnostics()).toMatchObject({candidateCount:3,hitCount:2,missCount:1,lastMissReason:'expired'});
});

it.each([
  ['wall-clock-rollback',999,20],
  ['monotonic-clock-rollback',1_000,19],
  ['nonfinite-clock',Number.NaN,20],
] as const)('rejects %s before local validation',async(reason,wall,mono)=>{
  let currentWall=1_000,currentMono=20;
  const cache=createAccountAttestationCache({now:()=>currentWall,monotonicNow:()=>currentMono});
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'binding',metadata:'metadata'},cache.generation())).toBe(true);
  currentWall=wall;currentMono=mono;
  let guards=0;
  expect(await cache.acquire(signal(),async()=>{guards++;return true;})).toBeNull();
  expect(guards).toBe(0);
  expect(cache.diagnostics().lastMissReason).toBe(reason);
});

it('rejects the thirty-second boundary and evidence already expired at publication',()=>{
  let wall=31_000,mono=30_020;
  const cache=createAccountAttestationCache({now:()=>wall,monotonicNow:()=>mono});
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'binding',metadata:'metadata'},cache.generation())).toBe(false);
  wall=1_000;mono=20;
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:1_000,binding:'binding',metadata:'metadata'},cache.generation())).toBe(false);
});

it('fences publication and invalidates a candidate while its local guard is pending',async()=>{
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  let wall=1_000,mono=20;
  const cache=createAccountAttestationCache({now:()=>wall,monotonicNow:()=>mono});
  const generation=cache.generation();
  const pending=cache.acquire(signal(),async()=>{await waiting;return true;});
  cache.invalidate('explicit');
  release();
  expect(await pending).toBeNull();
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'binding',metadata:'metadata'},generation)).toBe(false);
  expect(cache.diagnostics()).toMatchObject({lastMissReason:'generation-fenced'});
});

it('reports local guard failure and does not retain the failed entry',async()=>{
  const cache=createAccountAttestationCache({now:()=>1_000,monotonicNow:()=>20});
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'binding',metadata:'metadata'},cache.generation())).toBe(true);
  expect(await cache.acquire(signal(),async()=>false)).toBeNull();
  expect(cache.diagnostics()).toMatchObject({candidateCount:1,hitCount:0,missCount:1,localGuardCount:1,lastMissReason:'local-guard-failed'});
  expect(await cache.acquire(signal(),async()=>true)).toBeNull();
});

it('rejects a hit when local validation itself crosses the fixed TTL',async()=>{
  let wall=1_000,mono=20,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const cache=createAccountAttestationCache({now:()=>wall,monotonicNow:()=>mono});
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'binding',metadata:'metadata'},cache.generation())).toBe(true);
  const pending=cache.acquire(signal(),async()=>{wall=31_000;mono=30_020;release();return true;});
  expect(await pending).toBeNull();
  expect(cache.diagnostics()).toMatchObject({hitCount:0,missCount:1,lastMissReason:'expired'});
});

it('cancels a pending local guard and invalidates the candidate',async()=>{
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const cache=createAccountAttestationCache({now:()=>1_000,monotonicNow:()=>20});
  expect(cache.publish({value:value(),observedAt:1_000,observedMonotonic:20,expiresAt:301_000,binding:'binding',metadata:'metadata'},cache.generation())).toBe(true);
  const controller=new AbortController();
  const pending=cache.acquire(controller.signal,async(_value,signal)=>{await waiting;return !signal.aborted;});
  controller.abort();release();
  expect(await pending).toBeNull();
  expect(cache.diagnostics()).toMatchObject({localGuardCount:1,missCount:1,lastMissReason:'cancelled'});
});
