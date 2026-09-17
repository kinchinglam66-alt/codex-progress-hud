import {expect,it} from 'vitest';
import {createNativeRetentionPermit,nativeRetentionValid} from '../../src/estimation/native-owner-retention.js';
const state={conversationKey:'one',turnKey:'turn',generation:1,running:true};
it.each([[300000,360000],[600000,660000],[900000,960000],[1800000,1860000],[9000000,1860000],[0,60000]])(
 'bounds retention for ordinary eligibility %i', (nextOrdinaryAtMs,deadlineMs)=>{
  expect(createNativeRetentionPermit({...state,idleStartedAtMs:0,nextOrdinaryAtMs})).toEqual({
   conversationKey:'one',turnKey:'turn',generation:1,idleStartedAtMs:0,deadlineMs});
 });
it.each([NaN,Infinity,-1])('rejects unusable idle clock %s',idleStartedAtMs=>{
 expect(createNativeRetentionPermit({...state,idleStartedAtMs,nextOrdinaryAtMs:300000})).toBeNull();
});
it('rejects non-running, unidentified or malformed sources',()=>{
 for(const change of [{running:false},{conversationKey:''},{turnKey:''},{generation:-1},{generation:0.5},{nextOrdinaryAtMs:NaN}]){
  expect(createNativeRetentionPermit({...state,idleStartedAtMs:0,nextOrdinaryAtMs:300000,...change})).toBeNull();
 }
});
it('expires at the fixed deadline without sliding on reads and rejects reverse time',()=>{
 const p=createNativeRetentionPermit({...state,idleStartedAtMs:1000,nextOrdinaryAtMs:301000})!;
 expect(Object.isFrozen(p)).toBe(true);
 expect(nativeRetentionValid(p,state,1000)).toBe(true);
 expect(nativeRetentionValid(p,state,360999)).toBe(true);
 expect(nativeRetentionValid(p,state,361000)).toBe(false);
 expect(nativeRetentionValid(p,state,999)).toBe(false);
 expect(p.deadlineMs).toBe(361000);
});
it('rejects stale owners and revoked lifecycle state',()=>{
 const p=createNativeRetentionPermit({...state,idleStartedAtMs:0,nextOrdinaryAtMs:300000})!;
 for(const change of [{conversationKey:'two'},{turnKey:'new'},{generation:2},{running:false}]){
  expect(nativeRetentionValid(p,{...state,...change},100)).toBe(false);
 }
 expect(nativeRetentionValid(p,null,100)).toBe(false);
 expect(nativeRetentionValid(p,state,NaN)).toBe(false);
});
