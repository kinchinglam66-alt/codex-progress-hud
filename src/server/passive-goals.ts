import type {HookEnvelope} from '../hooks/schema.js';
import type {PassiveContextStore} from './passive-context-store.js';
import {observerResponseSchema, type ObserverInput} from '../estimation/observer-contract.js';
import type {CountdownPrediction} from '../ui/countdown.js';
import {PaceMeasurements, type PaceContinuity, type PaceEvidence, type PaceGroup} from '../estimation/pace-measurements.js';
import type {PaceInterval, WorkBreakdown} from '../estimation/pace-correction.js';
import {freezePaceRequest} from '../estimation/pace-request-snapshot.js';
import {createHash} from 'node:crypto';

type Runtime = 'running'|'waiting'|'paused'|'interrupted'|'failed'|'stopped';
type Status = Runtime|'completed'|'unknown';
export interface SourceTurnTakeover {turnKey:string;startedAtMs:number;identity:string;taskHandle?:string;previousTurnKey?:string}
export interface PassiveGoalView {
  timingUncertain?: boolean;
  runtimeUncertain?: boolean;
  generation: number;
  estimateRevision: number;
  status: Status;
  runtime: Runtime;
  activeSeconds: number;
  prediction: CountdownPrediction | null;
  changeReason?:'routine'|'scope_change'|'failure'|'unknown';
}
interface Goal {
  terminalHook?: boolean;
  sourceStopped?: boolean;
  executionIdentity?: string;
  timingUncertain?: boolean;
  runtimeUncertain?: boolean;
  turnKey: string;
  generation: number;
  estimateRevision: number;
  epoch: number;
  summary: string|null;
  summaryThroughSequence?:number;
  contextFloorTurnKey?:string;
  sourceEpoch?:number;
  relationPending: boolean;
  elapsed: number;
  since: number;
  candidateBase: number;
  runtime: Runtime;
  status: Status;
  prediction: CountdownPrediction|null;
  changeReason?:PassiveGoalView['changeReason'];
  identity: object;
  predictionIdentity: object|null;
  measurementScope: object;
  measurementEpoch?:number;
  lastObservedAt: number;
  pending?: object;
  terminalSince?: number;
}
export interface GoalContextQuery {
  goalSummary:string|null;activeSeconds:number;runtime:ObserverInput['runtime'];
  previousEstimate:CountdownPrediction|null;
  summaryThroughSequence?:number;contextFloorTurnKey?:string;
  paceScope?:object;
}
export interface GoalContextSource {
  health?(key:string):'loading'|'ready'|'error'|'missing';
  execution?(key:string,turnKey:string):{
    state:'running'|'waiting'|'interrupted'|'failed'|'unknown';outcome?:'completed'|'interrupted'|'failed';boundaryMs?:number;identity:string
  }|null;
  takeover?(key:string,turnKey:string):SourceTurnTakeover|null;
  epoch(key:string):number|null;
  inspect?(key:string,turnKey:string,query:GoalContextQuery):{
    ready:boolean;revision:number;userFingerprint?:string;contentFingerprint?:string;currentActionId:string|null;finalAvailable:boolean
  }|null;
  read(key:string,turnKey:string,query:GoalContextQuery):{
    epoch:number;revision:number;userFingerprint?:string;contentFingerprint?:string;currentActionId:string|null;finalAvailable:boolean;input:ObserverInput
    paceEvidence?:PaceEvidence|readonly PaceEvidence[];paceContinuity?:PaceContinuity;
    paceBatches?:readonly {evidence:PaceEvidence;continuity:PaceContinuity}[];measurementEpoch?:number;
  }|null;
  measurementEpoch?(key:string):number|null;
}
interface Ticket {sessionKey: string; goal: Goal; goalIdentity: object; measurementScope:object; epoch: number; activeSeconds: number; requestedAt: number;sourceEpoch?:number;sourceRevision?:number;sourceMeasurementEpoch?:number;userFingerprint?:string;paceLookup:ReadonlyMap<string,readonly PaceInterval[]>}
interface SettledPace {sessionKey:string;goal:Goal;goalIdentity:object;measurementScope:object;epoch:number;sourceEpoch?:number;sourceMeasurementEpoch?:number;intervals:ReadonlyMap<string,readonly PaceInterval[]>}

