import type {ObserverInput} from './observer-contract.js';
import type {ObserverResult} from './observer-provider.js';
import type {PassiveContextStore} from '../server/passive-context-store.js';
import type {PassiveGoals} from '../server/passive-goals.js';
import {decideTrigger, type TriggerReason} from './long-task-policy.js';
import {normalizeAdmissionReason, type AdmissionReason, type ObserverDiagnostics} from '../core/observer-diagnostics.js';
import {correctPace} from './pace-correction.js';
import {makeForecastRecord, type ForecastRecord, type ForecastVersions} from './forecast-record.js';
export interface ObserverWorker {
  /** Authenticated local key is accounting metadata, never observer prompt data. */
  observe(input: ObserverInput, signal: AbortSignal, conversationKey: string, turnGeneration?: number): Promise<ObserverResult>;
  status(): {active: boolean; disabled: boolean; poisoned: boolean; setupFailed?:boolean};
  disable(): void;
  close(): Promise<void>;
  provenance?: () => ForecastVersions|null;
  recoveryStatus?: () => {state: string; nextEligibleAt?: number | null | undefined; cooldownUntil?: number | null | undefined} | undefined;
}
export interface ObserverWorkerSource {
  acquire(conversationKey: string): ObserverWorker;
  release(conversationKey: string): Promise<void>;
  all(): readonly ObserverWorker[];
}
export interface ObserverObservation {
  kind:'runtime'|'request'|'result'|'skip'; at:number; key:string; generation:number; activeSeconds:number;
  runtime:string; version:number; requestId?:number; requestedAt?:number; observedActiveSeconds?:number;
  accepted?:boolean; status?:string; relation?:string;
  triggerReason?:TriggerReason|string; lastRequestActiveSeconds?:number|null; eligibleActiveSeconds?:number|null;
  activeTimeKnown?:boolean;
  estimate?:{remainingSeconds:number;errorPercent:number}|null;
  forecast?:Readonly<ForecastRecord>;
  forecastDiagnostic?:'provenance_unavailable'|'invalid_provenance';
  usage?:ObserverResult['usage'];
  timings?:ObserverResult['timings'];
}
interface Options {contexts: PassiveContextStore; goals: PassiveGoals; workers?: readonly ObserverWorker[]; workerSource?: ObserverWorkerSource; now: () => number; onChange?: () => void; closeTimeoutMs?: number; onObservation?:(record:ObserverObservation)=>void}
interface Entry {
  born: number; readyAfter: number; lastStart: number|null; eventAt: number|null;
  eventSequence: number; consumedEventSequence: number;
  version: number; consumed: number; unknown: number; starts: number[];
  runtime: string; statusEvidence: boolean; flight?: Flight;
  lastSkip?: string; sourceRevision?: number; sourceFinalAvailable?: boolean; eventReason?:TriggerReason;
  retryVersion?:number;retryUsedVersion?:number;
  lastResultStatus?:ObserverResult['status'];lastEstimateAt?:number;
  lastAdmissionReason?:AdmissionReason;
  goalIdentity?:object; predictionIdentity?:object|null; lastRequestActiveSeconds?:number;
  overdueEligibleActiveSeconds?:number; overdueReservedPrediction?:object;
  nearExpiryReservedPrediction?:object;
  timerFailures?:number;
  sourceClockAvailable?:boolean;
  sourceActiveSeconds?:number; predictionExcludedSeconds?:number;
  expiredTimerResults:number;
  ended:boolean;
}
interface Flight {key: string; ticket: object; controller: AbortController; worker: ObserverWorker; requestId:number; requestedAt:number; observedActiveSeconds:number;
  generation:number;runtime:string;version:number;triggerReason:TriggerReason; excludedActiveSeconds:number;
  lastRequestActiveSeconds:number|null; eligibleActiveSeconds:number|null; goalIdentity:object; schedulerGeneration:number; done?: Promise<void>}

/** Admission timing is local; durable spend admission belongs to each owned worker.
 * changed never dispatches synchronously on the task Hook/HTTP path.
 */
