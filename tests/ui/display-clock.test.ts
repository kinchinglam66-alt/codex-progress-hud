import {afterEach, expect, it, vi} from 'vitest';
import {createHudDisplayClock, startDisplayTicker} from '../../src/ui/display-clock.js';
import type {HudSnapshot} from '../../src/server/task-store.js';
import {TaskStore} from '../../src/server/task-store.js';
import {buildConversationViews} from '../../src/ui/view-model.js';
const snapshot = (revision: number): HudSnapshot => ({revision, tasks: [], rows: [], selected: null,
  selectedTaskId: null, selectionMode: 'follow_activity', compatibility: {incompatibleClientSeen: false}});
afterEach(() => vi.useRealTimers());
it('transitions only small revisions, preserving raw prediction and uncertainty',()=>{
  let now=0;const clock=createHudDisplayClock(()=>now);
  clock.accept(predictionFrame(1,1,100),true);
  clock.accept(predictionFrame(2,2,104),false);
  expect(clock.read()?.displayedSeconds.get('a')).toBe(100);
  now=1000;expect(clock.read()?.displayedSeconds.get('a')).toBe(101);
  now=2000;expect(clock.read()?.displayedSeconds.get('a')).toBe(102);
  expect(clock.read()?.snapshot.rows?.[0]?.goal?.prediction?.remainingSeconds).toBe(104);
  clock.accept(predictionFrame(3,3,600),false);
  expect(clock.read()?.displayedSeconds.get('a')).toBe(600);
});
it('does not restart a transition on same prediction frames and freezes during pause',()=>{
  let now=0;const clock=createHudDisplayClock(()=>now);
  clock.accept(predictionFrame(1,1,100),true);clock.accept(predictionFrame(2,2,104),false);
  now=1000;
  const frame=predictionFrame(3,2,104);frame.rows![0]!.goal!.activeSeconds=1;
  clock.accept(frame,false);expect(clock.read()?.displayedSeconds.get('a')).toBe(101);
  const paused=structuredClone(frame);paused.revision=4;paused.rows![0]!.goal!.runtime='paused';
  clock.accept(paused,false);now=10000;expect(clock.read()?.displayedSeconds.get('a')).toBe(101);
  const resumed=structuredClone(frame);resumed.revision=5;clock.accept(resumed,false);
  now=11000;expect(clock.read()?.displayedSeconds.get('a')).toBe(102);
});
it('bypasses small transition for failure, unknown and goal replacement',()=>{
  const clock=createHudDisplayClock(()=>0);
  clock.accept(predictionFrame(1,1,100),true);
  const failed=predictionFrame(2,2,104);
  Object.assign(failed.rows![0]!.goal!,{changeReason:'failure'});
  clock.accept(failed,false);expect(clock.read()?.displayedSeconds.get('a')).toBe(104);
  const replacement=predictionFrame(3,1,106);replacement.rows![0]!.goal!.generation=2;
  clock.accept(replacement,false);expect(clock.read()?.displayedSeconds.get('a')).toBe(106);
  const unknown=predictionFrame(4,2,0);unknown.rows![0]!.goal!.prediction=null;
  clock.accept(unknown,false);expect(clock.read()?.displayedSeconds.has('a')).toBe(false);
});
it('retargets from the displayed value and isolates other conversations',()=>{
  let now=0;const clock=createHudDisplayClock(()=>now);
  const initial=predictionFrame(1,1,100);
  const other=structuredClone(initial.rows![0]!);other.conversationKey='b';other.task.id='b';
  initial.rows!.push(other);clock.accept(initial,true);
  const changed=predictionFrame(2,2,104);changed.rows!.push(other);clock.accept(changed,false);
  now=1000;expect(clock.read()?.displayedSeconds.get('a')).toBe(101);
  expect(clock.read()?.displayedSeconds.get('b')).toBe(99);
  const again=predictionFrame(3,3,102);again.rows![0]!.goal!.activeSeconds=1;
  again.rows![0]!.goal!.prediction!.observedActiveSeconds=1;
  clock.accept(again,false);expect(clock.read()?.displayedSeconds.get('a')).toBe(101);
  expect(clock.read()?.displayedSeconds.has('b')).toBe(false);
  now=3000;expect(clock.read()?.displayedSeconds.get('a')).toBe(100);
});
it('freezes transitions while disconnected and clears them on reconnect',()=>{
  let now=0;const clock=createHudDisplayClock(()=>now);
  clock.accept(predictionFrame(1,1,100),true);clock.accept(predictionFrame(2,2,104),false);
  now=1000;clock.disconnect();now=9000;
  expect(clock.read()?.displayedSeconds.get('a')).toBe(101);
  clock.accept(predictionFrame(0,2,104),true);
  expect(clock.read()?.displayedSeconds.get('a')).toBe(104);
});
it('compares revisions at the same active snapshot rather than their original forecasts',()=>{
  let now=0;const clock=createHudDisplayClock(()=>now);
  clock.accept(predictionFrame(1,1,100),true);now=60000;
  const next=predictionFrame(2,2,44);next.rows![0]!.goal!.activeSeconds=60;
  next.rows![0]!.goal!.prediction!.observedActiveSeconds=60;
  clock.accept(next,false);expect(clock.read()?.displayedSeconds.get('a')).toBe(40);
  now=62000;expect(clock.read()?.displayedSeconds.get('a')).toBe(42);
});
function predictionFrame(revision: number, estimateRevision: number, remainingSeconds: number) {
  const store = new TaskStore({goalForConversation: () => ({generation: 1, estimateRevision,
    runtime: 'running', status: 'running', activeSeconds: 0,
    prediction: {remainingSeconds, errorPercent: 30, observedActiveSeconds: 0}})});
  store.apply({taskId: 'a', event: {type: 'turn_started'}}, 0,
    {conversationKey: 'a', turnKey: 'a', isCurrentTurn: true});
  return {...store.snapshot(0), revision};
}
it('marks upward and downward estimate revisions briefly, not initial or ordinary snapshots', () => {
  let now = 0; const clock = createHudDisplayClock(() => now);
  clock.accept(predictionFrame(1, 1, 3600), true);
  expect(clock.read()?.updatedKeys).toEqual([]);
  now = 1000; clock.accept(predictionFrame(2, 2, 7200), false);
  const changed = clock.read()!;
  expect(changed.updatedKeys).toEqual(['a']);
  expect(buildConversationViews(changed.snapshot.rows!, 0, changed.updatedKeys)[0]?.etaLabel).toBe('02:00:00 · 上次估时误差 ±30% · 已更新');
  now = 7000; clock.accept(predictionFrame(3, 2, 7200), false);
  expect(clock.read()?.updatedKeys).toEqual(['a']);
  now = 9000; expect(clock.read()?.updatedKeys).toEqual([]);
  clock.accept(predictionFrame(4, 3, 1800), false);
  expect(clock.read()?.updatedKeys).toEqual(['a']);
  clock.accept(predictionFrame(3, 4, 900), false);
  expect(clock.read()?.snapshot.revision).toBe(4);
  clock.disconnect(); now = 10000;
  clock.accept(predictionFrame(0, 0, 600), true);
  expect(clock.read()?.updatedKeys).toEqual([]);
});
it('advances locally, ignores stale frames, and freezes the last display on disconnect', () => {
  let now = 0;
  const clock = createHudDisplayClock(() => now);
  expect(clock.read()).toBeNull();
  expect(clock.accept(snapshot(5), true)).toBe(true);
  now = 2000; expect(clock.read()?.elapsedSeconds).toBe(2);
  expect(clock.accept(snapshot(4), false)).toBe(false);
  expect(clock.read()?.elapsedSeconds).toBe(2);
  clock.disconnect(); now = 10000;
  expect(clock.read()).toMatchObject({elapsedSeconds: 2, connected: false});
  expect(clock.accept(snapshot(0), true)).toBe(true);
  now = 11000;
  expect(clock.read()).toMatchObject({elapsedSeconds: 1, connected: true, snapshot: {revision: 0}});
});
it('uses monotonic elapsed time and owns a detached snapshot', () => {
  let now = 1000; const clock = createHudDisplayClock(() => now);
  const frame = snapshot(1); clock.accept(frame, true); frame.revision = 900;
  now = 3000; expect(clock.read()?.elapsedSeconds).toBe(2);
  now = 2000; expect(clock.read()?.elapsedSeconds).toBe(2);
  expect(clock.read()?.snapshot.revision).toBe(1);
});
it('runs local rendering once per second and cancels cleanly', () => {
  vi.useFakeTimers(); let renders = 0;
  const stop = startDisplayTicker(() => {renders++;});
  vi.advanceTimersByTime(999); expect(renders).toBe(0);
  vi.advanceTimersByTime(2001); expect(renders).toBe(3);
  stop(); vi.advanceTimersByTime(2000); expect(renders).toBe(3);
});