export interface PassiveGoalScheduling {
  view: PassiveGoalView;
  goalIdentity: object;
  predictionIdentity: object|null;
  sourceAvailable: boolean;
  ready: boolean;
  finalAvailable: boolean;
  revision?: number;
  currentActionId?: string|null;
  /** Opaque local identity of current-turn source content; never sent to the UI. */
  contentIdentity?: string;
}

/** Owns local identities and active clocks. Does not launch inference or authorize spend.
 * observe consumes only already-authenticated, accepted router deliveries.
 */
export class PassiveGoals {
  private readonly goals = new Map<string, Goal>();
  private readonly ended = new Set<string>();
  private tickets = new WeakMap<object, Ticket>();
  private settledAnchors = new WeakMap<object, number>();
  private settledPace = new WeakMap<object, SettledPace>();
  private readonly paceMeasurements = new PaceMeasurements();
  constructor(private readonly contexts: PassiveContextStore,private readonly source?:GoalContextSource) {}

  contextHealth(key:string):'loading'|'ready'|'error'|'missing'|undefined {
    try{return this.source?.health?.(key);}catch{return 'error';}
  }

  private rotateMeasurementScope(goal:Goal):void {
    this.paceMeasurements.clear(goal.measurementScope);
    goal.measurementScope={};
  }

  private ingestPace(goal:Goal,capture:ReturnType<GoalContextSource['read']>|null,epochChanged=false):void {
    if(epochChanged||capture===null){this.rotateMeasurementScope(goal);return;}
    if(capture.paceBatches!==undefined){
      for(const batch of capture.paceBatches)this.paceMeasurements.ingest(goal.measurementScope,batch.evidence,batch.continuity);
    } else if(capture.paceEvidence!==undefined&&capture.paceContinuity!==undefined){
      const evidence=Array.isArray(capture.paceEvidence)?capture.paceEvidence:[capture.paceEvidence];
      for(const item of evidence)this.paceMeasurements.ingest(goal.measurementScope,item,capture.paceContinuity);
    }
    else if(capture.paceContinuity?.historyComplete===false)this.rotateMeasurementScope(goal);
  }

  private sourceContext(key:string,goal:Goal,nowMs:number,inspectOnly?:false):ReturnType<GoalContextSource['read']>;
  private sourceContext(key:string,goal:Goal,nowMs:number,inspectOnly:true):ReturnType<NonNullable<GoalContextSource['inspect']>>;
  private sourceContext(key:string,goal:Goal,nowMs:number,inspectOnly=false) {
    if(!this.source || !['running','waiting','paused'].includes(goal.runtime))return null;
    try{
      const epoch=this.source.epoch(key);
      if(epoch===null){if(!inspectOnly)this.rotateMeasurementScope(goal);return null;}
      const measurementEpoch=this.source.measurementEpoch?.(key)??null;
      if(measurementEpoch!==null&&goal.measurementEpoch!==undefined&&goal.measurementEpoch!==measurementEpoch)
        this.rotateMeasurementScope(goal);
      if(measurementEpoch!==null)goal.measurementEpoch=measurementEpoch;
      let epochChanged=false;
      if(goal.sourceEpoch!==undefined&&goal.sourceEpoch!==epoch){
        this.invalidate(goal);goal.identity={};goal.summary=null;goal.prediction=null;goal.predictionIdentity=null;goal.status='unknown';goal.relationPending=true;
        delete goal.summaryThroughSequence;delete goal.contextFloorTurnKey;goal.estimateRevision++;
        this.rotateMeasurementScope(goal);epochChanged=true;
      }
      goal.sourceEpoch=epoch;
      const query:GoalContextQuery={goalSummary:goal.summary,activeSeconds:this.active(goal,nowMs),
      runtime:goal.runtime as ObserverInput['runtime'],previousEstimate:goal.prediction,
      paceScope:goal.measurementScope,
      ...(goal.summaryThroughSequence===undefined?{}:{summaryThroughSequence:goal.summaryThroughSequence}),
      ...(goal.contextFloorTurnKey===undefined?{}:{contextFloorTurnKey:goal.contextFloorTurnKey})};
      if(inspectOnly&&this.source.inspect)return this.source.inspect(key,goal.turnKey,query);
      const capture=this.source.read(key,goal.turnKey,query);
      if(!inspectOnly){this.ingestPace(goal,capture,epochChanged);return capture;}
      if(!capture)return capture;
      return {revision:capture.revision,userFingerprint:capture.userFingerprint,contentFingerprint:capture.contentFingerprint,
        currentActionId:capture.currentActionId,finalAvailable:capture.finalAvailable,
        ready:capture.input.messages.length>0&&(goal.summary!==null||capture.input.messages.some(m=>m.kind==='user'))};}
    catch{return null;}
  }

