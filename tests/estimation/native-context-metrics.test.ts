import {describe, expect, it} from 'vitest';
import {
  createNativeContextPhaseRecord,
  evaluateNativeContextPairs,
  type NativeContextPhaseRecord,
} from '../../src/estimation/native-context-metrics.js';

const stages = {
  queueMs: 10,
  accountProcessMs: 20,
  snapshotMs: 30,
  forkImportMs: 40,
  compactionMs: 0,
  inferenceMs: 80,
  deliveryMs: 150,
};

function record(
  strategy: 'native' | 'history',
  overrides: Partial<Parameters<typeof createNativeContextPhaseRecord>[0]> = {},
): NativeContextPhaseRecord {
  return createNativeContextPhaseRecord({
    strategy,
    version: 'native-context-v1',
    processState: 'cold',
    contextIdentityHash: 'a'.repeat(64),
    contextAgeMs: 500,
    knownTokens: 1000,
    cacheTokens: 100,
    unknownTokenCount: 0,
    stages,
    ...overrides,
  });
}

describe('createNativeContextPhaseRecord', () => {
  it('keeps only bounded phase and anonymous context metadata', () => {
    const row = record('native');

    expect(row).toEqual({
      strategy: 'native',
      version: 'native-context-v1',
      processState: 'cold',
      contextIdentityHash: 'a'.repeat(64),
      contextAgeMs: 500,
      knownTokens: 1000,
      cacheTokens: 100,
      unknownTokenCount: 0,
      stages,
    });
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.stages)).toBe(true);
  });

  it('rejects missing, invalid, or private fields', () => {
    for (const bad of [
      {...record('native'), stages: {...stages, deliveryMs: undefined}},
      {...record('native'), stages: {...stages, queueMs: -1}},
      {...record('native'), knownTokens: -1},
      {...record('native'), cacheTokens: 1001},
      {...record('native'), contextIdentityHash: 'not-a-hash'},
      {...record('native'), path: 'private/history.json'},
      {...record('native'), account: 'private-account'},
      {...record('native'), content: 'private text'},
    ]) expect(() => createNativeContextPhaseRecord(bad as never)).toThrow();
  });
});

