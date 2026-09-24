import {resolve as fixturePath} from 'node:path';
import {describe,it,expect,vi} from 'vitest';
// @ts-expect-error Diagnostic entry point deliberately remains a standalone JS script.
import {buildCompletedTurnPreflightSource,createNoModelForkGuard,createNoModelPreparationGuard} from '../../scripts/diagnostics/completed-turn-native-base.mjs';
// @ts-expect-error Standalone diagnostic JS.
import * as preflight from '../../scripts/diagnostics/completed-turn-native-base.mjs';
import {createCompletedTurnComparisonFixtures} from '../../src/evaluation/native-comparison-fixture.js';

describe('completed-turn native preflight contract',()=>{
 it('puts an explicit image in the active request without changing completed history',()=>{
  const original=createCompletedTurnComparisonFixtures({sourceThreadId:'99999999-9999-4999-8999-999999999999',cwd:fixturePath('empty'),targetBytes:1048576})[0]!;
  expect(preflight).toHaveProperty('withCurrentTurnImage');
  const modified=preflight.withCurrentTurnImage(original.rollout);
  const before=original.rollout.trimEnd().split('\n'),after=modified.trimEnd().split('\n');
  const index=before.findIndex(line=>JSON.parse(line).payload.id==='current-request');
  expect(after.slice(0,index)).toEqual(before.slice(0,index));
  expect(after.slice(index+1)).toEqual(before.slice(index+1));
  const content=JSON.parse(after[index]!).payload.content;
  expect(content[0]).toEqual(JSON.parse(before[index]!).payload.content[0]);
  expect(content[1].type).toBe('input_image');expect(content[1].image_url).toMatch(/^data:image\/png;base64,/);
  expect(()=>preflight.withCurrentTurnImage(modified)).toThrow();
  expect(()=>preflight.withCurrentTurnImage(buildCompletedTurnPreflightSource(fixturePath('empty')).rollout)).toThrow();
 });
 it('allows current-context injection only into owned forks and never allows model RPC',async()=>{
  const call=vi.fn().mockResolvedValueOnce({thread:{id:'base'}}).mockResolvedValueOnce({thread:{id:'child'}}).mockResolvedValue({});
  const guard=createNoModelPreparationGuard(call,'source','six');
  await expect(guard.call('thread/inject_items',{threadId:'source',items:[]})).rejects.toThrow();
  await guard.call('thread/fork',{threadId:'source',path:'C:/snapshot',lastTurnId:'six'});
  await guard.call('thread/fork',{threadId:'base',lastTurnId:'six'});
  await expect(guard.call('thread/inject_items',{threadId:'base',items:[]})).rejects.toThrow();
  await guard.call('thread/inject_items',{threadId:'child',items:[]});
  for(const method of ['turn/start','thread/compact/start'])await expect(guard.call(method,{threadId:'child'})).rejects.toThrow();
  expect(call.mock.calls.map(c=>c[0])).toEqual(['thread/fork','thread/fork','thread/inject_items']);
 });
 it('builds six terminal turns and a whole active seventh without private input',()=>{
  const source=buildCompletedTurnPreflightSource(fixturePath('synthetic-empty'));
  const lines=source.rollout.trimEnd().split('\n').map(JSON.parse);
  expect(lines.filter((x:any)=>x.payload.type==='task_complete')).toHaveLength(6);
  expect(lines.filter((x:any)=>x.payload.type==='task_started')).toHaveLength(7);
  // Pinned thread/read reconstructs UI items from event_msg, not response_item.
  expect(lines.filter((x:any)=>x.type==='event_msg'&&x.payload.type==='user_message')).toHaveLength(7);
  expect(lines.filter((x:any)=>x.type==='event_msg'&&x.payload.type==='agent_message')).toHaveLength(7);
  expect(Buffer.from(source.rollout).subarray(0,source.baseBytes).toString()).not.toContain('ACTIVE_SEVEN');
  expect(source.rollout).toContain('ACTIVE_SEVEN');
  expect(source.lastTurnId).toBe(lines.filter((x:any)=>x.payload.type==='task_complete').at(-1).payload.turn_id);
 });
 it('never forwards inference, compression, source mutation or unknown RPC',async()=>{
  const call=vi.fn();const guard=createNoModelForkGuard(call,'root');
  for(const method of ['turn/start','thread/compact/start','thread/inject_items','thread/delete','unknown'])
   await expect(guard.call(method,{threadId:'root'})).rejects.toThrow('PREFLIGHT_RPC_FORBIDDEN');
  await expect(guard.call('thread/goal/clear',{threadId:'root'})).rejects.toThrow('PREFLIGHT_UNOWNED_THREAD');
  expect(call).not.toHaveBeenCalled();
 });
 it.each(['task_failed','turn_aborted'])('preserves the explicit previous terminal %s without calling it completed',(terminal)=>{
  const source=buildCompletedTurnPreflightSource(fixturePath('synthetic-empty'),{previousTerminal:terminal});
  const lines=source.rollout.trimEnd().split('\n').map(JSON.parse);
  expect(lines.filter((x:any)=>x.payload.type===terminal)).toHaveLength(1);
  expect(lines.filter((x:any)=>x.payload.type==='task_complete')).toHaveLength(5);
 });
 it('keeps an earlier failed fifth turn before a completed sixth cutoff',()=>{
  const source=buildCompletedTurnPreflightSource(fixturePath('synthetic-empty'),{earlierFailure:true});
  const lines=source.rollout.trimEnd().split('\n').map(JSON.parse);
  const failed=lines.filter((x:any)=>x.payload.type==='task_failed');
  expect(failed).toHaveLength(1);expect(failed[0].payload.turn_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-000000000005');
  expect(lines.filter((x:any)=>x.payload.type==='task_complete').at(-1).payload.turn_id).toBe(source.lastTurnId);
 });
 it('uses a genuinely empty historical prefix in the first-turn case',()=>{
  const source=buildCompletedTurnPreflightSource(fixturePath('synthetic-empty'),{firstTurn:true});
  const lines=source.rollout.trimEnd().split('\n').map(JSON.parse);
  expect(lines.filter((x:any)=>x.payload.type==='task_started')).toHaveLength(1);
  expect(lines.filter((x:any)=>x.payload.type==='task_complete')).toHaveLength(0);
  expect(source.baseBytes).toBe(0);expect(source.lastTurnId).toBeUndefined();
 });
 it('admits explicitly expected ephemeral clean sessions only, never an unplanned thread start',async()=>{
  const call=vi.fn().mockResolvedValueOnce({thread:{id:'clean-1'}}).mockResolvedValueOnce({thread:{id:'clean-2'}});
  const r=createNoModelForkGuard(call,'root');
  await expect(r.call('thread/start',{ephemeral:true})).rejects.toThrow();
  r.expectClean();await r.call('thread/start',{ephemeral:true});r.expectClean();await r.call('thread/start',{ephemeral:true});
  expect(r.summary()).toMatchObject({baseCount:0,childCount:0,cleanCount:2,modelCalls:0});
 });
 it('tracks base and children separately and requires the immutable base as parent',async()=>{
  const call=vi.fn().mockResolvedValueOnce({thread:{id:'base'}}).mockResolvedValueOnce({thread:{id:'child-1'}}).mockResolvedValueOnce({thread:{id:'child-2'}});
  const guard=createNoModelForkGuard(call,'root');
  guard.expectFork({role:'base',threadId:'root',path:'C:/snapshot',lastTurnId:'six'});
  await guard.call('thread/fork',{threadId:'root',path:'C:/snapshot',lastTurnId:'six'});
  for(let i=1;i<=2;i++){
   guard.expectFork({role:'child',threadId:'base',lastTurnId:'six'});
   await guard.call('thread/fork',{threadId:'base',lastTurnId:'six'});
  }
  expect(guard.summary()).toEqual({baseCount:1,childCount:2,modelCalls:0});
  expect(()=>guard.expectFork({role:'child',threadId:'child-1',lastTurnId:'six'})).toThrow('PREFLIGHT_FORK_PARENT');
 });
 it('consumes a fork expectation before dispatch and rejects duplicate reply IDs',async()=>{
  const call=vi.fn().mockResolvedValue({thread:{id:'base'}});const guard=createNoModelForkGuard(call,'root');
  guard.expectFork({role:'base',threadId:'root',path:'C:/snapshot',lastTurnId:'six'});
  await guard.call('thread/fork',{threadId:'root',path:'C:/snapshot',lastTurnId:'six'});
  guard.expectFork({role:'child',threadId:'base',lastTurnId:'six'});
  await expect(guard.call('thread/fork',{threadId:'base',lastTurnId:'six'})).rejects.toThrow('PREFLIGHT_FORK_ID');
  await expect(guard.call('thread/fork',{threadId:'base',lastTurnId:'six'})).rejects.toThrow('PREFLIGHT_FORK_UNEXPECTED');
 });
});
