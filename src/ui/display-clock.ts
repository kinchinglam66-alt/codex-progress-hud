import type {HudSnapshot} from '../server/task-store.js';
import {transitionValue,type Transition} from './eta-transition.js';
import {projectCountdown} from './countdown.js';
import {etaClockTicks} from './eta-clock-policy.js';
type Row=NonNullable<HudSnapshot['rows']>[number];
function remaining(row:Row,elapsed:number):number|null {
  const goal=row.goal;
  if(!goal||goal.status==='completed'||goal.runtime==='stopped'||goal.runtime==='failed'||goal.runtime==='interrupted')return null;
  const active=goal.activeSeconds+(etaClockTicks(goal)?elapsed:0);
  if(projectCountdown({prediction:goal.prediction,activeSeconds:active,state:goal.runtime==='running'?'running':'waiting'}).status==='unknown')return null;
  return Math.max(0,goal.prediction!.remainingSeconds-(active-goal.prediction!.observedActiveSeconds));
}

/** Local display interpolation only; never schedules inference or changes work state. */
export function createHudDisplayClock(now: () => number = () => performance.now()) {
  let snapshot: HudSnapshot | null = null;
  let receivedAt = 0;
  let elapsedSeconds = 0;
  let connected = false;
  const updatedUntil = new Map<string, number>();
  const transitions=new Map<string,{active:number;transition:Transition|null}>();
  let lastAdvance=now();
  function advance() {
    const at=Math.max(now(),lastAdvance),delta=(at-lastAdvance)/1000;
    if (connected) {
      elapsedSeconds = Math.max(elapsedSeconds, (at - receivedAt) / 1000, 0);
      for(const row of snapshot?.rows??[]){
        const entry=transitions.get(row.conversationKey);
        if(entry&&row.goal&&etaClockTicks(row.goal))entry.active+=delta;
      }
    }
    lastAdvance=at;
  }
  return {
    accept(frame: HudSnapshot, first: boolean): boolean {
      if (!first && snapshot !== null && frame.revision < snapshot.revision) return false;
      advance();
      const timestamp = lastAdvance;
      if (first) {updatedUntil.clear();transitions.clear();}
      const oldRows=new Map((snapshot?.rows??[]).map(row=>[row.conversationKey,row]));
      const previous = new Map((snapshot?.rows ?? []).map(row => [row.conversationKey, row.goal]));
      const present = new Set((frame.rows ?? []).map(row => row.conversationKey));
      for (const key of updatedUntil.keys()) if (!present.has(key)) updatedUntil.delete(key);
      for (const key of transitions.keys()) if (!present.has(key)) transitions.delete(key);
      for(const row of frame.rows??[]){
        const old=oldRows.get(row.conversationKey),goal=row.goal;
        const target=remaining(row,0);
        const same=!first&&old?.task.id===row.task.id&&old?.goal&&goal&&old.goal.generation===goal.generation&&old.goal.timeBasis===goal.timeBasis;
        let entry=transitions.get(row.conversationKey);
        if(!entry||!same){entry={active:0,transition:null};transitions.set(row.conversationKey,entry);}
        if(target===null||!same){entry.transition=null;continue;}
        if(old.goal!.estimateRevision===goal!.estimateRevision)continue;
        // Compare forecasts at the new active snapshot, not at different ages.
        const aligned={...old,goal:{...old.goal!,activeSeconds:goal!.activeSeconds}};
        const prior=remaining(aligned,0);
        const oldDisplay=remaining(old,elapsedSeconds);
        const bypass=goal!.changeReason==='failure'||goal!.changeReason==='scope_change';
        if(prior===null||oldDisplay===null||bypass||Math.abs(target-prior)>Math.max(5,prior*0.05)){
          entry.transition=null;continue;
        }
        const displayed=transitionValue(oldDisplay,entry.active,entry.transition);
        entry.transition={startedActiveSeconds:entry.active,offsetSeconds:displayed-target};
      }
      if (!first) for (const row of frame.rows ?? []) {
        const before = previous.get(row.conversationKey), goal = row.goal;
        if (before && goal && goal.prediction !== null &&
            (before.estimateRevision !== goal.estimateRevision || before.generation !== goal.generation)) {
          updatedUntil.set(row.conversationKey, timestamp + 8000);
        }
      }
      snapshot = structuredClone(frame);
      receivedAt = timestamp; elapsedSeconds = 0; connected = true;
      return true;
    },
    disconnect(): void {advance(); connected = false;},
    read() {
      if (snapshot === null) return null;
      advance();
      const updatedKeys = [...updatedUntil].filter(([, until]) => now() < until).map(([key]) => key);
      const displayedSeconds=new Map<string,number>();
      for(const row of snapshot.rows??[]){
        const target=remaining(row,elapsedSeconds),entry=transitions.get(row.conversationKey);
        if(target!==null)displayedSeconds.set(row.conversationKey,transitionValue(target,entry?.active??0,entry?.transition??null));
      }
      return {snapshot, elapsedSeconds, connected, updatedKeys,displayedSeconds};
    }
  };
}

export function startDisplayTicker(render: () => void): () => void {
  const timer = setInterval(render, 1000);
  return () => clearInterval(timer);
}
