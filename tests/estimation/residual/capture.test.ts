import {expect,it} from 'vitest';
import {captureHistoryFeatures} from '../../../src/estimation/residual/capture.js';
import type {HistorySnapshot} from '../../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../../src/observer/conversation-record.js';
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
