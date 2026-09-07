import type {ObserverInput} from './observer-contract.js';
import type {ObserverSubscriptionResult} from './subscription-session.js';
import type {PassiveContextStore} from '../server/passive-context-store.js';
import type {PassiveGoals} from '../server/passive-goals.js';
import {requestBlockReason} from './long-task-policy.js';
import type {ObserverDiagnostics} from '../core/observer-diagnostics.js';
export interface ObserverWorker {
  /** Authenticated local key is accounting metadata, never observer prompt data. */
  observe(input: ObserverInput, signal: AbortSignal, conversationKey: string): Promise<ObserverSubscriptionResult>;
  status(): {active: boolean; disabled: boolean; poisoned: boolean; setupFailed?:boolean};
  disable(): void;
  close(): Promise<void>;
}
export interface ObserverObservation {
  kind:'runtime'|'request'|'result'|'skip'; at:number; key:string; generation:number; activeSeconds:number;
  runtime:string; version:number; requestId?:number; requestedAt?:number; observedActiveSeconds?:number;
  accepted?:boolean; status?:string; relation?:string;
  activeTimeKnown?:boolean;
  estimate?:{remainingSeconds:number;errorPercent:number}|null;
  usage?:ObserverSubscriptionResult['usage'];
  timings?:ObserverSubscriptionResult['timings'];
}
interface Options {contexts: PassiveContextStore; goals: PassiveGoals; workers: readonly ObserverWorker[]; now: () => number; onChange?: () => void; closeTimeoutMs?: number; onObservation?:(record:ObserverObservation)=>void}
interface Entry {
  born: number; readyAfter: number; lastStart: number|null; eventAt: number|null;
  version: number; consumed: number; unknown: number; starts: number[];
  runtime: string; statusEvidence: boolean; flight?: Flight;
  lastSkip?: string; sourceRevision?: number; sourceFinalAvailable?: boolean; overdueActionId?: string;
  retryVersion?:number;retryUsedVersion?:number;
  lastResultStatus?:ObserverSubscriptionResult['status'];lastEstimateAt?:number;
}
interface Flight {key: string; ticket: object; controller: AbortController; worker: ObserverWorker; requestId:number; requestedAt:number; observedActiveSeconds:number;
  generation:number;runtime:string;version:number;done?: Promise<void>}

/** Admission timing is local; durable spend admission belongs to each owned worker.
 * changed never dispatches synchronously on the task Hook/HTTP path.
 */
