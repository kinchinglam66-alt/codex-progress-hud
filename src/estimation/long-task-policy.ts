export type TriggerReason = 'initial'|'important_event'|'status_evidence'|'near_expiry'|'overdue'|'periodic'|'pre_dispatch_retry'|'bootstrap_recovery';

export type RequestBlockReason = 'invalid_clock'|'invalid_counter'|'context_missing'|'request_in_flight'
  |'no_new_information'|'no_active_progress'|'global_concurrency_limit'|'hourly_limit'|'runtime_ineligible'
  |'initial_delay'|'cooldown'|'event_coalescing'|'adaptive_interval'|'overdue_already_checked'|'retry_backoff';

export interface RequestContext {
  elapsedSeconds:number;
  lastRequestSeconds:number|null;
  remainingSeconds:number|null;
  milestoneRemainingSeconds?:number|null;
  unknownResults:number;
  eventAtSeconds:number|null;
  eventSequence?:number;
  consumedEventSequence?:number;
  eventReason?:TriggerReason|null;
  contentReady:boolean;
  hasNewInformation:boolean;
  hasNewContent?:boolean;
  bootstrapRecovery?:boolean;
  activeSeconds?:number;
  lastRequestActiveSeconds?:number|null;
  overdueActionRecheck?:boolean;
  expiredResultRecheck?:boolean;
  nearExpiryRecheck?:boolean;
  overdueAlreadyChecked?:boolean;
  overdueEligibleActiveSeconds?:number|null;
  preDispatchRetry?:boolean;
  retryBackoff?:boolean;
  state:'running'|'waiting'|'paused'|'terminal';
  statusEvidenceArrived:boolean;
  goalInFlight:boolean;
  globalInFlight:number;
  conversationStartsLastHour:number;
}

export interface TriggerDecision {
  reason:TriggerReason|null;
  blockReason:RequestBlockReason|null;
  earliestEligibleWallSeconds:number|null;
  eligibleActiveSeconds:number|null;
}

export const EVENT_STABILITY_SECONDS=2;
export const MIN_REQUEST_SPACING_SECONDS=15;
export const ordinaryRequestIntervalSeconds=(_remaining:number|null,_unknown:number):number=>180;

const decision=(blockReason:RequestBlockReason|null, reason:TriggerReason|null = null,
  earliestEligibleWallSeconds:number|null = null, eligibleActiveSeconds:number|null = null):TriggerDecision =>
  ({reason,blockReason,earliestEligibleWallSeconds,eligibleActiveSeconds});

