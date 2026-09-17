import {describe, expect, it} from 'vitest';
import * as metrics from '../../src/estimation/native-context-metrics.js';

function pairs(): metrics.NativeContextPair[] {
  return ['a','b','c'].map((hash,index)=>{
    const row=(strategy:'history'|'native')=>metrics.createNativeContextPhaseRecord({
      strategy,version:'fixture-v1',processState:index===0?'cold':'warm',
      contextIdentityHash:hash.repeat(64),contextAgeMs:0,knownTokens:100,cacheTokens:0,unknownTokenCount:0,
      stages:{queueMs:strategy==='native'&&index===0?70:100,accountProcessMs:0,snapshotMs:0,
        forkImportMs:0,compactionMs:0,inferenceMs:10,deliveryMs:0},
    });
    return {history:row('history'),native:row('native')};
  });
}
function score(rows:metrics.NativeContextPair[], invalidIndices:readonly number[]=[]){
  expect(metrics).toHaveProperty('evaluateNativeContextSplitPairs');
  return metrics.evaluateNativeContextSplitPairs(rows,invalidIndices);
}
function change(rows:metrics.NativeContextPair[],index:number,stage:'queueMs'|'inferenceMs',value:number){
  rows[index]={...rows[index]!,native:{...rows[index]!.native,stages:{...rows[index]!.native.stages,[stage]:value}}};
}
describe('prospective split acceptance',()=>{
  it('v3 reports higher known and unknown usage without changing v2 or counting cache twice',()=>{
    const rows=pairs();rows[1]={...rows[1]!,native:{...rows[1]!.native,knownTokens:180,cacheTokens:150,unknownTokenCount:2}};
    expect(metrics).toHaveProperty('evaluateNativeContextSplitUsagePairs');
    const result=metrics.evaluateNativeContextSplitUsagePairs(rows);
    expect(result).toMatchObject({version:'native-context-split-v3',passed:true,reasons:[],usagePolicy:'report-only'});
    expect(result.usage[1]).toMatchObject({stage:'same-turn',history:{knownTokens:100,cacheTokens:0,unknownTokenCount:0},native:{knownTokens:180,cacheTokens:150,unknownTokenCount:2},completeCostComparable:false});
    expect(score(rows).passed).toBe(false);
  });
  it('v3 still rejects invalid evidence, malformed usage, preparation and delivery regressions',()=>{
    expect(metrics).toHaveProperty('evaluateNativeContextSplitUsagePairs');
    expect(metrics.evaluateNativeContextSplitUsagePairs(pairs(),[1]).passed).toBe(false);
    for(const stage of ['queueMs','inferenceMs'] as const){
      const rows=pairs();change(rows,1,stage,200);
      expect(metrics.evaluateNativeContextSplitUsagePairs(rows).passed).toBe(false);
    }
    const rows=pairs();rows[1]={...rows[1]!,native:{...rows[1]!.native,knownTokens:NaN}};
    expect(metrics.evaluateNativeContextSplitUsagePairs(rows).passed).toBe(false);
  });
  it('rejects a prewarmed native arm against cold history',()=>{
    const rows=pairs();rows[0]={...rows[0]!,native:{...rows[0]!.native,processState:'warm'}};
    expect(score(rows).passed).toBe(false);
    expect(score(rows).reasons).toContain('cold:checkpoint_mismatch');
  });
  it('passes exact cold 30% and warm equality without changing the legacy failure',()=>{
    const rows=pairs();
    expect(metrics.evaluateNativeContextPairs(rows).passed).toBe(false);
    expect(score(rows)).toMatchObject({version:'native-context-split-v2',passed:true,validPairCount:3,reasons:[]});
  });
  it.each([0,1,2])('rejects preparation regression independently at stage %s',index=>{
    const rows=pairs();change(rows,index,'queueMs',index===0?70.001:100.001);
    expect(score(rows).passed).toBe(false);
    expect(score(rows).stages[index]?.preparationPassed).toBe(false);
  });
  it.each([0,1,2])('rejects delivery regression independently at stage %s',index=>{
    const rows=pairs();change(rows,index,'inferenceMs',index===0?40.001:10.001);
    expect(score(rows).passed).toBe(false);
    expect(score(rows).stages[index]?.deliveryPassed).toBe(false);
  });
  it('does not filter an invalid content/expired checkpoint then relabel the following stages',()=>{
    const result=score(pairs(),[1]);
    expect(result.passed).toBe(false);expect(result.validPairCount).toBe(2);
    expect(result.reasons).toContain('invalid_checkpoint_evidence');
  });
  it('requires exactly three distinct matched checkpoints',()=>{
    const rows=pairs();
    for(const input of [[],rows.slice(0,2),[...rows,rows[0]!],[rows[0]!,rows[0]!,rows[2]!]])
      expect(score(input).passed).toBe(false);
  });
  it('rejects malformed durations and cross-checkpoint versions',()=>{
    const rows=pairs();change(rows,1,'queueMs',NaN);
    expect(score(rows).passed).toBe(false);
    const mixed=pairs();mixed[2]={history:{...mixed[2]!.history,version:'other'},native:{...mixed[2]!.native,version:'other'}};
    expect(score(mixed).passed).toBe(false);
  });
  it('retains token and unknown-usage regression checks',()=>{
    for(const field of ['knownTokens','unknownTokenCount'] as const){
      const rows=pairs();rows[1]={...rows[1]!,native:{...rows[1]!.native,[field]:101}};
      expect(score(rows).reasons).toContain('unexplained_token_increase');
    }
  });
  it('counts a native reset as cost, but requires cold then warm history evidence',()=>{
    const rows=pairs();rows[1]={...rows[1]!,native:{...rows[1]!.native,processState:'cold'}};
    expect(score(rows).passed).toBe(true);
    rows[1]={...rows[1]!,history:{...rows[1]!.history,processState:'cold'}};
    expect(score(rows).passed).toBe(false);
  });
});
