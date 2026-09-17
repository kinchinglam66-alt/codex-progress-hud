import {expect,it} from 'vitest';
import * as retention from '../../src/estimation/native-owner-retention.js';

const permit={conversationKey:'source',turnKey:'seven',generation:7,idleStartedAtMs:1000,deadlineMs:361000};
const state={conversationKey:'source',turnKey:'seven',generation:7,running:true};
// Removing the process-level transition check would either discard the healthy
// process on every new turn or accept an unrelated/stale owner. Literal clock
// bounds and identities are independent of the permit builder.
const valid=(next:retention.NativeRetentionState,now=2000)=>retention.nativeProcessRetentionValid(permit,next,now);
it('retains a running next turn without extending the inherited deadline',()=>{
 expect(valid({...state,turnKey:'eight',generation:8})).toBe(true);
 expect(valid({...state,turnKey:'eight',generation:8},360999)).toBe(true);
 expect(valid({...state,turnKey:'eight',generation:8},361000)).toBe(false);
 expect(permit.deadlineMs).toBe(361000);
});
it('retains an explicitly normal inter-turn idle state, not a generic non-running state',()=>{
 expect(valid({...state,running:false,idleEligible:true})).toBe(true);
 expect(valid({...state,running:false})).toBe(false);
 expect(valid({...state,running:false,idleEligible:false})).toBe(false);
});
it('rejects other conversations, ambiguous turn generations and reversed clocks',()=>{
 for(const change of [{conversationKey:'other'},{turnKey:''},{generation:6},{generation:NaN},
  {turnKey:'eight',generation:7},{turnKey:'seven',generation:8}])expect(valid({...state,...change})).toBe(false);
 for(const now of [999,NaN,Infinity,-1])expect(valid(state,now)).toBe(false);
});
it('does not relax the existing turn-specific request retention contract',()=>{
 expect(retention.nativeRetentionValid(permit,{...state,turnKey:'eight',generation:8},2000)).toBe(false);
 expect(retention.nativeRetentionValid(permit,{...state,running:false},2000)).toBe(false);
});
