import type {HookEnvelope} from '../hooks/schema.js';
import type {PassiveContextStore} from './passive-context-store.js';
import {observerResponseSchema, type ObserverInput} from '../estimation/observer-contract.js';
import type {CountdownPrediction} from '../ui/countdown.js';

type Runtime = 'running'|'waiting'|'paused'|'interrupted'|'failed'|'stopped';
type Status = Runtime|'completed'|'unknown';
export interface PassiveGoalView {
  generation: number;
  estimateRevision: number;
  status: Status;
  runtime: Runtime;
  activeSeconds: number;
  prediction: CountdownPrediction | null;
}
interface Goal {
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
  lastObservedAt: number;
  pending?: object;
}
export interface GoalContextQuery {
  goalSummary:string|null;activeSeconds:number;runtime:ObserverInput['runtime'];
  previousEstimate:CountdownPrediction|null;
  summaryThroughSequence?:number;contextFloorTurnKey?:string;
}
export interface GoalContextSource {
  epoch(key:string):number|null;
  inspect?(key:string,turnKey:string,query:GoalContextQuery):{
    ready:boolean;revision:number;userFingerprint?:string;currentActionId:string|null;finalAvailable:boolean
  }|null;
  read(key:string,turnKey:string,query:GoalContextQuery):{
    epoch:number;revision:number;userFingerprint?:string;currentActionId:string|null;finalAvailable:boolean;input:ObserverInput
  }|null;
}
interface Ticket {sessionKey: string; goal: Goal; epoch: number; activeSeconds: number; requestedAt: number;sourceEpoch?:number;sourceRevision?:number;userFingerprint?:string}

/** Owns local identities and active clocks. Does not launch inference or authorize spend.
 * observe consumes only already-authenticated, accepted router deliveries.
 */
export class PassiveGoals {
  private readonly goals = new Map<string, Goal>();
  private readonly ended = new Set<string>();
  private tickets = new WeakMap<object, Ticket>();
  constructor(private readonly contexts: PassiveContextStore,private readonly source?:GoalContextSource) {}