export class ObserverScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Map<string, Flight>();
  private readonly workerSource: ObserverWorkerSource;
  private disabled = false;
  private stopReason: ObserverDiagnostics['stopReason'];
  private stoppedAt: number | undefined;
  private capacityReached = false;
  private lastClock = 0;
  private requestSequence = 0;
  private schedulerGeneration = 0;
  private recoveryGeneration: number | undefined;
  private closing?: Promise<void>;
  constructor(private readonly options: Options) {
    const closeTimeout = options.closeTimeoutMs ?? 6000;
    if (!Number.isSafeInteger(closeTimeout) || closeTimeout < 1 || closeTimeout > 10000) throw new Error('INVALID_OBSERVER_CLOSE_TIMEOUT');
    if (options.workerSource) this.workerSource = options.workerSource;
    else {
      const workers = [...(options.workers ?? [])];
      if (workers.length < 1 || new Set(workers).size !== workers.length) throw new Error('INVALID_OBSERVER_WORKERS');
      const owners = new Map<string, ObserverWorker>();
      this.workerSource = {
        acquire: key => {
          const existing = owners.get(key); if (existing) return existing;
          const worker = workers.find(candidate => {
            if ([...owners.values()].includes(candidate) || this.flights.has(key)) return false;
            try { const state = candidate.status(); return !state.active && !state.disabled && !state.poisoned && state.setupFailed !== true; }
            catch { return false; }
          });
          if (!worker) throw new Error('OBSERVER_WORKERS_BUSY');
          owners.set(key, worker); return worker;
        },
        release: async key => { owners.delete(key); },
        all: () => workers,
      };
    }
  }
  private workers(): readonly ObserverWorker[] { return this.workerSource.all(); }
  private workerInFlight(worker: ObserverWorker): boolean { return [...this.flights.values()].some(flight => flight.worker === worker); }
  private time(): number {
    if(this.stopReason)return this.lastClock;
    const raw = this.options.now();
    if (!Number.isSafeInteger(raw) || raw < 0) throw new Error('INVALID_OBSERVER_CLOCK');
    this.lastClock = Math.max(raw, this.lastClock);
    return this.lastClock;
  }
  private workerState(worker: ObserverWorker) {
    try {return worker.status();} catch {return {active: true, disabled: true, poisoned: true};}
  }
  private notify(): void {
    try {this.options.onChange?.();} catch { /* A display failure cannot restart a call. */ }
  }
  private record(kind:ObserverObservation['kind'],key:string,entry:Entry,extra:Partial<ObserverObservation>={},flight?:Flight):void {
    if(!this.options.onObservation)return;
    try {
      const at=this.stopReason ? this.lastClock : this.time();
      if(this.stopReason&&kind==='skip'){
        this.options.onObservation({kind,at,key,generation:0,activeSeconds:0,activeTimeKnown:false,
          runtime:entry.runtime,version:entry.version,...extra});
        return;
      }
      // Rejected tickets may belong to a removed/replaced goal object, even if
      // a new object reuses its numeric generation. Do not mix its live clock in.
      const view=flight && extra.accepted!==true?null:this.options.goals.view(key,at);
      if(view || flight)this.options.onObservation({kind,at,key,generation:view?.generation??flight!.generation,
        activeSeconds:view?.activeSeconds??flight!.observedActiveSeconds,activeTimeKnown:view!==null&&this.options.goals.activeTimeKnown(key),
        runtime:view?.runtime??flight!.runtime,version:view?entry.version:flight!.version,...extra});
    }catch{/* Recording must never authorize, retry or interrupt inference. */}
  }
  private markEvent(entry:Entry,now:number,reason:TriggerReason):void {
    const hadPending=entry.eventSequence>entry.consumedEventSequence;
    entry.eventSequence++;
    if(!hadPending){entry.eventAt=now;entry.eventReason=reason;}
    else if(reason==='status_evidence')entry.eventReason=reason;
  }
  private syncGoal(entry:Entry,state:NonNullable<ReturnType<PassiveGoals['scheduling']>>):void {
    if(entry.goalIdentity===undefined){
      entry.goalIdentity=state.goalIdentity;entry.predictionIdentity=state.predictionIdentity;
      if(state.view.prediction)entry.overdueEligibleActiveSeconds=
        state.view.prediction.observedActiveSeconds+state.view.prediction.remainingSeconds+15;
      return;
    }
    if(entry.goalIdentity!==state.goalIdentity){
      entry.timerFailures=0;
      entry.sourceActiveSeconds=state.view.activeSeconds;entry.sourceClockAvailable=state.sourceAvailable;
      entry.predictionExcludedSeconds=0;
      entry.goalIdentity=state.goalIdentity;entry.predictionIdentity=state.predictionIdentity;
      entry.unknown=0;entry.expiredTimerResults=0;delete entry.overdueEligibleActiveSeconds;
      delete entry.overdueReservedPrediction;entry.lastRequestActiveSeconds=state.view.activeSeconds;
      if(state.view.prediction)entry.overdueEligibleActiveSeconds=
        state.view.prediction.observedActiveSeconds+state.view.prediction.remainingSeconds+15;
    } else if(entry.predictionIdentity!==state.predictionIdentity){
      entry.timerFailures=0;
      entry.predictionExcludedSeconds=0;
      entry.predictionIdentity=state.predictionIdentity;delete entry.overdueReservedPrediction;
      if(state.predictionIdentity===null){delete entry.overdueEligibleActiveSeconds;}
      else if(state.view.prediction){
        entry.overdueEligibleActiveSeconds=state.view.prediction.observedActiveSeconds+
          state.view.prediction.remainingSeconds+15;
      }
    }
  }
  private syncSourceClock(entry:Entry,state:NonNullable<ReturnType<PassiveGoals['scheduling']>>):void {
    const active=state.view.activeSeconds;
    // Availability is sampled: conservatively exclude the interval if either
    // endpoint is unavailable. Shift raw-coordinate anchors, never the HUD clock.
    const excluded=(state.sourceAvailable===false||entry.sourceClockAvailable===false)
      ?Math.max(0,active-(entry.sourceActiveSeconds??active)):0;
    if(excluded>0){
      if(entry.lastRequestActiveSeconds!==undefined)entry.lastRequestActiveSeconds+=excluded;
      if(entry.overdueEligibleActiveSeconds!==undefined)entry.overdueEligibleActiveSeconds+=excluded;
      entry.predictionExcludedSeconds=(entry.predictionExcludedSeconds??0)+excluded;
      if(entry.flight?.goalIdentity===state.goalIdentity)entry.flight.excludedActiveSeconds+=excluded;
    }
    entry.sourceActiveSeconds=active;entry.sourceClockAvailable=state.sourceAvailable;
  }
  private expiredBackoffSeconds(count:number):number {return count<=1?300:count===2?600:1800;}
  changed(key: string, event: 'prompt'|'activity'|'final'|'failure'|'runtime'): void {
    if (this.disabled) return;
    const now = this.time(), state = this.options.goals.scheduling(key, now);
    if (!state) return;
    let entry = this.entries.get(key);
    const selectedSource = state.revision !== undefined;
    if (!entry) {
      this.prune(now);
      if (this.entries.size >= 128) {this.capacityReached = true; return;}
      entry = {born: now, readyAfter: now + 15000, lastStart: null, eventAt: null,
        eventSequence:0, consumedEventSequence:0,
        version: selectedSource ? 1 : 0, consumed: 0, unknown: 0, starts: [], runtime: state.view.runtime,
        statusEvidence: false, expiredTimerResults:0, ended:false, goalIdentity:state.goalIdentity,
        predictionIdentity:state.predictionIdentity,
        sourceClockAvailable:state.sourceAvailable,
        sourceActiveSeconds:state.view.activeSeconds,
        ...(selectedSource ? {sourceRevision: state.revision, sourceFinalAvailable: state.finalAvailable} : {})};
      this.entries.set(key, entry);
    }
    this.syncGoal(entry,state);this.syncSourceClock(entry,state);
    if (selectedSource) {
      this.syncSource(entry, state.revision!);
      if (state.view.runtime === 'waiting' && state.finalAvailable && entry.sourceFinalAvailable !== true) {
        entry.statusEvidence = true;
      }
      entry.sourceFinalAvailable = state.finalAvailable;
    } else {
      entry.version++;
    }
    if (event === 'prompt') {entry.unknown = 0;entry.expiredTimerResults=0;delete entry.overdueEligibleActiveSeconds;
      delete entry.lastResultStatus;delete entry.lastAdmissionReason;delete entry.lastEstimateAt;delete entry.lastSkip;delete entry.retryVersion;}
    const resumed=entry.runtime!=='running'&&state.view.runtime==='running';
    if(event==='prompt')this.markEvent(entry,now,'important_event');
    if(event==='final'&&state.finalAvailable){entry.statusEvidence=true;this.markEvent(entry,now,'status_evidence');}
    if(event==='failure'){entry.unknown=0;entry.expiredTimerResults=0;this.markEvent(entry,now,'important_event');}
    if(event==='runtime'&&resumed){entry.statusEvidence=false;entry.unknown=0;entry.expiredTimerResults=0;
      delete entry.overdueEligibleActiveSeconds;this.markEvent(entry,now,'important_event');}
    entry.runtime = state.view.runtime;
    if (['paused', 'stopped', 'failed', 'interrupted'].includes(entry.runtime)) entry.flight?.controller.abort();
    this.record('runtime',key,entry);
  }
  private syncSource(entry: Entry, revision: number): void {
    if (entry.sourceRevision !== revision) entry.version++;
    entry.sourceRevision = revision;
  }
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      entry.starts = entry.starts.filter(start => now - start < 3600000);
      if (!entry.flight && !entry.starts.length && !this.options.goals.view(key, now)) this.entries.delete(key);
    }
  }
  private skip(key:string,entry:Entry,reason:string):void {
    if(entry.lastSkip===reason)return;
    entry.lastSkip=reason;
    this.record('skip',key,entry,{status:reason});
    this.notify();
  }
  tickSafely(): void {
    try { this.tick(); }
    catch (error) {
      this.stopReason ??= error instanceof Error && error.message === 'INVALID_OBSERVER_CLOCK'
        ? 'invalid_clock' : 'scheduler_exception';
      this.stoppedAt ??= this.lastClock;
      this.disable();
      for (const [key,entry] of this.entries) this.skip(key,entry,this.stopReason);
      this.notify();
    }
  }
  presentationTime(): number { return this.time(); }
  tick(): void {
    if (this.disabled) {
      for(const [key,entry] of this.entries)this.skip(key,entry,'observer_disabled');
      return;
    }
    const now = this.time(); this.prune(now);
    for (const [key, entry] of [...this.entries]) {
      if(entry.ended)continue;
      let worker = this.workers().find(candidate => {
        const state = this.workerState(candidate);
        if (this.workerInFlight(candidate) || state.active || state.disabled || state.poisoned) return false;
        try {
          const recovery = candidate.recoveryStatus?.();
          return recovery?.nextEligibleAt !== undefined && recovery.nextEligibleAt !== null && now < recovery.nextEligibleAt ? false
            : recovery?.cooldownUntil !== undefined && recovery.cooldownUntil !== null && now < recovery.cooldownUntil ? false : true;
        } catch { return false; }
      });
      const state = this.options.goals.scheduling(key, now);
      if (!state) {entry.flight?.controller.abort(); continue;}
      const selectedSource = state.revision !== undefined;
      if (selectedSource) {
        this.syncSource(entry, state.revision!);
        if (state.view.runtime === 'waiting' && state.finalAvailable && entry.sourceFinalAvailable !== true) {
          entry.statusEvidence = true;this.markEvent(entry,now,'status_evidence');
        }
        entry.sourceFinalAvailable = state.finalAvailable;
      }
      this.syncGoal(entry,state);
      this.syncSourceClock(entry,state);
      const view = state.view;
      const runtime = view.status === 'completed' || ['stopped', 'failed', 'interrupted'].includes(view.runtime)
        ? 'terminal' : view.runtime === 'paused' ? 'paused' : view.runtime === 'waiting' ? 'waiting' : 'running';
      const prediction = view.prediction;
      const remaining = prediction ? Math.max(0, prediction.remainingSeconds - Math.max(0,
        view.activeSeconds - prediction.observedActiveSeconds - (entry.predictionExcludedSeconds??0))) : null;
      if(state.ready && now<entry.readyAfter){this.skip(key,entry,'initial_delay');continue;}
      // Prediction identity, not a tool event or wall timer, owns this one-shot.
      // Source outages are excluded from remaining above, as are user pauses.
      const nearExpiryReady=state.predictionIdentity!==null&&prediction!==null&&remaining!==null&&
        remaining>0&&remaining<=prediction.remainingSeconds*0.2&&
        entry.nearExpiryReservedPrediction!==state.predictionIdentity;
      const overdueReady=state.predictionIdentity!==null&&remaining===0&&
        entry.overdueReservedPrediction!==state.predictionIdentity&&
        (entry.overdueEligibleActiveSeconds===undefined||view.activeSeconds>=entry.overdueEligibleActiveSeconds);
      const overdueAlready=state.predictionIdentity!==null&&remaining===0&&
        entry.overdueReservedPrediction===state.predictionIdentity;
      const retryBackoff=state.predictionIdentity!==null&&remaining===0&&!overdueReady&&!overdueAlready&&
        entry.overdueEligibleActiveSeconds!==undefined&&view.activeSeconds<entry.overdueEligibleActiveSeconds;
      // Repeated recoverable failures slow observation; they never permanently
      // consume the ability to observe a still-running, unchanged long task.
      const failureBackoff=(entry.timerFailures??0)>=2&&entry.version<=entry.consumed&&
        entry.lastRequestActiveSeconds!==undefined&&view.activeSeconds<entry.lastRequestActiveSeconds+
          this.expiredBackoffSeconds(entry.timerFailures!);
      const decision=decideTrigger({elapsedSeconds: (now - entry.born) / 1000,
        lastRequestSeconds: entry.lastStart === null ? null : (entry.lastStart - entry.born) / 1000,
        eventAtSeconds: entry.eventAt === null ? null : (entry.eventAt - entry.born) / 1000,
        ...(entry.eventReason===undefined?{}:{eventReason:entry.eventReason}),
        eventSequence:entry.eventSequence,consumedEventSequence:entry.consumedEventSequence,
        remainingSeconds: remaining, unknownResults: entry.unknown, contentReady: state.ready,
        hasNewInformation: entry.version > entry.consumed, activeSeconds:view.activeSeconds,
        lastRequestActiveSeconds:entry.lastRequestActiveSeconds??null,
        overdueActionRecheck: overdueReady,overdueAlreadyChecked:overdueAlready,
        nearExpiryRecheck:nearExpiryReady,
        overdueEligibleActiveSeconds:entry.overdueEligibleActiveSeconds??null,retryBackoff:retryBackoff||failureBackoff,
        preDispatchRetry:entry.retryVersion===entry.version,
        state: runtime, statusEvidenceArrived: entry.statusEvidence,
        goalInFlight: entry.flight !== undefined, globalInFlight: this.flights.size, conversationStartsLastHour: entry.starts.length});
      if(decision.blockReason){this.skip(key,entry,decision.blockReason);continue;}
      if (!worker) {
        try { worker = this.workerSource.acquire(key); }
        catch { worker = undefined; }
      }
      if(!worker){
        const recoveryDeferred=this.workers().some(candidate=>{
          const state=this.workerState(candidate);if(this.workerInFlight(candidate)||state.active||state.disabled||state.poisoned)return false;
          try{const recovery=candidate.recoveryStatus?.();return recovery?.nextEligibleAt!==undefined&&recovery.nextEligibleAt!==null&&now<recovery.nextEligibleAt||recovery?.cooldownUntil!==undefined&&recovery.cooldownUntil!==null&&now<recovery.cooldownUntil;}catch{return false;}
        });
        this.skip(key,entry,this.workers().some(candidate=>this.workerState(candidate).setupFailed)?'setup_failed':recoveryDeferred?'recovery_cooldown':'worker_unavailable');continue;
      }
      const request = this.options.goals.request(key, now);
      if (!request) {this.skip(key,entry,'request_unavailable');continue;}
      delete entry.lastSkip;
      const flight: Flight = {key, ticket: request.ticket, controller: new AbortController(), worker,
        requestId:++this.requestSequence,requestedAt:now,observedActiveSeconds:request.input.activeSeconds,
        generation:view.generation,runtime:view.runtime,version:entry.version,triggerReason:decision.reason!,
        lastRequestActiveSeconds:entry.lastRequestActiveSeconds??null,eligibleActiveSeconds:decision.eligibleActiveSeconds,
        goalIdentity:state.goalIdentity,excludedActiveSeconds:0,schedulerGeneration:this.schedulerGeneration};
      entry.flight = flight; entry.lastStart = now; entry.starts.push(now); entry.consumed = entry.version;
      entry.consumedEventSequence=entry.eventSequence;
      entry.lastRequestActiveSeconds=request.input.activeSeconds;
      if(entry.retryVersion===entry.version)entry.retryUsedVersion=entry.version;
      delete entry.retryVersion;
      if (overdueReady&&state.predictionIdentity!==null)entry.overdueReservedPrediction=state.predictionIdentity;
      if (nearExpiryReady&&state.predictionIdentity!==null)entry.nearExpiryReservedPrediction=state.predictionIdentity;
      entry.statusEvidence = false; this.flights.set(key, flight);
      // Rotate for fairness; reserve both local slot and hourly start before provider code.
      this.entries.delete(key); this.entries.set(key, entry);
      this.record('request',key,entry,{requestId:flight.requestId,triggerReason:flight.triggerReason,
        lastRequestActiveSeconds:flight.lastRequestActiveSeconds,eligibleActiveSeconds:flight.eligibleActiveSeconds});
      this.notify();
      try {
        flight.done = Promise.resolve(worker.observe(request.input, flight.controller.signal, key, view.generation))
          .then(result => this.settle(entry, flight, result), () => this.settle(entry, flight, null));
      } catch {this.settle(entry, flight, null);}
    }
  }
  private settle(entry: Entry, flight: Flight, result: ObserverResult|null): void {
    const before=this.options.goals.scheduling(flight.key,this.time());
    if(before&&before.goalIdentity===flight.goalIdentity&&entry.goalIdentity===flight.goalIdentity)
      this.syncSourceClock(entry,before);
    const state = this.workerState(flight.worker);
    if (state.active || state.poisoned) {
      this.options.goals.settle(flight.ticket, null, this.time());
      this.recordResult(entry,flight,result,false);
      this.flights.delete(flight.key); if (entry.flight === flight) delete entry.flight;
      void this.workerSource.release(flight.key).catch(() => undefined);
      this.notify(); return;
    }
    this.flights.delete(flight.key);
    if (entry.flight === flight) delete entry.flight;
    const provenTransient = result?.status==='process_error' && result.outcomes?.dispatch==='not_started'
      && result.outcomes.closureConfirmed && result.outcomes.retryable==='pre_dispatch_transient';
    const provenCancellation=result?.usage===null&&['aborted','disabled'].includes(result.status)
      &&result.outcomes?.usage==='not_dispatched'&&result.outcomes.dispatch==='not_started'
      &&result.outcomes.closureConfirmed&&result.outcomes.call==='cancelled';
    const proof = result?.outcomes;
    const configurationBlocked = result?.status === 'disabled' && proof?.dispatch === 'not_started' &&
      proof.closureConfirmed && (proof.failureCode === 'unauthorized' || proof.failureCode === 'forbidden');
    const noDispatch = provenCancellation || provenTransient || configurationBlocked || result && ['invalid_input', 'admission_denied', 'busy'].includes(result.status);
    const safeUnknownUsage = result?.usage === null && proof?.usage === 'unknown'
      && proof.call === 'success' && proof.framingValid && proof.closureConfirmed
      && proof.dispatch === 'started' && proof.prediction !== 'invalid';
    const trustedDurableFailure = result?.usage === null && proof?.accounting === 'durably_settled'
      && proof.closureConfirmed;
    const mustDisable = result?.status === 'accounting_error';
    // Capture external cancellation before the accounting safety stop aborts other flights.
    // A valid answer is not permission to make another call; goal tickets still reject stale answers.
    const eligible = flight.schedulerGeneration === this.schedulerGeneration && !this.disabled && !state.disabled && !flight.controller.signal.aborted
      && result?.status === 'interpreted' && (!mustDisable || safeUnknownUsage);
    const settledAt=this.time();
    const accepted = this.options.goals.settle(flight.ticket,
      eligible ? result!.interpretation : null, settledAt);
    const live=this.options.goals.scheduling(flight.key,settledAt);
    const sameGoal=live!==null&&live.goalIdentity===flight.goalIdentity&&entry.goalIdentity===flight.goalIdentity;
    const localResultAllowed=accepted||sameGoal;
    if(sameGoal&&entry.version===flight.version&&result?.status==='process_error'&&
      ['near_expiry','overdue','periodic'].includes(flight.triggerReason))
      entry.timerFailures=Math.min(8,(entry.timerFailures??0)+1);
    if(provenTransient && !this.disabled && !state.disabled && !flight.controller.signal.aborted
      && sameGoal && entry.version===flight.version && entry.retryUsedVersion!==flight.version){
      entry.retryVersion=flight.version;
      if(flight.runtime==='waiting')entry.statusEvidence=true;
    }
    if (mustDisable) {
      this.stopReason ??= 'accounting_error';this.stoppedAt ??= this.lastClock;
      this.disable();
    }
    if(entry.version===flight.version&&localResultAllowed){
      entry.lastResultStatus=result?.status??'process_error';
      if(result?.status==='admission_denied')entry.lastAdmissionReason=normalizeAdmissionReason(result.admissionReason);
      else delete entry.lastAdmissionReason;
    }
    if(accepted&&result?.interpretation?.estimate&&live){
      entry.timerFailures=0;
      entry.sourceActiveSeconds=live.view.activeSeconds;entry.sourceClockAvailable=live.sourceAvailable;
      entry.predictionExcludedSeconds=flight.excludedActiveSeconds;
      entry.lastEstimateAt=flight.requestedAt;
      entry.unknown=0;
      if(live.goalIdentity!==flight.goalIdentity)entry.lastRequestActiveSeconds=live.view.activeSeconds;
      entry.goalIdentity=live.goalIdentity;entry.predictionIdentity=live.predictionIdentity;
      if(result.interpretation.estimate.remainingSeconds===0&&
        (flight.triggerReason==='overdue'||flight.triggerReason==='periodic')){
        entry.expiredTimerResults=Math.min(8,entry.expiredTimerResults+1);
        entry.overdueEligibleActiveSeconds=live.view.activeSeconds+this.expiredBackoffSeconds(entry.expiredTimerResults);
      }else{
        entry.expiredTimerResults=0;
        if(live.view.prediction)entry.overdueEligibleActiveSeconds=
          live.view.prediction.observedActiveSeconds+live.view.prediction.remainingSeconds+flight.excludedActiveSeconds+15;
        else delete entry.overdueEligibleActiveSeconds;
      }
      delete entry.overdueReservedPrediction;
    } else if(accepted&&result?.interpretation?.estimate===null&&live){
      const predictionRetained=sameGoal&&live.predictionIdentity!==null&&live.predictionIdentity===entry.predictionIdentity;
      entry.timerFailures=0;
      entry.sourceActiveSeconds=live.view.activeSeconds;entry.sourceClockAvailable=live.sourceAvailable;
      if(!predictionRetained)entry.predictionExcludedSeconds=0;
      if(live.goalIdentity!==flight.goalIdentity)entry.lastRequestActiveSeconds=live.view.activeSeconds;
      entry.goalIdentity=live.goalIdentity;entry.predictionIdentity=live.predictionIdentity;
      entry.unknown=Math.min(8,entry.unknown+1);
      if(!predictionRetained){entry.expiredTimerResults=0;
        delete entry.overdueEligibleActiveSeconds;delete entry.overdueReservedPrediction;}
    }
    this.recordResult(entry,flight,result,accepted,settledAt,live);
    void this.workerSource.release(flight.key).catch(() => undefined);
    this.notify();
  }
  private recordResult(entry:Entry,flight:Flight,result:ObserverResult|null,accepted:boolean,
    acceptedAt=this.time(),live:NonNullable<ReturnType<PassiveGoals['scheduling']>>|null=null):void {
    let forecast:Readonly<ForecastRecord>|undefined;
    let forecastDiagnostic:ObserverObservation['forecastDiagnostic'];
    const snapshotAnchor=accepted?this.options.goals.settledAnchor(flight.ticket):flight.observedActiveSeconds;
    if(accepted && live){
      let versions:ForecastVersions|null=null;
      try {versions=flight.worker.provenance?.() ?? null;} catch {forecastDiagnostic='provenance_unavailable';}
      if(versions===null)forecastDiagnostic='provenance_unavailable';
      else if(forecastDiagnostic===undefined) {
        try {
          const rawSeconds=result?.interpretation?.estimate?.remainingSeconds ?? null;
          const work=result?.interpretation?.work ?? null;
          const intervals=this.options.goals.paceIntervals(flight.ticket,work);
          const pace=rawSeconds===null?{seconds:null,reason:'missing_measurements' as const}:
            correctPace(rawSeconds,work,intervals);
          forecast=makeForecastRecord({schemaVersion:1,predictionId:flight.requestId,generation:live.view.generation,
            snapshotActiveSeconds:snapshotAnchor ?? Number.NaN,
            acceptedAt,rawSeconds,shadowSeconds:pace.seconds,
            paceReason:pace.reason,calibration:'uncalibrated',
            ...(pace.reason==='eligible'&&pace.seconds!==null?{measurement:{source:'vitest_json' as const,clock:'tool_execution' as const,
              remainingUnitsProvenance:'model_hypothesis' as const,sampleCount:Math.min(intervals.length,5)}}:{}),versions});
        } catch {forecastDiagnostic='invalid_provenance';}
      }
    }
    this.record('result',flight.key,entry,{requestId:flight.requestId,requestedAt:flight.requestedAt,
      ...(!accepted?{generation:flight.generation}:{}),
      ...(snapshotAnchor===undefined?{}:{observedActiveSeconds:snapshotAnchor}),
      triggerReason:flight.triggerReason,lastRequestActiveSeconds:flight.lastRequestActiveSeconds,
      eligibleActiveSeconds:flight.eligibleActiveSeconds,
      accepted,status:result?.status??'process_error',
      ...(result?.interpretation?{relation:result.interpretation.relation}:{}),
      estimate:result?.interpretation?.estimate?{...result.interpretation.estimate}:null,
      ...(forecast?{forecast}:{}),...(forecastDiagnostic?{forecastDiagnostic}:{}),
      ...(result?.timings?{timings:{...result.timings}}:{}),
      usage:result?.usage?{...result.usage}:null},flight);
  }
  stats() {return {disabled: this.disabled, inFlight: this.flights.size, tracked: this.entries.size, capacityReached: this.capacityReached};}
  async prepareRecovery(): Promise<number> {
    if (this.closing) throw new Error('OBSERVER_RECOVERY_DISABLED');
    if (this.recoveryGeneration !== undefined) return this.recoveryGeneration;
    this.disabled = true;
    const generation = ++this.schedulerGeneration;
    this.recoveryGeneration = generation;
    for (const flight of this.flights.values()) flight.controller.abort();
    for (const worker of this.workers()) {try {worker.disable();} catch { /* status verification below fails closed */ }}
    await Promise.allSettled([...this.flights.values()].flatMap(flight => flight.done ? [flight.done] : []));
    if (this.flights.size > 0 || this.workers().some(worker => {
      const state = this.workerState(worker);
      return state.active || state.poisoned;
    })) {
      this.recoveryGeneration = undefined;
      throw new Error('OBSERVER_RECOVERY_CLOSE_UNCONFIRMED');
    }
    return generation;
  }
  async restoreRecovery(generation: number): Promise<void> {
    if (this.recoveryGeneration !== generation) throw new Error('OBSERVER_RECOVERY_STALE');
    if (this.flights.size > 0 || this.workers().some(worker => {
      const state = this.workerState(worker);
      return state.active || state.disabled || state.poisoned;
    })) throw new Error('OBSERVER_RECOVERY_CLOSE_UNCONFIRMED');
    this.recoveryGeneration = undefined;
    this.disabled = false;
    this.stopReason = undefined;this.stoppedAt = undefined;
    this.notify();
  }
  diagnostics(key:string):ObserverDiagnostics {
    if(this.stopReason)return {state:'disabled',stopReason:this.stopReason,stoppedAt:this.stoppedAt!,
      estimateAgeSeconds:null,callsLastHour:this.entries.get(key)?.starts.filter(start=>this.lastClock-start<3600000).length??0,retryPending:false};
    const at=this.stopReason ? this.lastClock : this.time(),entry=this.entries.get(key),view=this.options.goals.view(key,at);
    const health=this.options.goals.contextHealth(key);
    const state:ObserverDiagnostics['state']=this.disabled?'disabled':entry?.flight?'estimating':
      this.workers().some(worker=>this.workerState(worker).setupFailed)?'setup_failed':
      entry?.lastResultStatus==='admission_denied'?'admission_blocked':
      ['hourly_limit','global_concurrency_limit'].includes(entry?.lastSkip??'')?'rate_limited':
      entry?.lastSkip==='context_missing'?(health==='loading'?'history_loading':
        health==='error'||health==='missing'?'history_unavailable':'insufficient_context'):
      entry?.lastResultStatus==='process_error'?'call_failed':
      view?.prediction?'ready':entry?.lastResultStatus==='interpreted'?'insufficient_context':'pending';
    return {state,...(this.stopReason ? {stopReason:this.stopReason,stoppedAt:this.stoppedAt!} : {}),...(state==='admission_blocked'?{admissionReason:normalizeAdmissionReason(entry?.lastAdmissionReason)}:{}),
      estimateAgeSeconds:view?.prediction&&entry?.lastEstimateAt!==undefined?Math.max(0,(at-entry.lastEstimateAt)/1000):null,
      callsLastHour:entry?.starts.filter(start=>at-start<3600000).length??0,
      retryPending:entry?.retryVersion!==undefined&&entry.retryVersion===entry.version};
  }
  end(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.consumed = entry.version; entry.statusEvidence = false; entry.flight?.controller.abort();
    entry.ended=true;
    delete entry.retryVersion;
  }
  disable(): void {
    this.disabled = true;
    for (const flight of this.flights.values()) flight.controller.abort();
    const workers=new Set([...this.flights.values()].map(flight=>flight.worker));
    try { for(const worker of this.workers())workers.add(worker); } catch { /* Enumeration failure must not escape the timer fault handler. */ }
    for (const worker of workers) {try {worker.disable();} catch { /* Keep ownership until close. */ }}
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disable();
    const drain = (async () => {
      const results = await Promise.allSettled(this.workers().map(worker => Promise.resolve().then(() => worker.close())));
      await Promise.allSettled([...this.flights.values()].flatMap(flight => flight.done ? [flight.done] : []));
      if (results.some(result => result.status === 'rejected') || this.workers().some(worker => this.workerState(worker).active)) {
        throw new Error('OBSERVER_CLOSE_UNCONFIRMED');
      }
      this.flights.clear(); this.entries.clear();
    })();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('OBSERVER_CLOSE_UNCONFIRMED')), this.options.closeTimeoutMs ?? 6000);
    });
    this.closing = Promise.race([drain, deadline]).finally(() => clearTimeout(timer));
    return this.closing;
  }
}