/** Pure trigger eligibility; resource admission and spend authorization remain owner/worker duties. */
export function decideTrigger(input:RequestContext):TriggerDecision {
  const numeric=[input.elapsedSeconds,input.lastRequestSeconds,input.eventAtSeconds,input.remainingSeconds,
    input.activeSeconds,input.lastRequestActiveSeconds,input.overdueEligibleActiveSeconds,input.milestoneRemainingSeconds]
    .filter((value):value is number=>value!==null&&value!==undefined);
  if(numeric.some(value=>!Number.isFinite(value)||value<0)||
    (input.lastRequestSeconds!==null&&input.lastRequestSeconds>input.elapsedSeconds)||
    (input.eventAtSeconds!==null&&input.eventAtSeconds>input.elapsedSeconds)||
    (input.activeSeconds!==undefined&&input.lastRequestActiveSeconds!==undefined&&
      input.lastRequestActiveSeconds!==null&&input.lastRequestActiveSeconds>input.activeSeconds))
    return decision('invalid_clock');
  if([input.unknownResults,input.globalInFlight,input.conversationStartsLastHour]
    .some(value=>!Number.isSafeInteger(value)||value<0))return decision('invalid_counter');
  if(!input.contentReady)return decision('context_missing');
  if(input.goalInFlight)return decision('request_in_flight');

  const freshEvent=input.eventSequence!==undefined&&input.consumedEventSequence!==undefined
    ? input.eventSequence>input.consumedEventSequence
    : input.eventAtSeconds!==null&&
      (input.lastRequestSeconds===null||input.eventAtSeconds>input.lastRequestSeconds);
  const statusEvent=freshEvent&&input.state==='waiting'&&input.statusEvidenceArrived;
  const importantEvent=freshEvent&&!statusEvent&&input.eventReason!=='periodic';
  const activeClock=input.activeSeconds!==undefined&&input.lastRequestActiveSeconds!==undefined&&
    input.lastRequestActiveSeconds!==null;
  const activeProgress=activeClock&&input.activeSeconds!>input.lastRequestActiveSeconds!;
  const bootstrapRecovery=input.bootstrapRecovery===true&&input.remainingSeconds===null&&
    input.hasNewInformation&&input.hasNewContent===true;
  const positive=[input.remainingSeconds,input.milestoneRemainingSeconds].filter((v):v is number=>typeof v==='number'&&v>0);
  const interval=ordinaryRequestIntervalSeconds(positive.length?Math.min(...positive):null,input.unknownResults);
  const eligibleActiveSeconds=activeClock?input.lastRequestActiveSeconds!+(bootstrapRecovery?60:interval):null;

  if(input.state!=='running'&&!statusEvent)return decision('runtime_ineligible',null,null,eligibleActiveSeconds);
  if(input.retryBackoff===true)return decision('retry_backoff',null,null,input.overdueEligibleActiveSeconds??eligibleActiveSeconds);
  const cooldown=MIN_REQUEST_SPACING_SECONDS;
  if(input.lastRequestSeconds!==null&&input.elapsedSeconds-input.lastRequestSeconds<cooldown)
    return decision('cooldown',null,input.lastRequestSeconds+cooldown,eligibleActiveSeconds);
  if(input.lastRequestSeconds!==null&&freshEvent&&input.eventAtSeconds!==null&&input.elapsedSeconds-input.eventAtSeconds<EVENT_STABILITY_SECONDS)
    return decision('event_coalescing',null,input.eventAtSeconds+EVENT_STABILITY_SECONDS,eligibleActiveSeconds);

  if(input.lastRequestSeconds===null&&!statusEvent){
    return input.hasNewInformation?decision(null,'initial',null,null):
      decision('no_new_information',null,null,null);
  }
  if(input.preDispatchRetry===true){
    if(input.lastRequestSeconds!==null&&input.elapsedSeconds-input.lastRequestSeconds<60)
      return decision('retry_backoff',null,input.lastRequestSeconds+60,eligibleActiveSeconds);
    return decision(null,'pre_dispatch_retry',null,eligibleActiveSeconds);
  }
  if(statusEvent)return decision(null,'status_evidence',null,eligibleActiveSeconds);
  if(bootstrapRecovery){
    // Recovery backoff is separate from the shared minimum start spacing.
    if(!activeClock&&input.lastRequestSeconds!==null&&input.elapsedSeconds-input.lastRequestSeconds<60)
      return decision('cooldown',null,input.lastRequestSeconds+60,eligibleActiveSeconds);
    if(activeClock&&input.activeSeconds!<eligibleActiveSeconds!)
      return decision('cooldown',null,null,eligibleActiveSeconds);
    return decision(null,'bootstrap_recovery',null,eligibleActiveSeconds);
  }
  if(importantEvent)return decision(null,'important_event',null,eligibleActiveSeconds);
  if(input.expiredResultRecheck===true)
    return decision(null,'overdue',null,input.overdueEligibleActiveSeconds??input.activeSeconds??null);
  if(input.nearExpiryRecheck===true&&positive.length>0)
    return decision(null,'near_expiry',null,input.activeSeconds??null);
  if(input.overdueActionRecheck===true&&input.remainingSeconds===0)
    return decision(null,'overdue',null,input.overdueEligibleActiveSeconds??input.activeSeconds??null);
  if(!input.hasNewInformation&&!activeProgress)
    return decision(activeClock?'no_active_progress':'no_new_information',null,null,eligibleActiveSeconds);
  if(activeClock) {
    if(!activeProgress||input.activeSeconds!<eligibleActiveSeconds!)
      return decision(activeProgress?'adaptive_interval':'no_active_progress',null,null,eligibleActiveSeconds);
    return decision(null,'periodic',null,eligibleActiveSeconds);
  }
  if(input.elapsedSeconds-input.lastRequestSeconds!<interval)
    return decision('adaptive_interval',null,input.lastRequestSeconds!+interval,null);
  return decision(null,'periodic',null,null);
}

export function canRequest(input:RequestContext):boolean {
  return decideTrigger(input).blockReason===null;
}

export function requestBlockReason(input:RequestContext):RequestBlockReason|null {
  return decideTrigger(input).blockReason;
}
