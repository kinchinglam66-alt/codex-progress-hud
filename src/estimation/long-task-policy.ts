export interface RequestContext {
  /** Monotonic wall time since goal creation; not the pause-excluding HUD clock. */
  elapsedSeconds:number;
  lastRequestSeconds:number|null;
  remainingSeconds:number|null;
  unknownResults:number;
  eventAtSeconds:number|null;
  contentReady:boolean;
  hasNewInformation:boolean;
  /** Owner grants at most once for the same current action; not a timer-only retry. */
  overdueActionRecheck?:boolean;
  /** Owner-proven, single retry for a transient failure before model dispatch. */
  preDispatchRetry?:boolean;
  state:'running'|'waiting'|'paused'|'terminal';
  statusEvidenceArrived:boolean;
  goalInFlight:boolean;
  globalInFlight:number;
  /** Owner computes a rolling-hour count across goal replacements. */
  conversationStartsLastHour:number;
}

/** Eligibility only; owner still needs atomic resource and usage admission. */
export function canRequest(input:RequestContext):boolean {
  return requestBlockReason(input) === null;
}

/** Static reason codes only; never include task text or provider errors. */
export function requestBlockReason(input:RequestContext):string|null {
  const {elapsedSeconds:now,lastRequestSeconds:last,eventAtSeconds:event}=input;
  const times=[now,...(last===null?[]:[last]),...(event===null?[]:[event]),
    ...(input.remainingSeconds===null?[]:[input.remainingSeconds])];
  if(times.some(x=>!Number.isFinite(x)||x<0)||
    (last!==null&&last>now)||(event!==null&&event>now))return 'invalid_clock';
  if([input.unknownResults,input.globalInFlight,input.conversationStartsLastHour]
    .some(x=>!Number.isSafeInteger(x)||x<0))return 'invalid_counter';
  if(!input.contentReady)return 'context_missing';
  if(input.goalInFlight)return 'request_in_flight';
  const overdue=input.overdueActionRecheck===true && input.remainingSeconds===0 &&
    last!==null && input.state==='running';
  const retry=input.preDispatchRetry===true;
  if(!input.hasNewInformation&&!overdue&&!retry)return 'no_new_information';
  if(input.globalInFlight>=2)return 'global_concurrency_limit';
  if(input.conversationStartsLastHour>=12)return 'hourly_limit';
  const freshEvent=event!==null&&(last===null||event>last);
  if(input.state!=='running'&&!(input.state==='waiting'&&input.statusEvidenceArrived&&(freshEvent||retry)))return 'runtime_ineligible';
  if(now<15)return 'initial_delay';
  if(last!==null&&now-last<60)return 'cooldown';
  // Pending important events are coalesced even if a periodic check is due.
  if(freshEvent)return now-event!>=10?null:'event_coalescing';
  if(overdue||retry)return null;
  if(last===null)return null;
  const remaining=input.remainingSeconds;
  const interval=remaining===null
    ? input.unknownResults<=1?120:input.unknownResults===2?300:600
    : remaining<=1800?120:remaining<=7200?300:remaining<=28800?900:1800;
  return now-last>=interval?null:'adaptive_interval';
}