  private contextContentIdentity(sessionKey:string,turnKey:string):string|null {
    try {
      const context=this.contexts.read(sessionKey);
      if(!context)return null;
      const digest=createHash('sha256');
      for(const entry of context.entries)if(entry.turnKey===turnKey)
        digest.update(JSON.stringify([entry.hook,entry.content.kind,entry.content.text,entry.content.truncated]));
      return digest.digest('hex');
    } catch { return null; }
  }

  private clock(now: number, goal?: Goal): boolean {
    return Number.isSafeInteger(now) && now >= (goal?.lastObservedAt ?? 0);
  }
  private active(goal: Goal, now: number): number {
    return goal.elapsed + (goal.runtime === 'running' ? (now - goal.since) / 1000 : 0);
  }
  private invalidate(goal: Goal): void {
    goal.epoch++;
    delete goal.pending;
  }
  private transition(goal: Goal, runtime: Runtime, now: number): void {
    if (runtime === goal.runtime) return;
    goal.elapsed = this.active(goal, now);
    goal.since = now;
    goal.runtime = runtime;
    this.invalidate(goal);
    this.rotateMeasurementScope(goal);
  }

  private startTurn(goal:Goal,turnKey:string,nowMs:number):void {
    delete goal.terminalHook;delete goal.sourceStopped;delete goal.executionIdentity;delete goal.runtimeUncertain;delete goal.terminalSince;
    goal.turnKey=turnKey;goal.elapsed=0;goal.since=nowMs;goal.candidateBase=0;
    goal.relationPending=true;goal.summary=null;delete goal.summaryThroughSequence;delete goal.contextFloorTurnKey;
    goal.prediction=null;goal.predictionIdentity=null;goal.identity={};goal.status='unknown';goal.runtime='running';
    goal.timingUncertain=false;goal.lastObservedAt=nowMs;this.invalidate(goal);this.rotateMeasurementScope(goal);
  }

  observe(envelope: HookEnvelope, follow: boolean, nowMs: number): void {
    let goal = this.goals.get(envelope.sessionKey);
    if (!this.clock(nowMs, goal) || !follow || envelope.turnKey === undefined ||
        this.ended.has(envelope.sessionKey) || envelope.receivedAt > nowMs) return;
    const hook = envelope.hook;
    if (!['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt'].includes(hook)) return;
    if (goal === undefined) {
      if (hook !== 'UserPromptSubmit' && hook !== 'PostToolUse') return;
      if (this.goals.size >= 32) {
        const inactive = [...this.goals].find(([, candidate]) =>
          ['stopped', 'failed', 'interrupted', 'completed'].includes(candidate.status));
        if (!inactive) return;
        // Retain a small terminal display window, but never reserve an active slot
        // forever. Captured tickets refer to the removed object and cannot revive it.
        this.paceMeasurements.clear(inactive[1].measurementScope);
        this.goals.delete(inactive[0]);
        this.contexts.remove(inactive[0]);
      }
      goal = {turnKey: envelope.turnKey, generation: 0, estimateRevision: 0, epoch: 0, summary: null,
        relationPending: true, elapsed: 0, since: nowMs, candidateBase: 0,
        runtime: 'running', status: 'unknown', prediction: null, identity: {}, predictionIdentity: null,
        measurementScope: {}, lastObservedAt: nowMs};
      this.goals.set(envelope.sessionKey, goal);
    }
    if (goal.turnKey === envelope.turnKey && (goal.terminalHook||goal.sourceStopped) &&
        (hook === 'PostToolUse' || hook === 'UserPromptSubmit')) return;
    if (hook === 'UserPromptSubmit') {
      if (goal.turnKey !== envelope.turnKey) this.startTurn(goal,envelope.turnKey,nowMs);
    } else if (goal.turnKey === envelope.turnKey) {
      if (hook === 'Stop' || hook === 'Interrupt') {goal.terminalHook = true;delete goal.runtimeUncertain;}
      if (hook === 'Interrupt') {
        this.transition(goal, 'interrupted', nowMs);
        goal.status = 'interrupted'; goal.prediction = null;
      } else if (goal.runtime !== 'interrupted' && goal.runtime !== 'failed' && goal.runtime !== 'paused' && goal.runtime !== 'stopped') {
        this.transition(goal, hook === 'Stop' ? 'waiting' : 'running', nowMs);
        goal.status = hook === 'Stop' || goal.relationPending ? 'unknown' : 'running';
      }
    }
    goal.lastObservedAt = nowMs;
  }

