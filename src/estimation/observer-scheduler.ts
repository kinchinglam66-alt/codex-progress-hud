import type {ObserverInput} from './observer-contract.js';
import {isInferenceEligible} from './observer-contract.js';
import type {ObserverResult} from './observer-provider.js';
import type {ObserverCallStage} from './observer-provider.js';
import type {PassiveContextStore} from '../server/passive-context-store.js';
import type {PassiveGoals} from '../server/passive-goals.js';
import type {HistorySnapshot} from '../observer/history-snapshot.js';
import type {VerifiedHistoryFallback} from '../observer/verified-history-fallback.js';
import {assertCheckpointWindow,verifyHistoryFallback} from '../observer/verified-history-fallback.js';
import type {NativeSourceDestination,OpenNativeSourceResult,NativeObservationSample,BoundNativeTurnSource} from '../observer/native-source-request.js';
import type {ContextPreparationMetrics, PreparedContext} from './prepared-context.js';
import {decideTrigger, ordinaryRequestIntervalSeconds, type TriggerReason} from './long-task-policy.js';
import {createNativeRetentionPermit,type NativeRetentionPermit,type NativeRetentionState,type NativeLifecycleDiagnostic} from './native-owner-retention.js';
import {normalizeAdmissionReason, schedulingReasons, type SchedulingReason, type AdmissionReason, type ObserverContextState, type ObserverDiagnostics, type ResultDiagnostic, type ResultRejectionReason} from '../core/observer-diagnostics.js';
export type {ObserverContextState} from '../core/observer-diagnostics.js';
import {correctPace} from './pace-correction.js';
import {makeForecastRecord, type ForecastRecord, type ForecastVersions} from './forecast-record.js';
import type {ResidualRuntime} from './residual/runtime.js';
import {captureHistoryFeatures} from './residual/capture.js';
import {createRequestProfile,type RequestProfile,type RequestProfilePhase} from './request-profile.js';
import {workerAcquisitionReason} from '../core/observer-diagnostics.js';
export interface ObserverWorker {
  /** Passive per-flight timing; the returned function detaches only this listener. */
  subscribeContextPhase?(listener:(phase:RequestProfilePhase)=>void):()=>void;
  prepareNativeHistoryFallback?(input:ObserverInput,history:VerifiedHistoryFallback,signal:AbortSignal,
    conversationKey:string,turnGeneration:number,observedAtMs:number,sample?:()=>NativeObservationSample,policy?:{checkpointOnly:true}):Promise<PreparedContext>;
  prepareNativeTurnContext?(input:ObserverInput,source:BoundNativeTurnSource,signal:AbortSignal,
    conversationKey:string,turnGeneration:number,observedAtMs:number,sample?:()=>NativeObservationSample):Promise<PreparedContext>;
  nativeSourceDestination?(signal:AbortSignal):Promise<NativeSourceDestination>;
  prepareNativeContext?(input:ObserverInput,source:OpenNativeSourceResult,signal:AbortSignal,
    conversationKey:string,turnGeneration:number,observedAtMs:number,sample?:()=>NativeObservationSample):Promise<{input:ObserverInput;sourceBytes:number;sourceRevision:number}>;
  /** Authenticated local key is accounting metadata, never observer prompt data. */
  observe(input: ObserverInput, signal: AbortSignal, conversationKey: string, turnGeneration?: number,
    onStage?: (stage:ObserverCallStage)=>void): Promise<ObserverResult>;
  prepareContext?(input:ObserverInput,history:{snapshot:HistorySnapshot;currentTurnId:string},signal:AbortSignal,
    conversationKey:string,turnGeneration:number,observedAtMs:number):Promise<PreparedContext>;
  status(): {active: boolean; disabled: boolean; poisoned: boolean; setupFailed?:boolean;cleanupPending?:boolean;nativeLifecycle?:NativeLifecycleDiagnostic};
  disable(): void;
  close(): Promise<void>;
  /** Finish scheduler ownership of one operation, retaining healthy model context.
   * Global shutdown still calls close(), never release(). */
  release?(permit?:NativeRetentionPermit|null): Promise<void>;
  updateRetentionState?(state:NativeRetentionState|null):void;
  provenance?: () => ForecastVersions|null;
  recoveryStatus?: () => {state: string; nextEligibleAt?: number | null | undefined; cooldownUntil?: number | null | undefined} | undefined;
}
export interface ObserverWorkerSource {
  acquire(conversationKey: string): ObserverWorker;
  release(conversationKey: string,permit?:NativeRetentionPermit|null): Promise<void>;
  updateRetentionState?(conversationKey:string,state:NativeRetentionState|null):void;
  all(): readonly ObserverWorker[];
}
export interface ObserverObservation {
  milestone?:{id:string;judgment:'in_progress'|'observed_complete'|'inferred_complete'|'unknown';prediction:{remainingSeconds:number;errorPercent:number;observedActiveSeconds:number}|null};
  eventCutoff?:number;
  pendingCriticalEvents?:number;
  nativeFallbackReason?:'pair_unavailable'|'source_unobserved'|'source_checkpoint_unsupported'|'source_terminal_unsupported'|'source_limit'|'history_incomplete';
  kind:'runtime'|'request'|'result'|'skip'|'stage'; at:number; key:string; generation:number; activeSeconds:number;
  runtime:string; version:number; requestId?:number; requestedAt?:number; observedActiveSeconds?:number;
  accepted?:boolean; status?:string; relation?:string;
  triggerReason?:TriggerReason|string; lastRequestActiveSeconds?:number|null; eligibleActiveSeconds?:number|null;
  activeTimeKnown?:boolean;
  timingUncertain?:boolean;
  recoveryState?:'pending'|'restored';
  recoveryGapSeconds?:number|null;
  estimate?:{remainingSeconds:number;errorPercent:number}|null;
  resultDiagnostic?:ResultDiagnostic;
  rejectionReason?:ResultRejectionReason;
  forecast?:Readonly<ForecastRecord>;
  forecastDiagnostic?:'provenance_unavailable'|'invalid_provenance';
  usage?:ObserverResult['usage'];
  timings?:ObserverResult['timings'];
  requestProfile?:RequestProfile;
  stage?:ObserverCallStage;
  contextState?:ObserverContextState;
  contextMetrics?:ContextPreparationMetrics;
}
interface Options {contexts: PassiveContextStore; goals: PassiveGoals; workers?: readonly ObserverWorker[]; workerSource?: ObserverWorkerSource; now: () => number; monotonicNow?:()=>number; onChange?: () => void; closeTimeoutMs?: number; requestTimeoutMs?:number; onObservation?:(record:ObserverObservation)=>void;research?:ResidualRuntime}
interface Entry {
  criticalEvents?:Array<{sequence:number;revision:number|null;at:number}>;
  progressScope?:string;progressEventSequence?:number;milestoneTimerReservation?:string;
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
  contextState?:ObserverContextState; contextStateTurnKey?:string;
  missingImages?:number;qualityTurnKey?:string;
  contentIdentity?:string; consumedContentIdentity?:string;
  bootstrapRecoveryEligible?:boolean; bootstrapRecoveryUsed?:boolean;
  lastResultDiagnostic?:ResultDiagnostic; lastRejectionReason?:ResultRejectionReason;
  expiredTimerResults:number;
  expiredResultPending?:boolean;
  ended:boolean;
}
interface Flight {researchFailure?:import('./residual/contract.js').PrefixFailure;researchGeneration?:number;researchTicket?:object;key: string; ticket: object; controller: AbortController; worker: ObserverWorker; requestId:number; requestedAt:number; observedActiveSeconds:number;
  eventCutoff?:number;
  generation:number;runtime:string;version:number;triggerReason:TriggerReason; excludedActiveSeconds:number;
  lastRequestActiveSeconds:number|null; eligibleActiveSeconds:number|null; goalIdentity:object; schedulerGeneration:number;
  deadlineAt?:number; timedOut?:boolean;
  profile:ReturnType<typeof createRequestProfile>;
  turnKey:string; contextState?:ObserverContextState; contextMetrics?:ContextPreparationMetrics; done?: Promise<void>}

