import {expect,it} from 'vitest';
import {createSessionAccountReuseIssuer} from '../../src/estimation/session-account-reuse.js';

const signal=()=>new AbortController().signal;

it('issues a one-use proof bounded by the original clocks and expiry',async()=>{
  let wall=1000,mono=20;
  const issuer=createSessionAccountReuseIssuer({now:()=>wall,monotonicNow:()=>mono});
  const reuse=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:301000,validateLocal:async()=>true});

  const proof=await reuse.claim(signal());
  expect(proof?.valid()).toBe(true);
  expect(await reuse.claim(signal())).toBeNull();

  wall=31000;mono=21;
  expect(proof?.valid()).toBe(false);
});

it('rejects rollback, non-finite clocks, and the original evidence deadline',async()=>{
  let wall=1000,mono=20;
  const issuer=createSessionAccountReuseIssuer({now:()=>wall,monotonicNow:()=>mono});
  const reuse=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:2000,validateLocal:async()=>true});
  const proof=await reuse.claim(signal());
  expect(proof).not.toBeNull();

  wall=999;expect(proof!.valid()).toBe(false);

  wall=1000;mono=20;
  const invalid=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:2000,validateLocal:async()=>true});
  wall=Number.NaN;
  expect(await invalid.claim(signal())).toBeNull();

  wall=2000;mono=1020;
  expect(await issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:2000,validateLocal:async()=>true}).claim(signal())).toBeNull();
});

it('consumes the claim before asynchronous validation and aborts fail closed',async()=>{
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  let entered=0;
  const issuer=createSessionAccountReuseIssuer({now:()=>1000,monotonicNow:()=>20});
  const reuse=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:301000,validateLocal:async(s)=>{
    entered++;
    await waiting;
    return !s.aborted;
  }});
  const controller=new AbortController();
  const first=reuse.claim(controller.signal);
  expect(await reuse.claim(signal())).toBeNull();
  expect(entered).toBe(1);
  controller.abort();release();
  expect(await first).toBeNull();
});

it('invalidates a pending claim and any proof when the issuer generation changes',async()=>{
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const issuer=createSessionAccountReuseIssuer({now:()=>1000,monotonicNow:()=>20});
  const reuse=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:301000,validateLocal:async()=>{await waiting;return true;}});
  const claim=reuse.claim(signal());
  issuer.invalidate();
  release();
  expect(await claim).toBeNull();

  const fresh=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:301000,validateLocal:async()=>true});
  const proof=await fresh.claim(signal());
  expect(proof?.valid()).toBe(true);
  issuer.invalidate();
  expect(proof?.valid()).toBe(false);
});

it('permanently invalidates after local validation fails',async()=>{
  const issuer=createSessionAccountReuseIssuer({now:()=>1000,monotonicNow:()=>20});
  const reuse=issuer.issue({observedAt:1000,observedMonotonic:20,expiresAt:301000,validateLocal:async()=>false});
  expect(await reuse.claim(signal())).toBeNull();
  expect(await reuse.claim(signal())).toBeNull();
});