  runtime(sessionKey: string, turnKey: string, state: Runtime, nowMs: number): void {
    const goal = this.goals.get(sessionKey);
    if (!goal || !this.clock(nowMs, goal) || goal.turnKey !== turnKey || goal.runtime === 'interrupted' || goal.runtime === 'failed') return;
    if (state === 'running') {delete goal.terminalHook;delete goal.sourceStopped;}
    delete goal.runtimeUncertain;
    this.transition(goal, state, nowMs);
    goal.status = state;
    if (state === 'interrupted' || state === 'failed' || state === 'stopped') {goal.prediction = null; goal.predictionIdentity = null;}
    if (state === 'interrupted' || state === 'failed') goal.terminalSince = nowMs;
    else delete goal.terminalSince;
    if (state === 'stopped') {goal.summary = null;delete goal.summaryThroughSequence;goal.contextFloorTurnKey=goal.turnKey;}
    goal.lastObservedAt = nowMs;
  }

  /** Independent of inference eligibility; never infer completion from silence. */
  reconcileSource(sessionKey:string,nowMs:number):SourceTurnTakeover|null {
    const goal=this.goals.get(sessionKey);
    if(!goal||!this.clock(nowMs,goal)||!this.source?.execution)return null;
    // A read already in flight may finish after manual pause/stop. Never let
    // its takeover mutate source ownership or restart the active clock.
    if(goal.runtime==='paused'||goal.runtime==='stopped')return null;
    if(this.source.takeover){
      try{
        const takeover=this.source.takeover(sessionKey,goal.turnKey);
        if(takeover){const previousTurnKey=goal.turnKey;this.startTurn(goal,takeover.turnKey,nowMs);return {...takeover,previousTurnKey};}
      }catch{/* source evidence is advisory until a verified snapshot is available */}
    }
    // A terminal runtime remains authoritative for the old turn; only the
    // verified takeover above may establish a new running turn after it.
    if(goal.runtime==='interrupted'||goal.runtime==='failed')return null;
    let evidence:ReturnType<NonNullable<GoalContextSource['execution']>>;
    try{evidence=this.source.execution(sessionKey,goal.turnKey);}catch{evidence={state:'unknown',identity:'source-error'};}
    // A manual Stop remains a user pause unless the source supplies explicit
    // terminal provenance for this turn. A later verified next-turn takeover
    // was handled above and is allowed to establish the new turn.
    if(goal.terminalHook&&evidence?.outcome===undefined)return null;
    if(!evidence||goal.executionIdentity===evidence.identity)return null;
    goal.executionIdentity=evidence.identity;
    const priorRuntime=goal.runtime,priorUncertain=goal.runtimeUncertain;
    const uncertain=evidence.state==='unknown';
    const boundary=evidence.boundaryMs;
    const at=goal.runtimeUncertain&&evidence.state==='running'?nowMs:
      Number.isSafeInteger(boundary)?Math.max(goal.since,Math.min(nowMs,boundary!)):
        uncertain?goal.lastObservedAt:nowMs;
    goal.sourceStopped=evidence.state!=='running';
    if(uncertain){goal.timingUncertain=true;goal.runtimeUncertain=true;}
    else delete goal.runtimeUncertain;
    this.transition(goal,uncertain?'waiting':evidence.state as Runtime,at);
    // Host quiescence is not semantic "waiting for user" or goal completion.
    if(uncertain)goal.status='unknown';
    else if(evidence.outcome==='completed')goal.status='completed';
    else if(evidence.state==='interrupted'||evidence.state==='failed')goal.status=evidence.state;
    else if(priorRuntime!==goal.runtime||priorUncertain)goal.status='unknown';
    if (goal.status === 'completed' || goal.status === 'failed' || goal.status === 'interrupted') goal.terminalSince = nowMs;
    else delete goal.terminalSince;
    goal.lastObservedAt=nowMs;
    return null;
  }

