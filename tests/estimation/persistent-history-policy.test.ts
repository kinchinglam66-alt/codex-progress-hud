import {expect,it} from 'vitest';
import {persistentHistoryPolicy} from '../../src/estimation/persistent-history-policy.js';

it('leaves unknown capacity unconfigured instead of inventing model limits',()=>{
 expect(persistentHistoryPolicy(null)).toEqual({});
});
it('derives a bounded cumulative input policy from the configured capacity',()=>{
 const policy=persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:null,source:'configured'});
 expect(policy.bootstrapBatchByteCapacity).toBe(65536);
 expect(policy.historyBudget).toMatchObject({trusted:true,contextCapacityBytes:242016,retainedSummaryReserveBytes:121008,maxCompactionOperations:16});
 expect(policy.historyBudget!.maxSourceBytes).toBe(1936128);
});
it('honors a smaller configured request-byte budget and rejects unusable capacity',()=>{
 expect(persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:16384,source:'configured'}).bootstrapBatchByteCapacity).toBe(8192);
 expect(persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:16384,source:'configured'}).historyBudget).toMatchObject({contextCapacityBytes:242016,retainedSummaryReserveBytes:121008,maxSourceBytes:1936128});
 expect(()=>persistentHistoryPolicy({contextTokens:1,outputReserveTokens:1,requestBytes:null,source:'configured'})).toThrow('INVALID_HISTORY_CAPACITY');
});
