import {it,expect} from 'vitest';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {bindRequestCorrelation,currentRequestCorrelation,requestCorrelation,withRequestCorrelation} from '../../src/estimation/request-correlation.js';
import {createPersistentReceiptJournal} from '../../src/estimation/observer-persistent-receipt.js';

it('retains operation correlation when a persistent transport delivers from its first request context',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eta-callback-'));
  const journal=createPersistentReceiptJournal(directory);
  const old=new AbortController().signal,current=new AbortController().signal;
  const binding={operationId:randomUUID(),admissionId:randomUUID(),ownerUuid:randomUUID(),sourceKey:'synthetic',sourceEpoch:'[1,2]',generation:2};
  const callback=await withRequestCorrelation(current,async()=>{
    await journal.operationStarted(binding);
    return bindRequestCorrelation(async()=>{
      await Promise.resolve();
      const tokens={totalTokens:110,inputTokens:100,outputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:2};
      await journal.usageSnapshot({...binding,total:tokens,last:tokens,observedAt:Date.now(),completenessReason:'observed'});
      await journal.usageGap({...binding,observedAt:Date.now(),reason:'missing'});
    });
  });
  await withRequestCorrelation(old,async()=>{
    await callback();
    expect(currentRequestCorrelation()).toBe(requestCorrelation(old));
  });
  await withRequestCorrelation(current,()=>journal.operationTerminal({...binding,terminalState:'completed',usageCompleteness:'missing'}));
  const rows=(await readFile(join(directory,'persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(rows).toHaveLength(4);
  expect(rows.every(row=>row.correlationId===requestCorrelation(current))).toBe(true);
});

it('isolates concurrent callbacks and restores caller context on failure',async()=>{
  const signals=[new AbortController().signal,new AbortController().signal];
  const callbacks=signals.map(signal=>withRequestCorrelation(signal,()=>bindRequestCorrelation(async()=>{
    await Promise.resolve();return currentRequestCorrelation();
  })));
  expect(await Promise.all(callbacks.map(callback=>callback()))).toEqual(signals.map(requestCorrelation));
  const fail=withRequestCorrelation(signals[1]!,()=>bindRequestCorrelation(()=>{throw Error('synthetic');}));
  withRequestCorrelation(signals[0]!,()=>{
    expect(fail).toThrow('synthetic');
    expect(currentRequestCorrelation()).toBe(requestCorrelation(signals[0]!));
  });
});

it('does not invent correlation from the transport when none was captured',async()=>{
  const callback=bindRequestCorrelation(async()=>{await Promise.resolve();return currentRequestCorrelation();});
  await withRequestCorrelation(new AbortController().signal,async()=>{
    expect(await callback()).toBeUndefined();
    expect(currentRequestCorrelation()).toBeDefined();
  });
});