  /** Keep a terminal source briefly so a missing Hook can still be recovered from local history. */
  retainSource(sessionKey:string,nowMs:number):boolean {
    const goal=this.goals.get(sessionKey);
    if(!goal||!this.clock(nowMs,goal))return false;
    if(!['completed','failed','interrupted'].includes(goal.status))return true;
    return goal.terminalSince!==undefined && nowMs-goal.terminalSince<15*60*1000;
  }

  currentTurnKey(sessionKey:string):string|undefined {return this.goals.get(sessionKey)?.turnKey;}

  request(sessionKey: string, nowMs: number): {ticket: object; input: ObserverInput}|null {
    const goal = this.goals.get(sessionKey);
    if (!goal || !this.clock(nowMs, goal) || goal.pending || goal.runtime === 'interrupted' || goal.runtime === 'failed' || goal.runtime === 'stopped' ||
        goal.status === 'completed') return null;
    const selected=this.source?this.sourceContext(sessionKey,goal,nowMs):null;
    if(this.source&&!selected)return null;
    const context = this.contexts.read(sessionKey);
    const messages = selected?.input.messages ?? context?.entries.filter(entry => entry.turnKey === goal.turnKey)
      .map(entry => ({...entry.content})) ?? [];
    if (!messages.length || (goal.summary === null && !messages.some(message => message.kind === 'user'))) return null;
    const activeSeconds = this.active(goal, nowMs);
    const baseInput=selected?.input ?? {goalSummary: goal.summary, activeSeconds,
      runtime: goal.runtime, messages, truncated: context?.truncated ?? false};
    const frozen=freezePaceRequest(baseInput,this.paceMeasurements.snapshot(goal.measurementScope));
    const ticket = Object.freeze({});
    goal.pending = ticket;
    this.tickets.set(ticket, {sessionKey, goal, goalIdentity:goal.identity, measurementScope:goal.measurementScope, epoch: goal.epoch, activeSeconds, requestedAt: nowMs,
      paceLookup:frozen.intervals,
      ...(selected?{sourceEpoch:selected.epoch,sourceRevision:selected.revision,
        ...(goal.measurementEpoch===undefined?{}:{sourceMeasurementEpoch:goal.measurementEpoch}),
        userFingerprint:selected.userFingerprint}: {})});
    return {ticket, input:frozen.input};
  }

  scheduling(sessionKey: string, nowMs: number): PassiveGoalScheduling|null {
    let view = this.view(sessionKey, nowMs);const goal = this.goals.get(sessionKey);
    if (!view || !goal) return null;
    if(this.source){
      const selected=this.sourceContext(sessionKey,goal,nowMs,true);
      view=this.view(sessionKey,nowMs)!;
      // Revisions, action IDs and user-identity fences also advance for
      // bookkeeping. Only a current-turn text fingerprint qualifies here.
      const contentIdentity=selected?.contentFingerprint===undefined?undefined:
        `source:${goal.turnKey}:${selected.contentFingerprint}`;
      return {view,goalIdentity:goal.identity,predictionIdentity:goal.predictionIdentity,sourceAvailable:selected!==null,ready:selected?.ready??false,
        finalAvailable:selected?.finalAvailable??false,revision:selected?.revision??0,
        currentActionId:selected?.currentActionId??null,...(contentIdentity===undefined?{}:{contentIdentity})};
    }
    const messages = this.contexts.read(sessionKey)?.entries.filter(entry => entry.turnKey === goal.turnKey) ?? [];
    const hasUser = messages.some(entry => entry.content.kind === 'user');
    // Match request(): a current user message is enough for an initial estimate.
    // Whether its meaning supplies an ETA basis belongs to the observer model.
    const contentIdentity=this.contextContentIdentity(sessionKey,goal.turnKey);
    return {view,goalIdentity:goal.identity,predictionIdentity:goal.predictionIdentity,
      sourceAvailable:true,
      ready: messages.length > 0 && (goal.summary !== null || hasUser),
      ...(contentIdentity===null?{}:{contentIdentity}),
      finalAvailable: messages.some(entry => entry.content.kind === 'assistant')};
  }