describe('evaluateNativeContextPairs', () => {
  it('rejects paired runtime/prompt versions that do not match',()=>{
    const result=evaluateNativeContextPairs([{history:record('history'),native:record('native',{version:'other-version'})}]);
    expect(result.validPairCount).toBe(0);expect(result.passed).toBe(false);
  });
  it('counts native process resets against a warm baseline instead of discarding the slower pair',()=>{
    const hashes=['a','b','c'];
    const pairs=hashes.map((hash,index)=>({
      history:record('history',{contextIdentityHash:hash.repeat(64),processState:index===2?'warm':'cold',
        stages:{...stages,queueMs:0,accountProcessMs:10,snapshotMs:10,forkImportMs:10}}),
      native:record('native',{contextIdentityHash:hash.repeat(64),processState:'cold',
        stages:{...stages,queueMs:0,accountProcessMs:index===2?100:0,snapshotMs:0,forkImportMs:0}}),
    }));
    const result=evaluateNativeContextPairs(pairs);
    expect(result.validPairCount).toBe(3);expect(result.reasons).toContain('warm_regression');
  });
  it('does not claim the warm gate from exclusively cold evidence',()=>{
    const pairs=['a','b','c'].map(hash=>({history:record('history',{contextIdentityHash:hash.repeat(64)}),
      native:record('native',{contextIdentityHash:hash.repeat(64),stages:{...stages,queueMs:0,accountProcessMs:0,snapshotMs:0,forkImportMs:0}})}));
    expect(evaluateNativeContextPairs(pairs).reasons).toContain('warm_evidence_missing');
  });
  it('does not count the same checkpoint three times',()=>{
    const pair={history:record('history'),native:record('native',{stages:{...stages,queueMs:0,accountProcessMs:0,snapshotMs:20,forkImportMs:20}})};
    const result=evaluateNativeContextPairs([pair,pair,pair]);
    expect(result.passed).toBe(false);expect(result.validPairCount).toBe(1);
    expect(result.reasons).toContain('requires_three_valid_matched_pairs');
  });
  it('rejects slower warm delivery even when cold samples make the overall medians better',()=>{
    const pairs=['a','b','c'].map((hash,index)=>({
      history:record('history',{contextIdentityHash:hash.repeat(64),processState:index===2?'warm':'cold',
        stages:{queueMs:100,accountProcessMs:0,snapshotMs:0,forkImportMs:0,compactionMs:0,inferenceMs:index===2?0:900,deliveryMs:0}}),
      native:record('native',{contextIdentityHash:hash.repeat(64),processState:index===2?'warm':'cold',
        stages:{queueMs:60,accountProcessMs:0,snapshotMs:0,forkImportMs:0,compactionMs:0,inferenceMs:index===2?100:600,deliveryMs:0}}),
    }));
    const result=evaluateNativeContextPairs(pairs);
    expect(result.medianPreparationImprovement).toBe(0.4);expect(result.medianFirstValidDeliveryRegression).toBeLessThan(0);
    expect(result.passed).toBe(false);expect(result.reasons).toContain('warm_regression');
  });
  it('compares median end-to-end delivery, not median paired differences or the last delivery stage',()=>{
    const pairs=[
      {hash:'a',oldInference:0,newInference:1940},
      {hash:'b',oldInference:900,newInference:840},
      {hash:'c',oldInference:9900,newInference:8940},
    ].map(row=>({
      history:record('history',{contextIdentityHash:row.hash.repeat(64),stages:{queueMs:100,accountProcessMs:0,snapshotMs:0,forkImportMs:0,compactionMs:0,inferenceMs:row.oldInference,deliveryMs:0}}),
      native:record('native',{contextIdentityHash:row.hash.repeat(64),stages:{queueMs:60,accountProcessMs:0,snapshotMs:0,forkImportMs:0,compactionMs:0,inferenceMs:row.newInference,deliveryMs:0}}),
    }));
    const result=evaluateNativeContextPairs(pairs);
    expect(result.passed).toBe(false);
    expect(result.medianFirstValidDeliveryRegression).toBe(1);
    expect(result.reasons).toContain('median_first_valid_delivery_regression');
  });
  it('passes three hand-calculated matched pairs at the 30 percent preparation gate', () => {
    const pairs = [0, 1, 2].map((index) => ({
      history: record('history', {
        processState:index===2?'warm':'cold',
        contextIdentityHash: String.fromCharCode(97 + index).repeat(64),
        stages: {...stages, queueMs: 100, accountProcessMs: 0, snapshotMs: 0, forkImportMs: 0, compactionMs: 0, inferenceMs:50, deliveryMs: 0},
      }),
      native: record('native', {
        processState:index===2?'warm':'cold',
        contextIdentityHash: String.fromCharCode(97 + index).repeat(64),
        stages: {...stages, queueMs: 60, accountProcessMs: 0, snapshotMs: 0, forkImportMs: 0, compactionMs: 0, inferenceMs:50, deliveryMs: 0},
      }),
    }));

    const result = evaluateNativeContextPairs(pairs);

    expect(result.passed).toBe(true);
    expect(result.validPairCount).toBe(3);
    expect(result.medianPreparationImprovement).toBe(0.4);
    expect(result.medianFirstValidDeliveryRegression).toBeCloseTo(-40 / 150);
    expect(result.reasons).toEqual([]);
  });

  it('fails closed for fewer than three valid matched pairs and missing stages', () => {
    const result = evaluateNativeContextPairs([
      {history: record('history'), native: record('native', {contextIdentityHash: 'b'.repeat(64)})},
      {history: record('history'), native: {...record('native'), stages: {...stages, inferenceMs: undefined}} as never},
    ]);

    expect(result.passed).toBe(false);
    expect(result.validPairCount).toBe(0);
    expect(result.reasons).toContain('requires_three_valid_matched_pairs');
  });

  it('rejects delivery regression, unexplained token growth, and warm regression', () => {
    const history = (processState: 'cold' | 'warm') => record('history', {
      processState,
      knownTokens: 1000,
      stages: {...stages, queueMs: 100, deliveryMs: 150},
    });
    const native = (processState: 'cold' | 'warm') => record('native', {
      processState,
      knownTokens: 1100,
      stages: {...stages, queueMs: processState === 'warm' ? 120 : 60, deliveryMs: 151},
    });

    const result = evaluateNativeContextPairs([
      {history: history('cold'), native: native('cold')},
      {history: {...history('warm'),contextIdentityHash:'b'.repeat(64)}, native: {...native('warm'),contextIdentityHash:'b'.repeat(64)}},
      {history: {...history('warm'),contextIdentityHash:'c'.repeat(64)}, native: {...native('warm'),contextIdentityHash:'c'.repeat(64)}},
    ]);

    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'median_first_valid_delivery_regression',
      'unexplained_token_increase',
      'warm_regression',
    ]));
  });
});