  private sourceContext(key:string,goal:Goal,nowMs:number,inspectOnly?:false):ReturnType<GoalContextSource['read']>;
  private sourceContext(key:string,goal:Goal,nowMs:number,inspectOnly:true):ReturnType<NonNullable<GoalContextSource['inspect']>>;
  private sourceContext(key:string,goal:Goal,nowMs:number,inspectOnly=false) {
    if(!this.source || !['running','waiting','paused'].includes(goal.runtime))return null;
    try{
      const epoch=this.source.epoch(key);
      if(epoch===null)return null;
      if(goal.sourceEpoch!==undefined&&goal.sourceEpoch!==epoch){
        this.invalidate(goal);goal.summary=null;goal.prediction=null;goal.status='unknown';goal.relationPending=true;
        delete goal.summaryThroughSequence;delete goal.contextFloorTurnKey;goal.estimateRevision++;
      }
      goal.sourceEpoch=epoch;
      const query:GoalContextQuery={goalSummary:goal.summary,activeSeconds:this.active(goal,nowMs),
      runtime:goal.runtime as ObserverInput['runtime'],previousEstimate:goal.prediction,
      ...(goal.summaryThroughSequence===undefined?{}:{summaryThroughSequence:goal.summaryThroughSequence}),
      ...(goal.contextFloorTurnKey===undefined?{}:{contextFloorTurnKey:goal.contextFloorTurnKey})};
      if(inspectOnly&&this.source.inspect)return this.source.inspect(key,goal.turnKey,query);
      const capture=this.source.read(key,goal.turnKey,query);
      if(!inspectOnly||!capture)return capture;
      return {revision:capture.revision,userFingerprint:capture.userFingerprint,currentActionId:capture.currentActionId,finalAvailable:capture.finalAvailable,
        ready:capture.input.messages.length>0&&(goal.summary!==null||capture.input.messages.some(m=>m.kind==='user'))};}
    catch{return null;}
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
        this.goals.delete(inactive[0]);
        this.contexts.remove(inactive[0]);
      }
      goal = {turnKey: envelope.turnKey, generation: 0, estimateRevision: 0, epoch: 0, summary: null,
        relationPending: true, elapsed: 0, since: nowMs, candidateBase: 0,
        runtime: 'running', status: 'unknown', prediction: null, lastObservedAt: nowMs};
      this.goals.set(envelope.sessionKey, goal);
    }
    if (hook === 'UserPromptSubmit') {
      if (goal.turnKey !== envelope.turnKey) goal.candidateBase = this.active(goal, nowMs);
      goal.turnKey = envelope.turnKey;
      goal.relationPending = true;
      goal.prediction = null;
      goal.status = 'unknown';
      this.invalidate(goal);
      this.transition(goal, 'running', nowMs);
    } else if (goal.turnKey === envelope.turnKey) {
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
    this.transition(goal, state, nowMs);
    goal.status = state;
    if (state === 'interrupted' || state === 'failed' || state === 'stopped') goal.prediction = null;
    if (state === 'stopped') {goal.summary = null;delete goal.summaryThroughSequence;goal.contextFloorTurnKey=goal.turnKey;}
    goal.lastObservedAt = nowMs;
  }

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
    const ticket = Object.freeze({});
    goal.pending = ticket;
    this.tickets.set(ticket, {sessionKey, goal, epoch: goal.epoch, activeSeconds, requestedAt: nowMs,
      ...(selected?{sourceEpoch:selected.epoch,sourceRevision:selected.revision,userFingerprint:selected.userFingerprint}:{})});
    return {ticket, input: selected?.input ?? {goalSummary: goal.summary, activeSeconds,
      runtime: goal.runtime, messages, truncated: context?.truncated ?? false}};
  }

  scheduling(sessionKey: string, nowMs: number) {
    let view = this.view(sessionKey, nowMs);const goal = this.goals.get(sessionKey);
    if (!view || !goal) return null;
    if(this.source){
      const selected=this.sourceContext(sessionKey,goal,nowMs,true);
      view=this.view(sessionKey,nowMs)!;
      return {view,ready:selected?.ready??false,
        finalAvailable:selected?.finalAvailable??false,revision:selected?.revision??0,
        currentActionId:selected?.currentActionId??null};
    }
    const messages = this.contexts.read(sessionKey)?.entries.filter(entry => entry.turnKey === goal.turnKey) ?? [];
    const hasUser = messages.some(entry => entry.content.kind === 'user');
    // Match request(): a current user message is enough for an initial estimate.
    // Whether its meaning supplies an ETA basis belongs to the observer model.
    return {view, ready: messages.length > 0 && (goal.summary !== null || hasUser),
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
      goal.estimateRevision++;goal.lastObservedAt=nowMs;
      return true;
    }
    if (result.relation === 'unknown') {
      goal.estimateRevision++;
      goal.status = 'unknown'; goal.prediction = null;
      goal.lastObservedAt = nowMs;
      return true;
    }
    // First attachment may describe the user's ongoing work as "continue".
    // Bootstrap only with a concrete summary, after all stale-ticket fences.
    const bootstrap = result.relation === 'continue' && goal.summary === null &&
      goal.relationPending && result.summary !== null;
    if ((result.relation === 'continue' && goal.summary === null && !bootstrap) ||
        (result.relation === 'replace' && !goal.relationPending) ||
        (result.status === 'completed' && goal.runtime !== 'waiting')) return false;
    let anchor = captured.activeSeconds;
    if (result.relation === 'replace' || bootstrap) {
      const base = goal.candidateBase;
      goal.elapsed = this.active(goal, nowMs) - base;
      goal.since = nowMs;
      anchor -= base;
      goal.candidateBase = 0;
      goal.generation++;
    }
    goal.summary = result.summary ?? goal.summary;
    if(result.relation==='replace')goal.contextFloorTurnKey=goal.turnKey;
    if(result.summary!==null&&captured.sourceRevision!==undefined)goal.summaryThroughSequence=captured.sourceRevision;
    goal.relationPending = false;
    // A model cannot freeze a live runtime or restart work stopped by the host.
    goal.status = result.status === 'completed' ? 'completed'
      : goal.runtime === 'running' ? (result.status === 'unknown' ? 'unknown' : 'running')
      : result.status === 'waiting' ? 'waiting' : 'unknown';
    goal.prediction = result.estimate === null ? null : {...result.estimate, observedActiveSeconds: anchor};
    goal.estimateRevision++;
    goal.lastObservedAt = nowMs;
    return true;
  }

  view(sessionKey: string, nowMs: number): PassiveGoalView|null {
    const goal = this.goals.get(sessionKey);
    if (!goal || !this.clock(nowMs, goal)) return null;
    return {generation: goal.generation, estimateRevision: goal.estimateRevision, status: goal.status, runtime: goal.runtime,
      activeSeconds: this.active(goal, nowMs), prediction: goal.prediction && {...goal.prediction}};
  }
  end(sessionKey: string): void {
    if (!this.goals.delete(sessionKey)) return;
    // This is an additional recent-session fence, not the authoritative Hook replay
    // registry. The authenticated router/context owner must reject expired events.
    this.ended.add(sessionKey);
    if (this.ended.size > 4096) this.ended.delete(this.ended.values().next().value!);
  }
  activeTimeKnown(sessionKey:string):boolean {return this.goals.has(sessionKey)&&this.source===undefined;}
  clear(): void {
    this.goals.clear(); this.ended.clear(); this.tickets = new WeakMap();
  }
}