  settle(ticket: object, response: unknown, nowMs: number): boolean {
    const captured = this.tickets.get(ticket);
    if (!captured) return false;
    this.tickets.delete(ticket);
    const goal = this.goals.get(captured.sessionKey);
    if (goal?.pending === ticket) delete goal.pending;
    if(captured.sourceEpoch!==undefined){
      try{if(this.source?.epoch(captured.sessionKey)!==captured.sourceEpoch)return false;}
      catch{return false;}
    }
    if(captured.sourceMeasurementEpoch!==undefined){
      try{if(this.source?.measurementEpoch?.(captured.sessionKey)!==captured.sourceMeasurementEpoch)return false;}
      catch{return false;}
    }
    if (!this.clock(nowMs, goal) || nowMs < captured.requestedAt || goal !== captured.goal || goal.epoch !== captured.epoch ||
        goal.runtime === 'interrupted' || goal.runtime === 'failed' || goal.runtime === 'stopped') return false;
    let aged=false;
    if(captured.sourceRevision!==undefined){
      const current=this.sourceContext(captured.sessionKey,goal,nowMs,true);
      if(!current?.ready||goal.epoch!==captured.epoch)return false;
      aged=current.revision!==captured.sourceRevision;
      if(aged&&(captured.userFingerprint===undefined||current.userFingerprint!==captured.userFingerprint))return false;
    }
    const parsed = observerResponseSchema.safeParse(response);
    if (!parsed.success) return false;
    const result = parsed.data;
    if(aged){
      // A same-instruction numeric snapshot can age without becoming a new goal.
      // Do not apply its relation, summary, semantic state or summary watermark.
      if(result.estimate===null||result.relation==='unknown'||result.status==='completed'||
        goal.runtime!=='running')return false;
      goal.prediction={...result.estimate,observedActiveSeconds:captured.activeSeconds};
      delete goal.changeReason;
      goal.predictionIdentity={};
      goal.estimateRevision++;goal.lastObservedAt=nowMs;
      this.settledAnchors.set(ticket,captured.activeSeconds);
      this.acceptSettledPace(ticket,captured,goal);
      return true;
    }
    if (result.relation === 'unknown') {
      goal.estimateRevision++;
      goal.status = 'unknown';
      // An inconclusive refresh is not evidence that the established goal
      // changed. New user turns remain fenced by relationPending and must not
      // inherit an unrelated countdown.
      if(goal.relationPending){goal.prediction=null;goal.predictionIdentity=null;}
      goal.lastObservedAt = nowMs;
      this.settledAnchors.set(ticket,captured.activeSeconds);
      this.acceptSettledPace(ticket,captured,goal);
      return true;
    }
    // First attachment may describe the user's ongoing work as "continue".
    // Bootstrap only with a concrete summary, after all stale-ticket fences.
    const bootstrap = result.relation === 'continue' && goal.summary === null &&
      goal.relationPending && result.summary !== null;
    if ((result.relation === 'continue' && goal.summary === null && !bootstrap) ||
        (result.relation === 'replace' && !goal.relationPending) ||
        (result.status === 'completed' && (goal.runtime !== 'waiting'||goal.runtimeUncertain))) return false;
    let anchor = captured.activeSeconds;
    if (result.relation === 'replace' || bootstrap) {
      const base = goal.candidateBase;
      goal.elapsed = this.active(goal, nowMs) - base;
      goal.since = nowMs;
      anchor -= base;
      goal.candidateBase = 0;
      goal.generation++;
      goal.identity = {};
      this.rotateMeasurementScope(goal);
    }
    goal.summary = result.summary ?? goal.summary;
    if(result.relation==='replace')goal.contextFloorTurnKey=goal.turnKey;
    if(result.summary!==null&&captured.sourceRevision!==undefined)goal.summaryThroughSequence=captured.sourceRevision;
    goal.relationPending = false;
    // A model cannot freeze a live runtime or restart work stopped by the host.
    goal.status = result.status === 'completed' ? 'completed'
      : goal.runtime === 'running' ? (result.status === 'unknown' ? 'unknown' : 'running')
      : result.status === 'waiting' ? 'waiting' : 'unknown';
    // A refresh without a replacement estimate does not invalidate the same
    // goal's existing countdown or reset its active-time anchor.
    const retainPrediction = result.estimate === null && result.relation === 'continue' &&
      !bootstrap && result.status !== 'completed';
    if (!retainPrediction) {
      goal.prediction = result.estimate === null ? null : {...result.estimate, observedActiveSeconds: anchor};
      goal.changeReason=result.estimate===null?undefined:result.work?.changeReason;
      goal.predictionIdentity = result.estimate === null ? null : {};
    }
    goal.estimateRevision++;
    goal.lastObservedAt = nowMs;
    this.settledAnchors.set(ticket,anchor);
    this.acceptSettledPace(ticket,captured,goal);
    if(result.status==='completed'){goal.terminalSince=nowMs;this.rotateMeasurementScope(goal);}
    else delete goal.terminalSince;
    return true;
  }

