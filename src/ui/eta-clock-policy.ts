import {ETA_TIME_BASIS} from '../core/eta-time-basis.js';
import type {PassiveGoalView} from '../server/passive-goals.js';

export function etaClockTicks(goal:PassiveGoalView):boolean {
  if(goal.objectiveState&&goal.objectiveState!=='ongoing')return false;
  if(goal.timeBasis!==ETA_TIME_BASIS)return goal.runtime==='running'&&!goal.runtimeUncertain;
  return !goal.humanBlocked&&goal.status!=='completed'&&
    !['interrupted','failed','stopped'].includes(goal.runtime);
}
