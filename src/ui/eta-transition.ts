export interface Transition {startedActiveSeconds:number;offsetSeconds:number}

/** Display-only offset decays to zero; the target is already aged by the caller. */
export function transitionValue(targetSeconds:number,activeSeconds:number,transition:Transition|null):number {
  if(!Number.isFinite(targetSeconds)||targetSeconds<0||!Number.isFinite(activeSeconds)||activeSeconds<0||
    (transition&&(!Number.isFinite(transition.startedActiveSeconds)||transition.startedActiveSeconds<0||
      !Number.isFinite(transition.offsetSeconds))))throw Error('INVALID_TRANSITION');
  if(!transition)return targetSeconds;
  const fraction=Math.min(1,Math.max(0,(activeSeconds-transition.startedActiveSeconds)/2));
  return Math.max(0,targetSeconds+transition.offsetSeconds*(1-fraction));
}