  private acceptSettledPace(ticket:object,captured:Ticket,goal:Goal):void {
    if(goal!==captured.goal||goal.identity!==captured.goalIdentity||goal.epoch!==captured.epoch)return;
    this.settledPace.set(ticket,{sessionKey:captured.sessionKey,goal,goalIdentity:goal.identity,measurementScope:captured.measurementScope,epoch:goal.epoch,
      ...(captured.sourceEpoch===undefined?{}:{sourceEpoch:captured.sourceEpoch}),
      ...(captured.sourceMeasurementEpoch===undefined?{}:{sourceMeasurementEpoch:captured.sourceMeasurementEpoch}),
      intervals:captured.paceLookup});
  }

  paceIntervals(ticket:object,work:WorkBreakdown|null):readonly PaceInterval[] {
    const settled=this.settledPace.get(ticket);
    if(!settled||this.goals.get(settled.sessionKey)!==settled.goal||settled.goal.identity!==settled.goalIdentity||
      settled.goal.measurementScope!==settled.measurementScope||
      settled.goal.epoch!==settled.epoch||settled.goal.status==='completed'||!work||work.composition!=='serial'||work.changeReason!=='routine')return [];
    if(settled.sourceEpoch!==undefined){
      try{if(this.source?.epoch(settled.sessionKey)!==settled.sourceEpoch)return [];}catch{return [];}
    }
    if(settled.sourceMeasurementEpoch!==undefined){
      try{if(this.source?.measurementEpoch?.(settled.sessionKey)!==settled.sourceMeasurementEpoch)return [];}catch{return [];}
    }
    let target:WorkBreakdown['parts'][number]|undefined;
    for(const part of work.parts){
      if(part.remainingUnits!==null){if(target!==undefined)return [];target=part;}
    }
    if(!target||target.workClass!=='file_processing'||target.unit!=='file'||!target.measurementRef)return [];
    return settled.intervals.get(target.measurementRef)??[];
  }

  /** Private-to-server settlement metadata; available even when ETA is null. */
  settledAnchor(ticket:object):number|undefined {return this.settledAnchors.get(ticket);}

  view(sessionKey: string, nowMs: number): PassiveGoalView|null {
    const goal = this.goals.get(sessionKey);
    if (!goal || !this.clock(nowMs, goal)) return null;
    return {generation: goal.generation, estimateRevision: goal.estimateRevision, status: goal.status, runtime: goal.runtime,
      ...(goal.timingUncertain?{timingUncertain:true}:{}),...(goal.runtimeUncertain?{runtimeUncertain:true}:{}),
      activeSeconds: this.active(goal, nowMs), prediction: goal.prediction && {...goal.prediction},
      ...(goal.prediction&&goal.changeReason?{changeReason:goal.changeReason}:{})};
  }
  end(sessionKey: string): void {
    const goal=this.goals.get(sessionKey);if (!goal) return;
    this.paceMeasurements.clear(goal.measurementScope);
    this.goals.delete(sessionKey);
    // This is an additional recent-session fence, not the authoritative Hook replay
    // registry. The authenticated router/context owner must reject expired events.
    this.ended.add(sessionKey);
    if (this.ended.size > 4096) this.ended.delete(this.ended.values().next().value!);
  }
  activeTimeKnown(sessionKey:string):boolean {return this.goals.has(sessionKey)&&this.source===undefined;}
  clear(): void {
    for(const goal of this.goals.values())this.paceMeasurements.clear(goal.measurementScope);
    this.goals.clear(); this.ended.clear(); this.tickets = new WeakMap(); this.settledAnchors = new WeakMap(); this.settledPace = new WeakMap();
  }
}
