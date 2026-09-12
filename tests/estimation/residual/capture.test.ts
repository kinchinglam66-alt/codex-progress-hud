import {expect,it} from 'vitest';
import {captureHistoryFeatures} from '../../../src/estimation/residual/capture.js';
import type {HistorySnapshot} from '../../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../../src/observer/conversation-record.js';
import {createPrefixFingerprint} from '../../../src/estimation/residual/fingerprint.js';
function snapshot(records:ConversationRecord[]):HistorySnapshot{return {identity:'source',sourceEpoch:1,revision:1,coverage:{complete:true,gaps:[]},
  async *records(){for(const [ordinal,record] of records.entries())yield {ordinal,record};},async close(){}};}
it('collects current-turn counters during the existing scan without retaining text',async()=>{
  const source=snapshot([{id:'a',turnId:'other',atMs:0,kind:'tool_result',exitCode:1},
    {id:'b',turnId:'turn',atMs:1,kind:'tool_start',actionId:'x',text:'PRIVATE'},
    {id:'c',turnId:'turn',atMs:2,kind:'tool_result',actionId:'x',exitCode:1},
    {id:'d',turnId:'turn',atMs:3,kind:'tool_start',actionId:'y'}]);
  const capture=captureHistoryFeatures(source,'turn');
  expect(capture.result()).toBeNull();
  for await(const item of capture.snapshot.records(new AbortController().signal))expect(item.record.id).toBeDefined();
  expect(capture.result()).toMatchObject({outstandingActions:1,completedActions:1,failedActions:1,prefixComplete:true,oldestActionActiveSeconds:null});
  expect(JSON.stringify(capture.result())).not.toContain('PRIVATE');
  for await(const item of capture.snapshot.records(new AbortController().signal))void item;
  expect(capture.result()?.completedActions).toBe(1);
});
it('does not expose incomplete scan counters as a complete prefix',async()=>{
  const source=snapshot([{id:'a',turnId:'turn',atMs:0,kind:'user'}]),capture=captureHistoryFeatures(source,'turn');
  for await(const item of capture.snapshot.records(new AbortController().signal)){void item;break;}
  expect(capture.result()).toBeNull();
});
it('retains a completed fixed-snapshot capture through a partial compression replay',async()=>{
  const capture=captureHistoryFeatures(snapshot([{id:'a',turnId:'turn',atMs:0,kind:'user'}]),'turn');
  for await(const item of capture.snapshot.records(new AbortController().signal))void item;
  const before=capture.result(),fingerprint=capture.fingerprint();
  for await(const item of capture.snapshot.records(new AbortController().signal)){void item;break;}
  expect(capture.result()).toEqual(before);
  expect(capture.fingerprint()).toBe(fingerprint);
});
it('canonicalizes inferred message attribution without changing estimator records',()=>{
  const base={id:'a',kind:'assistant' as const,atMs:1,sourceTurnId:null};
  const legacy=createPrefixFingerprint(),strict=createPrefixFingerprint();
  legacy.add({...base,turnId:'turn'});strict.add({...base,turnId:null});
  expect(legacy.finish()).toBe(strict.finish());
});
it('does not report unknown tool attribution as zero activity',async()=>{
  const capture=captureHistoryFeatures(snapshot([{id:'a',turnId:null,atMs:1,kind:'tool_start',actionId:'x'}]),'turn');
  for await(const item of capture.snapshot.records(new AbortController().signal))void item;
  expect(capture.result()).toBeNull();
  expect(capture.reason()).toBe('unknown_attribution');
});
it('invalidates a contradictory completed replay and never restores it',async()=>{
  const records:ConversationRecord[]=[{id:'a',turnId:'turn',atMs:0,kind:'user'}];
  const capture=captureHistoryFeatures(snapshot(records),'turn');
  const scan=async()=>{for await(const item of capture.snapshot.records(new AbortController().signal))void item;};
  await scan();expect(capture.result()).not.toBeNull();
  records.push({id:'b',turnId:'turn',atMs:1,kind:'tool_start',actionId:'b'});
  await scan();expect(capture.result()).toBeNull();expect(capture.reason()).toBe('snapshot_changed');
  await scan();expect(capture.result()).toBeNull();
});