/** Admission timing is local; durable spend admission belongs to each owned worker.
 * changed never dispatches synchronously on the task Hook/HTTP path.
 */
export class ObserverScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Map<string, Flight>();
  private readonly workerSource: ObserverWorkerSource;
  private readonly sourceAwareWorkers: boolean;
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
    const requestTimeout=options.requestTimeoutMs??0;
    if(!Number.isSafeInteger(requestTimeout)||requestTimeout<0||requestTimeout>2_147_483_647)throw Error('INVALID_ESTIMATE_TIMEOUT');
    const closeTimeout = options.closeTimeoutMs ?? 6000;
    if (!Number.isSafeInteger(closeTimeout) || closeTimeout < 1 || closeTimeout > 10000) throw new Error('INVALID_OBSERVER_CLOSE_TIMEOUT');
    this.sourceAwareWorkers = options.workerSource !== undefined;
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
        release: async (key,permit) => {const worker=owners.get(key);await worker?.release?.(permit);owners.delete(key);},
        updateRetentionState:(key,state)=>owners.get(key)?.updateRetentionState?.(state),
        all: () => workers,
      };
    }
  }
  private workers(): readonly ObserverWorker[] { return this.workerSource.all(); }
  private retentionState(key:string,state:ReturnType<PassiveGoals['scheduling']>):NativeRetentionState|null {
    const turnKey=this.options.goals.currentTurnKey(key);
    return state&&turnKey?{conversationKey:key,turnKey,generation:state.view.generation,
      idleEligible:!this.disabled&&state.sourceAvailable!==false&&state.finalAvailable===true&&state.view.runtime==='waiting',
      running:!this.disabled&&state.sourceAvailable!==false&&state.view.runtime==='running'&&state.view.status!=='completed'}:null;
  }
  private releaseRetention(entry:Entry,flight:Flight,accepted:boolean,live:ReturnType<PassiveGoals['scheduling']>):void {
    let permit:NativeRetentionPermit|null=null;
    try{
    const state=this.retentionState(flight.key,live);
    this.workerSource.updateRetentionState?.(flight.key,state);
    if(accepted&&live&&state&&state.turnKey===flight.turnKey&&state.generation===flight.generation&&
      live.goalIdentity===flight.goalIdentity&&Number.isFinite(live.view.activeSeconds)&&
      entry.lastRequestActiveSeconds!==undefined){
      const prediction=live.view.prediction;
      const remaining=prediction?Math.max(0,prediction.remainingSeconds-Math.max(0,
        live.view.activeSeconds-prediction.observedActiveSeconds-(entry.predictionExcludedSeconds??0))):null;
      const until=Math.max(0,entry.lastRequestActiveSeconds+ordinaryRequestIntervalSeconds(remaining,entry.unknown)-live.view.activeSeconds);
      const idleStartedAtMs=(this.options.monotonicNow??(()=>performance.now()))();
      permit=createNativeRetentionPermit({...state,idleStartedAtMs,nextOrdinaryAtMs:idleStartedAtMs+until*1000});
    }
    }catch{permit=null;}
    // Retention is optional. A failed clock/state provider must neither skip
    // cleanup nor re-enter settlement and overwrite an already accepted ETA.
    try{void this.workerSource.release(flight.key,permit).catch(()=>undefined);}catch{}
  }
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
  private schedulerRejectionReason(flight:Flight,state:ReturnType<ObserverScheduler['workerState']>):ResultRejectionReason|undefined {
    if(this.disabled)return 'scheduler_disabled';
    if(flight.schedulerGeneration!==this.schedulerGeneration)return 'scheduler_stale';
    if(flight.controller.signal.aborted)return 'scheduler_aborted';
    if(state.disabled)return 'worker_disabled';
    if(state.active||state.poisoned)return 'worker_stale';
    return undefined;
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
        ...(view?.progressState?.milestone?{milestone:{id:view.progressState.milestone.id,judgment:view.progressState.milestone.judgment,prediction:view.progressState.milestone.prediction}}:{}),
        eventCutoff:flight?.eventCutoff??entry.consumedEventSequence,pendingCriticalEvents:Math.max(0,entry.eventSequence-entry.consumedEventSequence),
        activeSeconds:view?.activeSeconds??flight!.observedActiveSeconds,activeTimeKnown:view!==null&&this.options.goals.activeTimeKnown(key),
        ...(view?{timingUncertain:view.timingUncertain,recoveryState:view.recoveryState,recoveryGapSeconds:view.recoveryGapSeconds}:{}),
        runtime:view?.runtime??flight!.runtime,version:view?entry.version:flight!.version,...extra});
    }catch{/* Recording must never authorize, retry or interrupt inference. */}
  }
  private contextState(flight:Flight,state:ObserverContextState,metrics?:ContextPreparationMetrics):void {
    if(flight.timedOut&&state!=='estimate_timeout')return;
    flight.contextState=state;
    if(metrics)flight.contextMetrics={sizing:metrics.sizing,originalTextBytes:metrics.originalTextBytes,
      originalTextTokenEstimate:metrics.originalTextTokenEstimate,preparedRequestBytes:metrics.preparedRequestBytes,
      preparedTokenEstimate:metrics.preparedTokenEstimate,compressionCalls:metrics.compressionCalls,
      cachedCompressionCalls:metrics.cachedCompressionCalls};
    const entry=this.entries.get(flight.key);
    const currentView=this.options.goals.view(flight.key,this.time());
    const ownsEntry=entry?.flight===flight&&entry.goalIdentity===flight.goalIdentity&&
      currentView?.generation===flight.generation&&this.options.goals.currentTurnKey(flight.key)===flight.turnKey;
    if(ownsEntry){entry.contextState=state;entry.contextStateTurnKey=flight.turnKey;}
    if(!entry)return;
    this.record('stage',flight.key,entry,{requestId:flight.requestId,contextState:state,
      ...(flight.contextMetrics?{contextMetrics:{...flight.contextMetrics}}:{})},flight);
    if(ownsEntry)this.notify();
  }
  private preparationFailureState(flight:Flight,error:unknown):ObserverContextState {
    const code=error instanceof Error?error.message:'';
    if(code==='capacity_unknown')return 'capacity_unknown';
    if(code==='context_too_large'||code.startsWith('context_too_large:'))return 'context_too_large';
    if(code==='history_incomplete')return 'history_incomplete';
    if(code==='image_context_unsupported')return 'image_context_unsupported';
    if(flight.worker.prepareNativeTurnContext||flight.worker.prepareNativeContext)return 'native_context_failed';
    if(flight.contextState==='history_loading')return 'history_incomplete';
    return 'compression_failed';
  }
  private failPreparation(entry:Entry,flight:Flight):void {
    this.checkDeadline(flight);
    const settledAt=this.time();
    try {this.options.goals.settle(flight.ticket,null,settledAt);}catch{/* opaque ticket cleanup is best effort */}
    const rejection=this.options.goals.rejectionReason(flight.ticket);
    this.flights.delete(flight.key);
    if(entry.flight===flight)delete entry.flight;
    this.recordResult(entry,flight,null,false,settledAt,null,this.schedulerRejectionReason(flight,this.workerState(flight.worker))??rejection);
    this.releaseRetention(entry,flight,false,null);
    this.notify();
  }
  private async dispatch(entry:Entry,flight:Flight,input:ObserverInput):Promise<void> {
    let unsubscribe:(()=>void)|undefined;
    try{unsubscribe=flight.worker.subscribeContextPhase?.(phase=>flight.profile.phase(phase));}catch{/* Passive diagnostics. */}
    let paired:BoundNativeTurnSource|null=null;
    let checkpointHistory:HistorySnapshot|undefined;
    const closePaired=async()=>{
      const owned=paired;paired=null;
      if(owned)try{await owned.close();}catch{/* Source owner retains unconfirmed custody evidence. */}
      const checkpoint=checkpointHistory;checkpointHistory=undefined;
      if(checkpoint)try{await checkpoint.close();}catch{/* Local source owner retains cleanup evidence. */}
    };
    try{
    let prepared=input;
    if(flight.worker.prepareNativeTurnContext){
      this.contextState(flight,'history_loading');
      try{
        paired=await this.options.goals.openNativeTurn(flight.ticket,flight.controller.signal);
        if(!paired)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
        // Only the fixed current-turn supplement is scanned, not inherited history.
        for await(const _record of paired.supplement.records(flight.controller.signal)){}
        if(!paired.supplement.coverage.complete||paired.supplement.coverage.gaps.length)throw Error('history_incomplete');
        await paired.validate(flight.controller.signal);
        if(this.disabled||!this.options.goals.isTicketValid(flight.ticket,this.time()))throw Error('NATIVE_CONTEXT_STALE');
        input=this.coverProgressSnapshot(entry,flight,input,paired.revision);
        this.contextState(flight,'context_preparing');let sampled=false;
        const value=await flight.worker.prepareNativeTurnContext(input,paired,flight.controller.signal,flight.key,flight.generation,flight.requestedAt,()=>{
          if(sampled||flight.controller.signal.aborted||this.disabled)throw Error('NATIVE_CONTEXT_STALE');
          const fresh=this.options.goals.refreshNativeObservation(flight.ticket,this.time());if(!fresh)throw Error('NATIVE_CONTEXT_STALE');
          sampled=true;flight.observedActiveSeconds=fresh.activeSeconds;flight.excludedActiveSeconds=0;return fresh;
        });
        if(!value||!sampled)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
        if(!isInferenceEligible(value.representation))throw Error('history_incomplete');
        prepared=value.input;flight.researchFailure='incomplete_scan';
        this.contextState(flight,'context_native');
      }catch(error){
        // Recovery is only for source acquisition, never a retry after a worker
        // or provider failure. Require an already-existing complete checkpoint.
        const code=error!==null&&typeof error==='object'?Reflect.get(error,'code'):undefined;
        const recover=paired===null&&flight.worker.prepareNativeHistoryFallback&&
          ['source_unobserved','source_limit','source_checkpoint_unsupported'].includes(String(code));
        if(paired)await closePaired();
        if(!recover){this.contextState(flight,this.preparationFailureState(flight,error));this.failPreparation(entry,flight);return;}
        try{
          const signal=flight.controller.signal;
          const checkTicket=async(s:AbortSignal)=>{
            s.throwIfAborted();
            if(this.disabled||!this.options.goals.isTicketValid(flight.ticket,this.time()))throw Error('NATIVE_CONTEXT_STALE');
          };
          await checkTicket(signal);
          const opened=await this.options.goals.openNativeHistoryFallback(flight.ticket,signal);
          if(!opened)throw Error('CHECKPOINT_REQUIRED');
          checkpointHistory=opened.snapshot;
          await assertCheckpointWindow(opened.snapshot,signal);
          const verified=await verifyHistoryFallback(opened,signal,checkTicket);
          input=this.coverProgressSnapshot(entry,flight,input,opened.snapshot.revision);
          this.contextState(flight,'context_preparing');let sampled=false;
          const value=await flight.worker.prepareNativeHistoryFallback!(input,verified,signal,flight.key,flight.generation,flight.requestedAt,()=>{
            if(sampled||signal.aborted||this.disabled)throw Error('NATIVE_CONTEXT_STALE');
            const fresh=this.options.goals.refreshNativeObservation(flight.ticket,this.time());if(!fresh)throw Error('NATIVE_CONTEXT_STALE');
            sampled=true;flight.observedActiveSeconds=fresh.activeSeconds;flight.excludedActiveSeconds=0;return fresh;
          },{checkpointOnly:true});
          if(!value||!sampled||!isInferenceEligible(value.representation))throw Error('history_incomplete');
          prepared=value.input;flight.researchFailure='incomplete_scan';
          this.contextState(flight,'context_full');
        }catch(failure){
          await closePaired();
          this.contextState(flight,this.preparationFailureState(flight,failure));this.failPreparation(entry,flight);return;
        }
      }
    }else if(flight.worker.prepareNativeContext||flight.worker.nativeSourceDestination){
      this.contextState(flight,'history_loading');
      let opened:OpenNativeSourceResult|null|undefined,handedToWorker=false;
      try{
        if(!flight.worker.prepareNativeContext||!flight.worker.nativeSourceDestination)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
        const destination=await flight.worker.nativeSourceDestination(flight.controller.signal);
        opened=await this.options.goals.openNativeSource(flight.ticket,flight.controller.signal,destination);
        if(!opened)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
        if(flight.controller.signal.aborted||this.disabled||!this.options.goals.isTicketValid(flight.ticket,this.time()))throw Error('NATIVE_CONTEXT_STALE');
        input=this.coverProgressSnapshot(entry,flight,input,opened.snapshot.revision);
        this.contextState(flight,'context_preparing');
        handedToWorker=true;
        let sampled=false;
        const value=await flight.worker.prepareNativeContext(input,opened,flight.controller.signal,flight.key,flight.generation,flight.requestedAt,()=>{
          if(sampled||flight.controller.signal.aborted||this.disabled)throw Error('NATIVE_CONTEXT_STALE');
          const fresh=this.options.goals.refreshNativeObservation(flight.ticket,this.time());
          if(!fresh)throw Error('NATIVE_CONTEXT_STALE');
          sampled=true;flight.observedActiveSeconds=fresh.activeSeconds;
          // Outage exclusion before this genuine sample is already reflected
          // in its clock; only later unavailable intervals belong to this ETA.
          flight.excludedActiveSeconds=0;
          return fresh;
        });
        if(!value||!sampled)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
        prepared=value.input;
        // No full scan is performed just to manufacture research features.
        // Existing research handling records an unavailable prefix explicitly.
        flight.researchFailure='incomplete_scan';
        this.contextState(flight,'context_native');
      }catch(error){
        if(opened&&!handedToWorker)try{await opened.snapshot.close();}catch{/* Resource owner retains recovery evidence. */}
        this.contextState(flight,this.preparationFailureState(flight,error));
        this.failPreparation(entry,flight);return;
      }
    }else if(flight.worker.prepareContext){
      this.contextState(flight,'history_loading');
      try {
        const opened=await this.options.goals.openHistory?.(flight.ticket,flight.controller.signal);
        if(!opened)throw Error('history_unavailable');
        let handedToPlanner=false;
        let promise:Promise<PreparedContext>;
        try {
          // Coverage is authoritative only after reaching the fixed watermark.
          // Scan locally before any provider preparation can import or compress.
          for await(const _record of opened.snapshot.records(flight.controller.signal)){
            if(flight.controller.signal.aborted)throw Error('history_unavailable');
          }
          if(!opened.snapshot.coverage.complete||opened.snapshot.coverage.gaps.length)throw Error('history_incomplete');
          if(flight.controller.signal.aborted||this.disabled||!this.options.goals.isTicketValid(flight.ticket,this.time()))throw Error('history_unavailable');
          const researchCapture=this.options.research?captureHistoryFeatures(opened.snapshot,opened.currentTurnId):undefined;
          input=this.coverProgressSnapshot(entry,flight,input,opened.snapshot.revision);
          this.contextState(flight,'context_preparing');
          promise=flight.worker.prepareContext(input,researchCapture?{...opened,snapshot:researchCapture.snapshot}:opened,flight.controller.signal,flight.key,flight.generation,flight.requestedAt);
          handedToPlanner=true;
          const value=await promise;
          if(!value){await opened.snapshot.close();throw Error('preparation_empty');}
          if(!isInferenceEligible(value.representation))throw Error('history_incomplete');
          if(!flight.controller.signal.aborted&&this.options.goals.isTicketValid(flight.ticket,this.time())){
            entry.missingImages=value.representation.missingImages??0;entry.qualityTurnKey=flight.turnKey;
          }
          prepared=value.input;
          try{
            const actions=researchCapture?.result(),owner=this.options.goals.researchOwner(flight.ticket);
            if(!actions)flight.researchFailure=researchCapture?.reason()??'incomplete_scan';
            else if(!owner)flight.researchFailure='owner_changed';
            else if(owner.fingerprint===undefined)flight.researchFailure='fingerprint_missing';
            else if(owner.fingerprint!==researchCapture?.fingerprint())flight.researchFailure='fingerprint_changed';
            if(actions&&owner&&owner.fingerprint!==undefined&&owner.fingerprint===researchCapture?.fingerprint()&&this.options.research){
              flight.researchTicket=this.options.research.capture(owner,flight.requestId,
                JSON.stringify([opened.snapshot.identity,opened.snapshot.sourceEpoch,opened.snapshot.revision]),flight.observedActiveSeconds,actions);
              flight.researchGeneration=owner.generation;
            }
          }catch{flight.researchFailure='capture_error';/* Research capture cannot fail context preparation. */}
          this.contextState(flight,(value.representation.missingImages??0)>0?'context_images_missing':value.representation.mode==='compressed'?'context_compressed':'context_full',value.metrics);
        }catch(error){
          if(!handedToPlanner){try{await opened.snapshot.close();}catch{/* acquisition ownership was not transferred */}}
          throw error;
        }
      }catch(error){
        this.contextState(flight,this.preparationFailureState(flight,error));
        this.failPreparation(entry,flight);
        return;
      }
    }
    if(prepared.imageContextPending){
      if(paired||checkpointHistory)await closePaired();
      this.contextState(flight,'image_context_unsupported');this.failPreparation(entry,flight);return;
    }
    const state=this.workerState(flight.worker);
    this.checkDeadline(flight);
    if(flight.controller.signal.aborted||this.disabled||!this.options.goals.isTicketValid(flight.ticket,this.time())||
      state.disabled||state.active||state.poisoned){
      if(paired||checkpointHistory)await closePaired();
      this.failPreparation(entry,flight);
      return;
    }
    try {
      const result=await flight.worker.observe(prepared,flight.controller.signal,flight.key,flight.generation,
        stage=>this.record('stage',flight.key,entry,{requestId:flight.requestId,stage},flight));
      if(paired||checkpointHistory)await closePaired();
      this.settle(entry,flight,result);
    }catch{if(paired||checkpointHistory)await closePaired();this.settle(entry,flight,null);}
    }finally{
      if(paired||checkpointHistory)await closePaired();
      try{unsubscribe?.();}catch{/* Passive diagnostics. */}
    }
  }
  private coverProgressSnapshot(entry:Entry,flight:Flight,input:ObserverInput,revision:number):ObserverInput {
    const updated=this.options.goals.progressAtSnapshot(flight.ticket,input,revision,this.time());
    const live=this.options.goals.scheduling(flight.key,this.time());if(live)this.syncGoal(entry,live);
    if(updated===input)return input;
    flight.observedActiveSeconds=updated.activeSeconds;flight.excludedActiveSeconds=0;
    // Only locally revision-bound events are proven included. Unknown hook coverage stays pending.
    for(const event of entry.criticalEvents??[]){
      if(event.sequence<=(flight.eventCutoff??0))continue;
      if(event.revision===null||event.revision>revision)break;
      flight.eventCutoff=event.sequence;entry.consumedEventSequence=event.sequence;
    }
    const pending=entry.criticalEvents?.find(e=>e.sequence>entry.consumedEventSequence);
    if(pending)entry.eventAt=pending.at;
    return updated;
  }
  private markEvent(entry:Entry,now:number,reason:TriggerReason,revision:number|null=null):void {
    const hadPending=entry.eventSequence>entry.consumedEventSequence;
    entry.eventSequence++;
    entry.criticalEvents=(entry.criticalEvents??[]).filter(e=>e.sequence>entry.consumedEventSequence);
    entry.criticalEvents.push({sequence:entry.eventSequence,revision,at:now});
    if(entry.criticalEvents.length>32)entry.criticalEvents=[{sequence:entry.eventSequence,revision:null,at:entry.eventAt??now}];
    if(!hadPending){entry.eventAt=now;entry.eventReason=reason;}
    else if(reason==='status_evidence')entry.eventReason=reason;
  }
  private syncGoal(entry:Entry,state:NonNullable<ReturnType<PassiveGoals['scheduling']>>):void {
    const progress=state.view.progressState;
    if(progress){
      if(entry.progressScope===progress.scope&&progress.observedEventSequence>(entry.progressEventSequence??0))
        this.markEvent(entry,this.time(),'important_event',state.revision??null);
      entry.progressScope=progress.scope;entry.progressEventSequence=progress.observedEventSequence;
    }
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
      delete entry.expiredResultPending;
      delete entry.overdueReservedPrediction;entry.lastRequestActiveSeconds=state.view.activeSeconds;
      if(state.contentIdentity===undefined)delete entry.contentIdentity;else entry.contentIdentity=state.contentIdentity;
      delete entry.consumedContentIdentity;
      delete entry.contextState;delete entry.contextStateTurnKey;
      delete entry.missingImages;delete entry.qualityTurnKey;
      entry.bootstrapRecoveryEligible=false;entry.bootstrapRecoveryUsed=false;
      delete entry.lastResultDiagnostic;delete entry.lastRejectionReason;delete entry.lastResultStatus;
      if(state.view.prediction)entry.overdueEligibleActiveSeconds=
        state.view.prediction.observedActiveSeconds+state.view.prediction.remainingSeconds+15;
    } else if(entry.predictionIdentity!==state.predictionIdentity){
      delete entry.expiredResultPending;
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
  private syncContent(entry:Entry,state:NonNullable<ReturnType<PassiveGoals['scheduling']>>):void {
    if(state.contentIdentity===undefined)delete entry.contentIdentity;
    else entry.contentIdentity=state.contentIdentity;
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
    this.workerSource.updateRetentionState?.(key,this.retentionState(key,state));
    if (!state) return;
    let entry = this.entries.get(key);
    const selectedSource = state.revision !== undefined;
    if (!entry) {
      this.prune(now);
      if (this.entries.size >= 128) {this.capacityReached = true; return;}
      entry = {born: now, readyAfter: now, lastStart: null, eventAt: null,
        eventSequence:0, consumedEventSequence:0,
        version: selectedSource ? 1 : 0, consumed: 0, unknown: 0, starts: [], runtime: state.view.runtime,
        statusEvidence: false, expiredTimerResults:0, ended:false, goalIdentity:state.goalIdentity,
        predictionIdentity:state.predictionIdentity,
        sourceClockAvailable:state.sourceAvailable,
        sourceActiveSeconds:state.view.activeSeconds,
        ...(state.contentIdentity===undefined?{}:{contentIdentity:state.contentIdentity}),
        ...(selectedSource ? {sourceRevision: state.revision, sourceFinalAvailable: state.finalAvailable} : {})};
      this.entries.set(key, entry);
    }
    this.syncGoal(entry,state);this.syncContent(entry,state);this.syncSourceClock(entry,state);
    if (selectedSource) {
      this.syncSource(entry, state.revision!);
      if (state.view.runtime === 'waiting' && state.finalAvailable && entry.sourceFinalAvailable !== true) {
        entry.statusEvidence = true;
      }
      entry.sourceFinalAvailable = state.finalAvailable;
      } else {
        entry.version++;
      }
    if(entry.flight && (entry.flight.turnKey!==(this.options.goals.currentTurnKey(key)??'') ||
      entry.flight.goalIdentity!==state.goalIdentity || state.view.runtime!=='running'))
      entry.flight.controller.abort();
    const resumed=entry.runtime!=='running'&&state.view.runtime==='running';
    if(event==='prompt')this.markEvent(entry,now,'important_event');
    if(event==='final'&&state.finalAvailable){entry.statusEvidence=true;this.markEvent(entry,now,'status_evidence');}
    if(event==='failure'){entry.unknown=0;entry.expiredTimerResults=0;this.markEvent(entry,now,'important_event');}
    if(event==='runtime'&&resumed){entry.statusEvidence=false;entry.unknown=0;entry.expiredTimerResults=0;
      delete entry.expiredResultPending;
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
      // Source-aware enumeration is health/shutdown inspection only. Allocation
      // still goes through acquire(key) below.
      this.workers();
      let worker = this.sourceAwareWorkers ? undefined : this.workers().find(candidate => {
        const state = this.workerState(candidate);
        if (this.workerInFlight(candidate) || state.active || state.disabled || state.poisoned) return false;
        try {
          const recovery = candidate.recoveryStatus?.();
          return recovery?.nextEligibleAt !== undefined && recovery.nextEligibleAt !== null && now < recovery.nextEligibleAt ? false
            : recovery?.cooldownUntil !== undefined && recovery.cooldownUntil !== null && now < recovery.cooldownUntil ? false : true;
        } catch { return false; }
      });
      const state = this.options.goals.scheduling(key, now);
      this.workerSource.updateRetentionState?.(key,this.retentionState(key,state));
      if (!state) {entry.flight?.controller.abort(); continue;}
      const currentTurnKey=this.options.goals.currentTurnKey(key)??'';
      const runtime = state.view.status === 'completed' || ['stopped', 'failed', 'interrupted'].includes(state.view.runtime)
        ? 'terminal' : state.view.runtime === 'paused' ? 'paused' : state.view.runtime === 'waiting' ? 'waiting' : 'running';
      if(entry.flight && (entry.flight.turnKey!==currentTurnKey || entry.flight.goalIdentity!==state.goalIdentity || runtime!=='running'))
        entry.flight.controller.abort();
      const selectedSource = state.revision !== undefined;
      if (selectedSource) {
        this.syncSource(entry, state.revision!);
        if (state.view.runtime === 'waiting' && state.finalAvailable && entry.sourceFinalAvailable !== true) {
          entry.statusEvidence = true;this.markEvent(entry,now,'status_evidence');
        }
        entry.sourceFinalAvailable = state.finalAvailable;
      }
      this.syncGoal(entry,state);
      this.syncContent(entry,state);
      this.syncSourceClock(entry,state);
      if(entry.flight && (entry.flight.turnKey!==currentTurnKey || entry.flight.goalIdentity!==state.goalIdentity ||
        state.view.runtime!=='running'))entry.flight.controller.abort();
      const view = state.view;
      const prediction = view.prediction;
      const remaining = prediction ? Math.max(0, prediction.remainingSeconds - Math.max(0,
        view.activeSeconds - prediction.observedActiveSeconds - (entry.predictionExcludedSeconds??0))) : null;
      const milestone=view.progressState?.milestone;
      const milestonePrediction=milestone?.judgment==='in_progress'?milestone.prediction:null;
      const milestoneRemaining=milestonePrediction?Math.max(0,milestonePrediction.remainingSeconds-Math.max(0,
        view.activeSeconds-milestonePrediction.observedActiveSeconds-(entry.predictionExcludedSeconds??0))):null;
      const milestoneReservation=milestonePrediction?`${milestone!.id}:${milestonePrediction.observedActiveSeconds}:${milestoneRemaining===0?'overdue':'near'}`:null;
      const milestoneTimerReady=milestonePrediction!==null&&milestonePrediction!==undefined&&milestoneRemaining!==null&&
        milestoneRemaining<=milestonePrediction.remainingSeconds*0.2&&entry.milestoneTimerReservation!==milestoneReservation;
      if(state.ready && now<entry.readyAfter){this.skip(key,entry,'initial_delay');continue;}
      // Prediction identity, not a tool event or wall timer, owns this one-shot.
      // Source outages are excluded from remaining above, as are user pauses.
      const nearExpiryReady=state.predictionIdentity!==null&&prediction!==null&&remaining!==null&&
        remaining>0&&remaining<=prediction.remainingSeconds*0.2&&
        entry.nearExpiryReservedPrediction!==state.predictionIdentity;
      const expiredResultReady=entry.expiredResultPending===true&&entry.overdueEligibleActiveSeconds!==undefined&&
        view.activeSeconds>=entry.overdueEligibleActiveSeconds;
      const expiredResultBackoff=entry.expiredResultPending===true&&!expiredResultReady;
      const overdueReady=!expiredResultBackoff&&state.predictionIdentity!==null&&remaining===0&&
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
         milestoneRemainingSeconds:milestoneRemaining,
         hasNewInformation: entry.version > entry.consumed, activeSeconds:view.activeSeconds,
         hasNewContent:entry.contentIdentity!==undefined&&entry.contentIdentity!==entry.consumedContentIdentity,
        lastRequestActiveSeconds:entry.lastRequestActiveSeconds??null,
        overdueActionRecheck: overdueReady,overdueAlreadyChecked:overdueAlready,
        expiredResultRecheck:expiredResultReady||(milestoneTimerReady&&milestoneRemaining===0),
        nearExpiryRecheck:nearExpiryReady||(milestoneTimerReady&&milestoneRemaining!>0),
         overdueEligibleActiveSeconds:entry.overdueEligibleActiveSeconds??null,retryBackoff:retryBackoff||failureBackoff||expiredResultBackoff,
         preDispatchRetry:entry.retryVersion===entry.version,
         bootstrapRecovery:entry.bootstrapRecoveryEligible===true&&entry.bootstrapRecoveryUsed!==true,
        state: runtime, statusEvidenceArrived: entry.statusEvidence,
        goalInFlight: entry.flight !== undefined, globalInFlight: this.flights.size, conversationStartsLastHour: entry.starts.length});
      if(decision.blockReason){this.skip(key,entry,decision.blockReason);continue;}
      let acquisitionReason:SchedulingReason|undefined;
      if (!worker) {
        try { worker = this.workerSource.acquire(key); }
        catch (error) { worker = undefined; acquisitionReason=workerAcquisitionReason(error); }
      }
      if(!worker){
        const recoveryDeferred=this.workers().some(candidate=>{
          const state=this.workerState(candidate);if(this.workerInFlight(candidate)||state.active||state.disabled||state.poisoned)return false;
          try{const recovery=candidate.recoveryStatus?.();return recovery?.nextEligibleAt!==undefined&&recovery.nextEligibleAt!==null&&now<recovery.nextEligibleAt||recovery?.cooldownUntil!==undefined&&recovery.cooldownUntil!==null&&now<recovery.cooldownUntil;}catch{return false;}
        });
        this.skip(key,entry,this.workers().some(candidate=>this.workerState(candidate).setupFailed)?'setup_failed':recoveryDeferred?'recovery_cooldown':acquisitionReason??'worker_unavailable');continue;
      }
      const request = this.options.goals.request(key, now);
      if (!request) {this.skip(key,entry,'request_unavailable');continue;}
      worker.updateRetentionState?.(this.retentionState(key,state));
      delete entry.lastSkip;
      const flight: Flight = {key, ticket: request.ticket, controller: new AbortController(), worker,
        eventCutoff:entry.eventSequence,
        profile:createRequestProfile(this.options.monotonicNow,worker.subscribeContextPhase?'sourceMs':'unattributedMs'),
        requestId:++this.requestSequence,requestedAt:now,observedActiveSeconds:request.input.activeSeconds,
        generation:view.generation,runtime:view.runtime,version:entry.version,triggerReason:decision.reason!,
        lastRequestActiveSeconds:entry.lastRequestActiveSeconds??null,eligibleActiveSeconds:decision.eligibleActiveSeconds,
        goalIdentity:state.goalIdentity,excludedActiveSeconds:0,schedulerGeneration:this.schedulerGeneration,
        turnKey:this.options.goals.currentTurnKey(key)??''};
      entry.flight = flight; entry.lastStart = now; entry.starts.push(now); entry.consumed = entry.version;
      if(entry.contextState==='estimate_timeout'){delete entry.contextState;delete entry.contextStateTurnKey;}
      entry.consumedEventSequence=entry.eventSequence;
      if(milestoneTimerReady&&milestoneReservation)entry.milestoneTimerReservation=milestoneReservation;
      entry.lastRequestActiveSeconds=request.input.activeSeconds;
      if(entry.contentIdentity===undefined)delete entry.consumedContentIdentity;else entry.consumedContentIdentity=entry.contentIdentity;
      if(decision.reason==='bootstrap_recovery'){
        entry.bootstrapRecoveryUsed=true;entry.bootstrapRecoveryEligible=false;
      }
      if(entry.retryVersion===entry.version)entry.retryUsedVersion=entry.version;
      delete entry.retryVersion;
      if ((overdueReady||expiredResultReady)&&state.predictionIdentity!==null)entry.overdueReservedPrediction=state.predictionIdentity;
      delete entry.expiredResultPending;
      if (nearExpiryReady&&state.predictionIdentity!==null)entry.nearExpiryReservedPrediction=state.predictionIdentity;
      entry.statusEvidence = false; this.flights.set(key, flight);
      // Rotate for fairness; reserve both local slot and hourly start before provider code.
      this.entries.delete(key); this.entries.set(key, entry);
      this.record('request',key,entry,{requestId:flight.requestId,triggerReason:flight.triggerReason,
        lastRequestActiveSeconds:flight.lastRequestActiveSeconds,eligibleActiveSeconds:flight.eligibleActiveSeconds});
      this.notify();
      const timeoutMs=this.options.requestTimeoutMs??0;
      let deadline:ReturnType<typeof setTimeout>|undefined;
      if(timeoutMs>0){
        flight.deadlineAt=performance.now()+timeoutMs;
        deadline=setTimeout(()=>this.expire(flight),timeoutMs);
        deadline.unref?.();
      }
      flight.done = this.dispatch(entry,flight,request.input).finally(()=>clearTimeout(deadline));
    }
  }
  private expire(flight:Flight):void {
    if(flight.timedOut||this.flights.get(flight.key)!==flight||flight.controller.signal.aborted)return;
    flight.timedOut=true;
    flight.controller.abort(Error('ESTIMATE_DEADLINE'));
    // Keep the owned flight until the worker finishes cleanup and durable usage
    // settlement. Deadline publication does not mean the process is closed.
    this.contextState(flight,'estimate_timeout');
    const entry=this.entries.get(flight.key);
    if(entry)this.record('stage',flight.key,entry,{requestId:flight.requestId,contextState:'estimate_timeout',requestProfile:flight.profile.snapshot()},flight);
  }
  private checkDeadline(flight:Flight):void {
    if(flight.deadlineAt!==undefined&&performance.now()>=flight.deadlineAt)this.expire(flight);
  }
  private settle(entry: Entry, flight: Flight, result: ObserverResult|null): void {
    this.checkDeadline(flight);
    const before=this.options.goals.scheduling(flight.key,this.time());
    if(before&&before.goalIdentity===flight.goalIdentity&&entry.goalIdentity===flight.goalIdentity){
      this.syncGoal(entry,before);this.syncSourceClock(entry,before);
    }
    const state = this.workerState(flight.worker);
    if (state.active || state.poisoned) {
      this.options.goals.settle(flight.ticket, null, this.time());
      this.recordResult(entry,flight,result,false,this.time(),null,this.schedulerRejectionReason(flight,state));
      this.flights.delete(flight.key); if (entry.flight === flight) delete entry.flight;
      this.releaseRetention(entry,flight,false,null);
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
    const staleCritical=entry.eventSequence>(flight.eventCutoff??entry.eventSequence);
    const eligible = !staleCritical&&flight.schedulerGeneration === this.schedulerGeneration && !this.disabled && !state.disabled && !flight.controller.signal.aborted
      && result?.status === 'interpreted' && (!mustDisable || safeUnknownUsage);
    const settledAt=this.time();
    const accepted = this.options.goals.settle(flight.ticket,
      eligible ? result!.interpretation : null, settledAt);
    const hostRejection=accepted?undefined:this.options.goals.rejectionReason(flight.ticket);
    const rejectionReason=(staleCritical?'critical_event_after_snapshot':this.schedulerRejectionReason(flight,state)) ??
      (eligible&&result?.status==='interpreted'?hostRejection:undefined);
    const live=this.options.goals.scheduling(flight.key,settledAt);
    const sameGoal=live!==null&&live.goalIdentity===flight.goalIdentity&&entry.goalIdentity===flight.goalIdentity;
    const localResultAllowed=accepted||sameGoal;
    const classification=this.classifyResult(result,accepted,rejectionReason);
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
    // Result state is a safe same-goal diagnostic even when current-turn
    // content advanced during the flight. Forecast/status mutation remains
    // owned by PassiveGoals' ticket and identity fences below.
    if(localResultAllowed){
      entry.lastResultStatus=result?.status??'process_error';
      if(result?.status==='admission_denied')entry.lastAdmissionReason=normalizeAdmissionReason(result.admissionReason);
      else delete entry.lastAdmissionReason;
      if(classification.diagnostic)entry.lastResultDiagnostic=classification.diagnostic;
      else delete entry.lastResultDiagnostic;
      if(classification.rejectionReason)entry.lastRejectionReason=classification.rejectionReason;
      else delete entry.lastRejectionReason;
    }
    if(sameGoal&&eligible&&hostRejection==='estimate_expired_on_arrival'&&live){
      // A rejected number must not manufacture a prediction/99% floor merely
      // to obtain a timer. Own recovery separately, with a one-shot reservation.
      entry.expiredTimerResults=Math.min(8,entry.expiredTimerResults+1);
      entry.expiredResultPending=true;
      entry.overdueEligibleActiveSeconds=entry.expiredTimerResults===1
        ?Math.max((entry.lastRequestActiveSeconds??live.view.activeSeconds)+60,live.view.activeSeconds+15)
        :live.view.activeSeconds+this.expiredBackoffSeconds(entry.expiredTimerResults-1);
    } else if(accepted&&result?.interpretation?.estimate&&live){
      delete entry.expiredResultPending;
      entry.timerFailures=0;
      entry.sourceActiveSeconds=live.view.activeSeconds;entry.sourceClockAvailable=live.sourceAvailable;
      entry.predictionExcludedSeconds=flight.excludedActiveSeconds;
      entry.lastEstimateAt=flight.requestedAt;
      entry.unknown=0;
      if(live.goalIdentity!==flight.goalIdentity)entry.lastRequestActiveSeconds=live.view.activeSeconds;
      entry.goalIdentity=live.goalIdentity;entry.predictionIdentity=live.predictionIdentity;
      entry.expiredTimerResults=0;
      if(live.view.prediction)entry.overdueEligibleActiveSeconds=
        live.view.prediction.observedActiveSeconds+live.view.prediction.remainingSeconds+flight.excludedActiveSeconds+15;
      else delete entry.overdueEligibleActiveSeconds;
      delete entry.overdueReservedPrediction;
    } else if(accepted&&result?.interpretation?.estimate===null&&live){
      delete entry.expiredResultPending;
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
    if(localResultAllowed&&hostRejection!=='estimate_expired_on_arrival'&&live?.view.prediction===null&&entry.bootstrapRecoveryUsed!==true&&entry.bootstrapRecoveryEligible!==true&&
      (classification.diagnostic==='unknown_response'||(classification.diagnostic==='rejected_result'&&result?.status==='interpreted')))
      entry.bootstrapRecoveryEligible=true;
    this.recordResult(entry,flight,result,accepted,settledAt,live,rejectionReason);
    this.releaseRetention(entry,flight,accepted,live);
    this.notify();
  }
  private classifyResult(result:ObserverResult|null,accepted:boolean,rejectionReason?:ResultRejectionReason):{diagnostic?:ResultDiagnostic;rejectionReason?:ResultRejectionReason} {
    if(result===null||result.status==='process_error')return {diagnostic:'process_error',...(rejectionReason?{rejectionReason}:{})};
    if(!accepted)return {diagnostic:'rejected_result',rejectionReason:rejectionReason??'result_not_accepted'};
    if(result.status==='interpreted'&&result.interpretation?.estimate===null)return {diagnostic:'unknown_response'};
    return {};
  }
  private recordResult(entry:Entry,flight:Flight,result:ObserverResult|null,accepted:boolean,
    acceptedAt=this.time(),live:NonNullable<ReturnType<PassiveGoals['scheduling']>>|null=null,
    rejectionReason?:ResultRejectionReason):void {
    let forecast:Readonly<ForecastRecord>|undefined;
    let forecastDiagnostic:ObserverObservation['forecastDiagnostic'];
    const classification=this.classifyResult(result,accepted,rejectionReason);
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
    if(accepted&&live&&forecast?.rawSeconds!==null&&forecast?.rawSeconds!==undefined&&this.options.research){
      let recorded=false;
      let detail=flight.researchFailure??'incomplete_scan';
      if(flight.researchTicket)detail=snapshotAnchor!==flight.observedActiveSeconds?'anchor_changed':
        flight.researchGeneration!==live.view.generation?'generation_changed':'accept_rejected';
      try{if(flight.researchTicket&&snapshotAnchor===flight.observedActiveSeconds&&flight.researchGeneration===live.view.generation)
        recorded=this.options.research.accept(flight.researchTicket,forecast.rawSeconds,live.view.activeSeconds,forecast.versions);}
      catch{/* Still retain a coverage-only record below. */}
      if(!recorded)try{const owner=this.options.goals.currentResearchOwner(flight.key);if(owner)
        this.options.research.unavailable(owner,flight.requestId,forecast.rawSeconds,live.view.activeSeconds,forecast.versions,detail);
      }catch{/* Research failure cannot reject a production estimate. */}
    }
    this.record('result',flight.key,entry,{requestId:flight.requestId,requestedAt:flight.requestedAt,
      requestProfile:flight.profile.snapshot(),
      ...(!accepted?{generation:flight.generation}:{}),
      ...(snapshotAnchor===undefined?{}:{observedActiveSeconds:snapshotAnchor}),
      triggerReason:flight.triggerReason,lastRequestActiveSeconds:flight.lastRequestActiveSeconds,
      eligibleActiveSeconds:flight.eligibleActiveSeconds,
      accepted,status:result?.status??'process_error',
      ...(result?.interpretation?{relation:result.interpretation.relation}:{}),
      estimate:result?.interpretation?.estimate?{...result.interpretation.estimate}:null,
       ...(forecast?{forecast}:{}),...(forecastDiagnostic?{forecastDiagnostic}:{}),
       ...(classification.diagnostic?{resultDiagnostic:classification.diagnostic}:{}),
      ...(classification.rejectionReason?{rejectionReason:classification.rejectionReason}:{}),
      ...(flight.contextState?{contextState:flight.contextState}:{}),
      ...(flight.contextMetrics?{contextMetrics:{...flight.contextMetrics}}:{}),
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
    const entry=this.entries.get(key);
    const health=this.options.goals.contextHealth(key);
    const sourceHealth:NonNullable<ObserverDiagnostics['sourceHealth']>=health===undefined?'unavailable':
      health==='loading'||health==='ready'||health==='missing'?health:'error';
    const schedulingReason=schedulingReasons.includes(entry?.lastSkip as SchedulingReason)?entry!.lastSkip as SchedulingReason:undefined;
    const routing={schedulerRegistered:entry!==undefined,sourceHealth,...(schedulingReason?{schedulingReason}:{})};
    const contextState=entry?.contextState&&entry.contextStateTurnKey===this.options.goals.currentTurnKey(key)
      ?entry.contextState:undefined;
    const quality=entry?.qualityTurnKey===this.options.goals.currentTurnKey(key)&&entry?.missingImages!==undefined?
      {missingImages:entry.missingImages}:{};
    if(this.stopReason)return {...routing,state:'disabled',stopReason:this.stopReason,stoppedAt:this.stoppedAt!,
      ...(contextState?{contextState}:{}),...quality,
      estimateAgeSeconds:null,callsLastHour:this.entries.get(key)?.starts.filter(start=>this.lastClock-start<3600000).length??0,retryPending:false};
    const at=this.stopReason ? this.lastClock : this.time(),view=this.options.goals.view(key,at);
    const durations=[view?.prediction,view?.progressState?.milestone?.prediction].flatMap(p=>p&&view?
      [Math.max(0,p.remainingSeconds-(view.activeSeconds-p.observedActiveSeconds-(entry?.predictionExcludedSeconds??0)))]:[]).filter(s=>s>0);
    const progressDiagnostics={pendingCriticalEvents:Math.max(0,(entry?.eventSequence??0)-(entry?.consumedEventSequence??0)),
      reviewIntervalSeconds:ordinaryRequestIntervalSeconds(durations.length?Math.min(...durations):null,entry?.unknown??0),
      eventCoalescingRemainingSeconds:entry?.eventAt===null||entry?.eventAt===undefined?0:Math.max(0,5-(at-entry.eventAt)/1000),
      snapshotEventCutoff:entry?.flight?.eventCutoff??entry?.consumedEventSequence??0};
    const state:ObserverDiagnostics['state']=this.disabled?'disabled':contextState==='estimate_timeout'?'call_failed':entry?.flight?'estimating':
      this.workers().some(worker=>this.workerState(worker).setupFailed)?'setup_failed':
      entry?.lastResultStatus==='admission_denied'?'admission_blocked':
      ['hourly_limit','global_concurrency_limit'].includes(entry?.lastSkip??'')?'rate_limited':
      entry?.lastSkip==='context_missing'?(health==='loading'?'history_loading':
        health==='error'||health==='missing'?'history_unavailable':'insufficient_context'):
      (entry?.lastResultDiagnostic ?? (view?.prediction?'ready':entry?.lastResultStatus==='interpreted'?'insufficient_context':'pending'));
    return {state,...routing,...quality,...(contextState?{contextState}:{}),...(this.stopReason ? {stopReason:this.stopReason,stoppedAt:this.stoppedAt!} : {}),...(state==='admission_blocked'?{admissionReason:normalizeAdmissionReason(entry?.lastAdmissionReason)}:{}),
      ...(entry?.lastResultDiagnostic?{resultDiagnostic:entry.lastResultDiagnostic}:{}),
      ...progressDiagnostics,
      ...(entry?.lastRejectionReason?{rejectionReason:entry.lastRejectionReason}:{}),
      estimateAgeSeconds:view?.prediction&&entry?.lastEstimateAt!==undefined?Math.max(0,(at-entry.lastEstimateAt)/1000):null,
      callsLastHour:entry?.starts.filter(start=>at-start<3600000).length??0,
      retryPending:entry?.retryVersion!==undefined&&entry.retryVersion===entry.version};
  }
  end(key: string): void {
    this.workerSource.updateRetentionState?.(key,null);
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
