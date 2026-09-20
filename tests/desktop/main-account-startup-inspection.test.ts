import {expect,it,vi} from 'vitest';
import {createMainStartupInspection} from '../../src/desktop/main-account-startup-inspection.js';
const snapshot=()=>({accountLabel:'synthetic',evidence:{accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64),observedAt:0,expiresAt:1000}});
it('consumes one startup handoff without extending attestation expiry or following later snapshot mutations',async()=>{
 const original=snapshot(),inspect=vi.fn(async()=>({accountFingerprint:'a'.repeat(64),expiresAt:9999}));
 const handoff=createMainStartupInspection(original,{inspect});original.evidence.expiresAt=5000;
 expect((await handoff(new AbortController().signal)).evidence.expiresAt).toBe(1000);
 await expect(handoff(new AbortController().signal)).rejects.toThrow('OBSERVER_STARTUP_INSPECTION_CONSUMED');
 expect(inspect).toHaveBeenCalledTimes(1);
});
it.each(['changed','cancelled','failed'] as const)('rejects a %s local identity check without reusable old proof',async mode=>{
 const controller=new AbortController(),inspect=vi.fn(async()=>{
  if(mode==='failed')throw Error('MAIN_ACCOUNT_UNAVAILABLE');
  if(mode==='cancelled')controller.abort();
  return {accountFingerprint:mode==='changed'?'d'.repeat(64):'a'.repeat(64),expiresAt:9999};
 });
 const handoff=createMainStartupInspection(snapshot(),{inspect});
 await expect(handoff(controller.signal)).rejects.toThrow();
 await expect(handoff(new AbortController().signal)).rejects.toThrow('OBSERVER_STARTUP_INSPECTION_CONSUMED');
 expect(inspect).toHaveBeenCalledTimes(1);
});