export class ObserverScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Map<ObserverWorker, Flight>();
  private readonly workers: readonly ObserverWorker[];
  private disabled = false;
  private capacityReached = false;
  private lastClock = 0;
  private requestSequence = 0;
  private closing?: Promise<void>;
  constructor(private readonly options: Options) {
    if (options.workers.length < 1 || options.workers.length > 2 || new Set(options.workers).size !== options.workers.length) {
      throw new Error('INVALID_OBSERVER_WORKERS');
    }
    const closeTimeout = options.closeTimeoutMs ?? 6000;
    if (!Number.isSafeInteger(closeTimeout) || closeTimeout < 1 || closeTimeout > 10000) throw new Error('INVALID_OBSERVER_CLOSE_TIMEOUT');
    this.workers = [...options.workers];
  }
  private time(): number {
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
      const at=this.time();
      // Rejected tickets may belong to a removed/replaced goal object, even if
      // a new object reuses its numeric generation. Do not mix its live clock in.
      const view=flight && extra.accepted!==true?null:this.options.goals.view(key,at);
      if(view || flight)this.options.onObservation({kind,at,key,generation:view?.generation??flight!.generation,
        activeSeconds:view?.activeSeconds??flight!.observedActiveSeconds,activeTimeKnown:view!==null&&this.options.goals.activeTimeKnown(key),
        runtime:view?.runtime??flight!.runtime,version:view?entry.version:flight!.version,...extra});
    }catch{/* Recording must never authorize, retry or interrupt inference. */}
  }
  changed(key: string, event: 'prompt'|'activity'|'final'|'runtime'): void {
    if (this.disabled) return;
    const now = this.time(), state = this.options.goals.scheduling(key, now);
    if (!state) return;
    let entry = this.entries.get(key);
    const selectedSource = state.revision !== undefined;
    if (!entry) {
      this.prune(now);
      if (this.entries.size >= 128) {this.capacityReached = true; return;}
      entry = {born: now, readyAfter: now + 15000, lastStart: null, eventAt: null,
        version: selectedSource ? 1 : 0, consumed: 0, unknown: 0, starts: [], runtime: state.view.runtime,
        statusEvidence: false, ...(selectedSource ? {sourceRevision: state.revision, sourceFinalAvailable: state.finalAvailable} : {})};
      this.entries.set(key, entry);
    }
    if (selectedSource) {
      this.syncSource(entry, state.revision!);
      if (state.view.runtime === 'waiting' && state.finalAvailable && entry.sourceFinalAvailable !== true) {
        entry.statusEvidence = true;
      }
      entry.sourceFinalAvailable = state.finalAvailable;
    } else {
      entry.version++;
    }
    if (event === 'prompt') {entry.readyAfter = now + 15000; entry.unknown = 0;
      delete entry.lastResultStatus;delete entry.lastEstimateAt;delete entry.lastSkip;delete entry.retryVersion;}
    if (event !== 'activity' || (entry.runtime !== 'running' && state.view.runtime === 'running')) entry.eventAt = now;
    if (event === 'final' && state.finalAvailable) entry.statusEvidence = true;
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
  tick(): void {
    if (this.disabled) {
      for(const [key,entry] of this.entries)this.skip(key,entry,'observer_disabled');
      return;
    }
    const now = this.time(); this.prune(now);
    if (this.workers.some(worker => this.workerState(worker).poisoned)) {this.disable(); return;}
    for (const [key, entry] of [...this.entries]) {
      const worker = this.workers.find(candidate => {
        const state = this.workerState(candidate);
        return !this.flights.has(candidate) && !state.active && !state.disabled && !state.poisoned;
      });
      const state = this.options.goals.scheduling(key, now);
      if (!state) {entry.flight?.controller.abort(); continue;}
      const selectedSource = state.revision !== undefined;
      if (selectedSource) {
        this.syncSource(entry, state.revision!);
        if (state.view.runtime === 'waiting' && state.finalAvailable && entry.sourceFinalAvailable !== true) {
          entry.statusEvidence = true;
        }
        entry.sourceFinalAvailable = state.finalAvailable;
      }
      const view = state.view;
      const runtime = view.status === 'completed' || ['stopped', 'failed', 'interrupted'].includes(view.runtime)
        ? 'terminal' : view.runtime === 'paused' ? 'paused' : view.runtime === 'waiting' ? 'waiting' : 'running';
      const prediction = view.prediction;
      const remaining = prediction ? Math.max(0, prediction.remainingSeconds - (view.activeSeconds - prediction.observedActiveSeconds)) : null;
      const overdueActionId = selectedSource && state.currentActionId !== null
        && remaining === 0 && entry.overdueActionId !== state.currentActionId
        ? state.currentActionId : null;
      if(state.ready && now<entry.readyAfter){this.skip(key,entry,'initial_delay');continue;}
      const reason=requestBlockReason({elapsedSeconds: (now - entry.born) / 1000,
        lastRequestSeconds: entry.lastStart === null ? null : (entry.lastStart - entry.born) / 1000,
        eventAtSeconds: entry.eventAt === null ? null : (entry.eventAt - entry.born) / 1000,
        remainingSeconds: remaining, unknownResults: entry.unknown, contentReady: state.ready,
        hasNewInformation: entry.version > entry.consumed, overdueActionRecheck: overdueActionId !== null,
        preDispatchRetry:entry.retryVersion===entry.version,
        state: runtime, statusEvidenceArrived: entry.statusEvidence,
        goalInFlight: entry.flight !== undefined, globalInFlight: this.flights.size, conversationStartsLastHour: entry.starts.length});
      if(reason){this.skip(key,entry,reason);continue;}
      if(!worker){this.skip(key,entry,this.workers.some(candidate=>this.workerState(candidate).setupFailed)?'setup_failed':'worker_unavailable');continue;}
      const request = this.options.goals.request(key, now);
      if (!request) {this.skip(key,entry,'request_unavailable');continue;}
      delete entry.lastSkip;
      const flight: Flight = {key, ticket: request.ticket, controller: new AbortController(), worker,
        requestId:++this.requestSequence,requestedAt:now,observedActiveSeconds:request.input.activeSeconds,
        generation:view.generation,runtime:view.runtime,version:entry.version};
      entry.flight = flight; entry.lastStart = now; entry.starts.push(now); entry.consumed = entry.version;
      if(entry.retryVersion===entry.version)entry.retryUsedVersion=entry.version;
      delete entry.retryVersion;
      if (overdueActionId !== null) entry.overdueActionId = overdueActionId;
      entry.statusEvidence = false; this.flights.set(worker, flight);
      // Rotate for fairness; reserve both local slot and hourly start before provider code.
      this.entries.delete(key); this.entries.set(key, entry);
      this.record('request',key,entry,{requestId:flight.requestId});
      this.notify();
      try {
        flight.done = Promise.resolve(worker.observe(request.input, flight.controller.signal, key))
          .then(result => this.settle(entry, flight, result), () => this.settle(entry, flight, null));
      } catch {this.settle(entry, flight, null);}
    }
  }
  private settle(entry: Entry, flight: Flight, result: ObserverSubscriptionResult|null): void {
    const state = this.workerState(flight.worker);
    if (state.active || state.poisoned) {
      this.options.goals.settle(flight.ticket, null, this.time());
      this.recordResult(entry,flight,result,false);
      this.disable(); this.notify(); return;
    }
    this.flights.delete(flight.worker);
    if (entry.flight === flight) delete entry.flight;
    const provenTransient = result?.status==='process_error' && result.outcomes?.dispatch==='not_started'
      && result.outcomes.closureConfirmed && result.outcomes.retryable==='pre_dispatch_transient';
    const provenCancellation=result?.usage===null&&['aborted','disabled'].includes(result.status)
      &&result.outcomes?.usage==='not_dispatched'&&result.outcomes.dispatch==='not_started'
      &&result.outcomes.closureConfirmed&&result.outcomes.call==='cancelled';
    const noDispatch = provenCancellation || provenTransient || result && ['invalid_input', 'admission_denied', 'busy'].includes(result.status);
    const mustDisable = !result || result.status === 'accounting_error' || (result.usage === null && !noDispatch);
    const proof = result?.outcomes;
    const safeUnknownUsage = result?.usage === null && proof?.usage === 'unknown'
      && proof.call === 'success' && proof.framingValid && proof.closureConfirmed
      && proof.dispatch === 'started' && proof.prediction !== 'invalid';
    // Capture external cancellation before the accounting safety stop aborts other flights.
    // A valid answer is not permission to make another call; goal tickets still reject stale answers.
    const eligible = !this.disabled && !state.disabled && !flight.controller.signal.aborted
      && result?.status === 'interpreted' && (!mustDisable || safeUnknownUsage);
    const accepted = this.options.goals.settle(flight.ticket,
      eligible ? result!.interpretation : null, this.time());
    if(provenTransient && !this.disabled && !state.disabled && !flight.controller.signal.aborted
      && entry.version===flight.version && entry.retryUsedVersion!==flight.version){
      entry.retryVersion=flight.version;
      if(flight.runtime==='waiting')entry.statusEvidence=true;
    }
    if (mustDisable) this.disable();
    if(entry.version===flight.version)entry.lastResultStatus=result?.status??'process_error';
    if(accepted&&result?.interpretation?.estimate)entry.lastEstimateAt=flight.requestedAt;
    if(!noDispatch)entry.unknown = accepted && result?.interpretation?.estimate !== null ? 0 : entry.unknown + 1;
    this.recordResult(entry,flight,result,accepted);
    this.notify();
  }
  private recordResult(entry:Entry,flight:Flight,result:ObserverSubscriptionResult|null,accepted:boolean):void {
    this.record('result',flight.key,entry,{requestId:flight.requestId,requestedAt:flight.requestedAt,
      ...(!accepted?{generation:flight.generation}:{}),
      observedActiveSeconds:accepted?(this.options.goals.view(flight.key,this.time())?.prediction?.observedActiveSeconds??flight.observedActiveSeconds):flight.observedActiveSeconds,
      accepted,status:result?.status??'process_error',
      ...(result?.interpretation?{relation:result.interpretation.relation}:{}),
      estimate:result?.interpretation?.estimate?{...result.interpretation.estimate}:null,
      ...(result?.timings?{timings:{...result.timings}}:{}),
      usage:result?.usage?{...result.usage}:null},flight);
  }
  stats() {return {disabled: this.disabled, inFlight: this.flights.size, tracked: this.entries.size, capacityReached: this.capacityReached};}
  diagnostics(key:string):ObserverDiagnostics {
    const at=this.time(),entry=this.entries.get(key),view=this.options.goals.view(key,at);
    const state:ObserverDiagnostics['state']=this.disabled?'disabled':entry?.flight?'estimating':
      this.workers.some(worker=>this.workerState(worker).setupFailed)?'setup_failed':
      ['hourly_limit','global_concurrency_limit'].includes(entry?.lastSkip??'')||entry?.lastResultStatus==='admission_denied'?'rate_limited':
      entry?.lastSkip==='context_missing'?'history_loading':
      entry?.lastResultStatus==='process_error'?'call_failed':
      view?.prediction?'ready':entry?.lastResultStatus==='interpreted'?'insufficient_context':'pending';
    return {state,estimateAgeSeconds:view?.prediction&&entry?.lastEstimateAt!==undefined?Math.max(0,(at-entry.lastEstimateAt)/1000):null,
      callsLastHour:entry?.starts.filter(start=>at-start<3600000).length??0,
      retryPending:entry?.retryVersion!==undefined&&entry.retryVersion===entry.version};
  }
  end(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.consumed = entry.version; entry.statusEvidence = false; entry.flight?.controller.abort();
    delete entry.retryVersion;
  }
  disable(): void {
    this.disabled = true;
    for (const flight of this.flights.values()) flight.controller.abort();
    for (const worker of this.workers) {try {worker.disable();} catch { /* Keep ownership until close. */ }}
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disable();
    const drain = (async () => {
      const results = await Promise.allSettled(this.workers.map(worker => Promise.resolve().then(() => worker.close())));
      await Promise.allSettled([...this.flights.values()].flatMap(flight => flight.done ? [flight.done] : []));
      if (results.some(result => result.status === 'rejected') || this.workers.some(worker => this.workerState(worker).active)) {
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
