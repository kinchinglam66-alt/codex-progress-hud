import type {HookEnvelope} from '../hooks/schema.js';
import {ETA_TIME_BASIS} from '../core/eta-time-contract.js';
import {EtaLiveClock} from '../core/eta-live-clock.js';
import {TASK_OBJECTIVE_TARGET,objectiveState,type ObjectiveState,type ObjectiveEvidence,type AttentionEvidence} from '../core/task-objective.js';
import {projectPredictionSource,type PredictionSource} from '../estimation/prediction-source.js';
import {estimateUncertain} from '../estimation/completion-outlook.js';
import {assessEstimateCondition,type EstimateConditionAssessment} from '../estimation/estimate-conditions.js';
import type {PassiveContextStore} from './passive-context-store.js';
import {observerResponseSchema, type ObserverInput} from '../estimation/observer-contract.js';
import type {CountdownPrediction} from '../ui/countdown.js';
import {PaceMeasurements, type PaceContinuity, type PaceEvidence, type PaceGroup} from '../estimation/pace-measurements.js';
import type {PaceInterval, WorkBreakdown} from '../estimation/pace-correction.js';
import {freezePaceRequest} from '../estimation/pace-request-snapshot.js';
import {createHash} from 'node:crypto';
import {applyProgress,createProgressState,observeProgress,progressScope,type ProgressState} from '../estimation/progress-state.js';
import {retainPendingMilestone,reviewPendingMilestone,type PendingMilestone,type PendingReviewOutcome,type PendingMilestoneTelemetry} from '../estimation/pending-milestone.js';
import type {ResultRejectionReason} from '../core/observer-diagnostics.js';
import type {GoalCheckpointRecord} from './goal-checkpoint.js';
import type {MilestoneCheckpointRecord} from './milestone-checkpoint.js';
import type {HistorySnapshot} from '../observer/history-snapshot.js';
import type {NativeSourceDestination,OpenNativeSourceResult,BoundNativeTurnSource} from '../observer/native-source-request.js';
import type {ResearchBoundary,ResearchOwner} from '../estimation/residual/telemetry.js';

type Runtime = 'running'|'waiting'|'paused'|'interrupted'|'failed'|'stopped';
type Status = Runtime|'completed'|'unknown';
function objectiveId(sessionKey:string,turnKey:string):string {
  return 'objective_'+createHash('sha256').update(JSON.stringify([TASK_OBJECTIVE_TARGET,sessionKey,turnKey])).digest('hex');
}
export interface SourceTurnTakeover {turnKey:string;startedAtMs:number;identity:string;taskHandle?:string;previousTurnKey?:string}
export interface PassiveGoalView {
  predictionTarget?:typeof TASK_OBJECTIVE_TARGET;
  objectiveTargetId?:string;
  executionOutcome?:'completed'|'interrupted'|'failed';
  objectiveState?:ObjectiveState;
  attentionRequired?:boolean;
  attentionWorkContinuing?:boolean;
  timeBasis?:typeof ETA_TIME_BASIS;
  blockingUnknown?:boolean;
  blockingEvidenceIncomplete?:boolean;
  humanBlocked?:boolean;
  predictionSource?:PredictionSource;
  estimateUncertain?:boolean;
  estimateCondition?:EstimateConditionAssessment|undefined;
  progressState?:{scope:string;observedEventSequence:number;reviewApplication?:ProgressState['reviewApplication'];
    milestone:Pick<NonNullable<ProgressState['milestone']>,'id'|'definition'|'prediction'|'judgment'>|null};
  progressFloor?: number;
  recoveryState?: 'pending'|'restored';
  recoveryGapSeconds?: number|null;
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
  wallClock?:EtaLiveClock;
  estimateUncertain?:boolean;
  estimateCondition?:EstimateConditionAssessment|undefined;
  progressState?:ProgressState;
  progressScanRevision?:number;
  progressScanResultFingerprint?:string;
  progressFloor?: number;
  recoveryPending?: boolean;
  recovered?: boolean;
  recoveryGapSeconds?: number|null;
  terminalHook?: boolean;
  sourceStopped?: boolean;
  executionIdentity?: string;
  timingUncertain?: boolean;
  runtimeUncertain?: boolean;
  turnKey: string;
  turnGenerationStarted?: boolean;
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
  openNativeTurn?(key:string,turnKey:string,signal:AbortSignal):Promise<BoundNativeTurnSource|null>;
  openNativeSource?(key:string,turnKey:string,signal:AbortSignal,destination:NativeSourceDestination):Promise<OpenNativeSourceResult|null>;
  openHistory?(key:string,turnKey:string,signal:AbortSignal):Promise<{snapshot:HistorySnapshot;currentTurnId:string}|null>;
  health?(key:string):'loading'|'ready'|'error'|'missing';
  execution?(key:string,turnKey:string):{
    state:'running'|'waiting'|'interrupted'|'failed'|'unknown';outcome?:'completed'|'interrupted'|'failed';boundaryMs?:number;identity:string;researchReliable?:boolean;
    /** Only independently verified adapter facts; never model/text inference. */
    humanBlock?:{humanActionRequired:true;wholeTurnBlocked:true;relevantWorkRunning:false;evidenceRef:string};
    startedAtMs?:number;
    /** Signed monotonic projection; may predate this process's origin. */
    wallClockBoundaryMs?:number;
    blockingEvidenceComplete?:boolean;
    objectiveEvidence?:ObjectiveEvidence;
    attention?:AttentionEvidence;
  }|null;
  takeover?(key:string,turnKey:string):SourceTurnTakeover|null;
  epoch(key:string):number|null;
  inspect?(key:string,turnKey:string,query:GoalContextQuery):{
    ready:boolean;revision:number;userFingerprint?:string;contentFingerprint?:string;
    pairedResultFingerprint?:string;currentActionId:string|null;finalAvailable:boolean
  }|null;
  read(key:string,turnKey:string,query:GoalContextQuery):{
    researchFingerprint?:string;
    epoch:number;revision:number;userFingerprint?:string;contentFingerprint?:string;currentActionId:string|null;finalAvailable:boolean;input:ObserverInput
    paceEvidence?:PaceEvidence|readonly PaceEvidence[];paceContinuity?:PaceContinuity;
    paceBatches?:readonly {evidence:PaceEvidence;continuity:PaceContinuity}[];measurementEpoch?:number;
  }|null;
  measurementEpoch?(key:string):number|null;
}
interface Ticket {researchFingerprint?:string;sessionKey: string; goal: Goal; goalIdentity: object; measurementScope:object; epoch: number; activeSeconds: number; requestedAt: number;sourceEpoch?:number;sourceRevision?:number;sourceMeasurementEpoch?:number;userFingerprint?:string;paceLookup:ReadonlyMap<string,readonly PaceInterval[]>}
interface SettledPace {sessionKey:string;goal:Goal;goalIdentity:object;measurementScope:object;epoch:number;sourceEpoch?:number;sourceMeasurementEpoch?:number;intervals:ReadonlyMap<string,readonly PaceInterval[]>}
export interface OpenHistoryResult {snapshot:HistorySnapshot;currentTurnId:string}

/** Private scheduling/measurement metadata; never included in the public HUD snapshot. */
export interface ProgressDiagnostic {
  scope:string;observedEventSequence:number;pairedResultSequence?:number;
  milestone:{id:string;judgment:NonNullable<ProgressState['milestone']>['judgment'];
    completionCriterion:NonNullable<ProgressState['milestone']>['completionCriterion'];operationRef:string|null;
    prediction:NonNullable<ProgressState['milestone']>['prediction']}|null;
  reviewApplication?:ProgressState['reviewApplication'];milestoneApplication?:ProgressState['milestoneApplication'];
  reviewEvidenceRefs?:string[];lastObservedMilestone?:{milestoneId:string;operationRef:string;evidenceRef:string;
    sourceEndedAtMs:number;actualRemainingActiveSeconds:number|null;forecastErrorSeconds?:number|null};
}

export interface PassiveGoalScheduling {
  view: PassiveGoalView;
  progressDiagnostic?:ProgressDiagnostic;
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
  private readonly predictionSources=new WeakMap<object,PredictionSource>();
  private readonly goals = new Map<string, Goal>();
  private readonly recovery = new Map<string, GoalCheckpointRecord>();
  private readonly milestoneRecovery=new Map<string,MilestoneCheckpointRecord>();
  private recoveryWallNowMs: number|undefined;
  private readonly ended = new Set<string>();
  private tickets = new WeakMap<object, Ticket>();
  private progressTickets=new WeakMap<object,{scope:string;sequence:number;state:ProgressState;candidate?:PendingMilestone}>();
  private pendingMilestones=new WeakMap<Goal,PendingMilestone>();
  private pendingDecisions=new WeakMap<object,Readonly<{retained:boolean;reviewOutcome:PendingReviewOutcome;
    retainedCandidate?:PendingMilestoneTelemetry;
    candidateId?:string;assessment?:'in_progress'|'inferred_complete'|'superseded'|'unknown';
    evidenceRefs?:readonly string[];snapshotActiveSeconds?:number;sourceRevision?:number}>>();
  private rejectionReasons = new WeakMap<object, ResultRejectionReason>();
  private settledAnchors = new WeakMap<object, number>();
  private progressSettlements = new WeakMap<object, Readonly<{
    responseKind:'provided'|'explicit_null'|'omitted';
    outcome:'aged_numeric_only'|'unknown_relation'|'progress_applied';
  }>>();
  private settledPace = new WeakMap<object, SettledPace>();
  private readonly paceMeasurements = new PaceMeasurements();
  private progressFor(sessionKey:string,goal:Goal):ProgressState {
    // Native turn/source identity survives pause and bootstrap. Ticket epochs do not.
    // Generation and estimateRevision are independently verified on checkpoint restore.
    const scope=progressScope(sessionKey,goal.turnKey,goal.sourceEpoch??null,0);
    if(goal.progressState?.scope!==scope){goal.progressState=createProgressState(scope);delete goal.progressScanRevision;delete goal.progressScanResultFingerprint;}
    return goal.progressState;
  }
  constructor(private readonly contexts: PassiveContextStore,private readonly source?:GoalContextSource,
    private readonly onResearchBoundary?:(event:ResearchBoundary)=>void,
    private readonly timeBasis?:typeof ETA_TIME_BASIS,
    private readonly predictionTarget?:typeof TASK_OBJECTIVE_TARGET) {}

  private researchBoundary(sessionKey:string,goal:Goal,nowMs:number):void {
    if(!this.onResearchBoundary||!this.source?.execution)return;
    try{
      const evidence=this.source.execution(sessionKey,goal.turnKey),sourceEpoch=this.source.epoch(sessionKey);
      if(!evidence||sourceEpoch===null)return;
      const boundary=evidence.boundaryMs;
      const bounded=Number.isSafeInteger(boundary)&&boundary!>=goal.since&&boundary!<=nowMs;
      const activeSeconds=this.active(goal,bounded?boundary!:nowMs);
      const trusted=evidence.researchReliable===true&&!goal.timingUncertain&&!goal.runtimeUncertain&&
        !goal.recovered&&!goal.recoveryPending&&bounded;
      this.onResearchBoundary({sessionKey,turnKey:goal.turnKey,sourceEpoch,generation:goal.generation,activeSeconds,trusted,
        state:evidence.state==='running'?'running':evidence.state==='unknown'?'unknown':'waiting',evidenceId:evidence.identity,
        ...(evidence.outcome===undefined?{}:{outcome:evidence.outcome==='completed'?'normal_end':evidence.outcome})});
    }catch{/* Research never mutates or blocks lifecycle authority. */}
  }

  researchOwner(ticket:object):(ResearchOwner&{fingerprint?:string})|null {
    const captured=this.ticketIdentityIsCurrent(ticket);
    if(!captured||captured.sourceEpoch===undefined)return null;
    return {sessionKey:captured.sessionKey,turnKey:captured.goal.turnKey,sourceEpoch:captured.sourceEpoch,generation:captured.goal.generation,
      ...(captured.researchFingerprint===undefined?{}:{fingerprint:captured.researchFingerprint})};
  }
  currentResearchOwner(sessionKey:string):ResearchOwner|null {
    const goal=this.goals.get(sessionKey);if(!goal||goal.sourceEpoch===undefined)return null;
    return {sessionKey,turnKey:goal.turnKey,sourceEpoch:goal.sourceEpoch,generation:goal.generation};
  }

  /** Validated value records only; no restored object can authorize inference. */
  restoreCheckpoint(records:readonly GoalCheckpointRecord[],wallNowMs?:number):void {
    if(this.goals.size!==0||this.recovery.size!==0)throw Error('CHECKPOINT_ALREADY_INITIALIZED');
    this.recoveryWallNowMs=wallNowMs;
    for(const record of records.slice(0,256))this.recovery.set(record.sessionKey,structuredClone(record));
  }

  restoreMilestoneCheckpoint(records:readonly MilestoneCheckpointRecord[]):void {
    for(const record of records.slice(0,256))this.milestoneRecovery.set(record.sessionKey,structuredClone(record));
  }
  milestoneCheckpoint(wallNowMs:number):MilestoneCheckpointRecord[] {
    return [...this.goals].flatMap(([sessionKey,goal])=>goal.progressState&&goal.sourceEpoch!==undefined&&!goal.recoveryPending&&
      ['running','waiting','paused'].includes(goal.runtime)&&goal.status!=='completed'
      ?[{sessionKey,turnKey:goal.turnKey,sourceEpoch:goal.sourceEpoch,generation:goal.generation,estimateRevision:goal.estimateRevision,
        savedAtMs:wallNowMs,progressState:{...structuredClone(goal.progressState),operations:goal.progressState.operations.map(o=>({...o,description:''}))}}]:[]);
  }

  checkpoint(nowMs:number,wallNowMs:number):GoalCheckpointRecord[] {
    if(!this.clock(nowMs)||!Number.isSafeInteger(wallNowMs)||wallNowMs<0)throw Error('CHECKPOINT_CLOCK_INVALID');
    const records=new Map(this.recovery);
    for(const [sessionKey,goal] of this.goals){
      if(goal.recoveryPending)continue;
      if(!this.clock(nowMs,goal))throw Error('CHECKPOINT_CLOCK_INVALID');
      if(!['running','waiting','paused'].includes(goal.runtime)||goal.status==='completed'){
        records.delete(sessionKey);continue;
      }
      this.progress(goal,nowMs);
      records.set(sessionKey,{sessionKey,turnKey:goal.turnKey,generation:goal.generation,
        ...(this.timeBasis?{timeBasis:this.timeBasis}:{}),
        estimateRevision:goal.estimateRevision,savedAtMs:wallNowMs,activeSeconds:this.active(goal,nowMs),
        runtime:goal.runtime as GoalCheckpointRecord['runtime'],status:goal.status as GoalCheckpointRecord['status'],
        prediction:goal.prediction?{...goal.prediction}:null,progressFloor:goal.progressFloor??0,
        timingUncertain:goal.timingUncertain??false});
    }
    return [...records.values()].map(record=>structuredClone(record));
  }

  private progress(goal:Goal,nowMs:number):void {
    if(goal.runtime!=='running'||!goal.prediction)return;
    const active=this.active(goal,nowMs),prediction=goal.prediction;
    if(active<prediction.observedActiveSeconds)return;
    const remaining=Math.max(0,prediction.remainingSeconds-(active-prediction.observedActiveSeconds));
    const percent=active+remaining>0?Math.min(99,Math.floor(active/(active+remaining)*100)):0;
    goal.progressFloor=Math.max(goal.progressFloor??0,percent);
  }

  private beginRecovery(sessionKey:string,goal:Goal,nowMs:number):void {
    const saved=this.recovery.get(sessionKey);
    if(!saved)return;
    if(saved.turnKey!==goal.turnKey){this.recovery.delete(sessionKey);return;}
    if(this.timeBasis&&saved.timeBasis!==this.timeBasis){
      // Legacy active time cannot restore a wall-time anchor or prediction.
      this.recovery.delete(sessionKey);this.milestoneRecovery.delete(sessionKey);
      goal.timingUncertain=true;if(goal.wallClock)goal.wallClock.uncertain=true;return;
    }
    goal.elapsed=saved.activeSeconds;goal.since=nowMs;goal.candidateBase=0;
    goal.generation=saved.generation;goal.estimateRevision=saved.estimateRevision;
    goal.prediction=saved.prediction?{...saved.prediction}:null;
    goal.predictionIdentity=goal.prediction?{}:null;goal.progressFloor=saved.progressFloor;
    goal.runtime='waiting';goal.status='unknown';goal.runtimeUncertain=true;goal.timingUncertain=true;
    goal.recoveryPending=true;
    // This is the unobserved checkpoint-to-load interval, not proven work or downtime.
    const gap=this.recoveryWallNowMs===undefined?NaN:(this.recoveryWallNowMs-saved.savedAtMs)/1000;
    goal.recoveryGapSeconds=Number.isFinite(gap)&&gap>=0&&gap<=31_536_000?gap:null;
    if(this.timeBasis){
      goal.wallClock=new EtaLiveClock(nowMs-(goal.recoveryGapSeconds??0)*1000,saved.activeSeconds);
      goal.wallClock.uncertain=true;
      // Missing downtime evidence cannot justify a frozen or restarted prediction.
      goal.prediction=null;goal.predictionIdentity=null;this.milestoneRecovery.delete(sessionKey);
    }
  }

  private finishRecovery(sessionKey:string,goal:Goal,nowMs:number):boolean {
    if(!goal.recoveryPending)return true;
    const saved=this.recovery.get(sessionKey);
    if(!saved||!this.source?.execution||this.source.health?.(sessionKey)!=='ready')return false;
    let evidence:ReturnType<NonNullable<GoalContextSource['execution']>>;
    try{evidence=this.source.execution(sessionKey,goal.turnKey);}catch{return false;}
    if(!evidence||evidence.state==='unknown')return false;
    if(goal.terminalHook&&!evidence.outcome)return false;
    delete goal.recoveryPending;this.recovery.delete(sessionKey);goal.recovered=true;
    goal.since=nowMs;goal.lastObservedAt=nowMs;delete goal.runtimeUncertain;
    // Native terminal evidence supersedes even a saved manual pause.
    goal.runtime=saved.runtime==='paused'&&!evidence.outcome?'paused':evidence.state;
    goal.sourceStopped=evidence.state!=='running';
    goal.status=evidence.outcome??(goal.runtime==='running'?'unknown':goal.runtime);
    if(evidence.outcome&&goal.wallClock){
      const boundary=evidence.wallClockBoundaryMs;
      goal.wallClock.end(Number.isSafeInteger(boundary)?Math.max(goal.wallClock.startedAt,Math.min(nowMs,boundary!)):nowMs);
    }
    if(evidence.outcome)goal.terminalSince=nowMs;
    goal.executionIdentity=evidence.identity;
    if(goal.wallClock&&Number.isSafeInteger(evidence.startedAtMs)&&evidence.startedAtMs!<=nowMs&&
      goal.wallClock.earlierStart(evidence.startedAtMs!)){
      goal.prediction=null;goal.predictionIdentity=null;delete goal.progressState;
      this.pendingMilestones.delete(goal);this.invalidate(goal);
    }
    const sourceEpoch=this.source.epoch(sessionKey);
    if(sourceEpoch!==null)goal.sourceEpoch=sourceEpoch;
    const milestone=this.milestoneRecovery.get(sessionKey);this.milestoneRecovery.delete(sessionKey);
    if(milestone&&milestone.turnKey===goal.turnKey&&milestone.sourceEpoch===sourceEpoch&&
      milestone.generation===goal.generation&&milestone.estimateRevision===goal.estimateRevision&&
      milestone.progressState.scope===progressScope(sessionKey,goal.turnKey,sourceEpoch,0)&&!evidence.outcome)
      goal.progressState=structuredClone(milestone.progressState);
    return true;
  }

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
        this.pendingMilestones.delete(goal);
        delete goal.progressState;delete goal.progressScanRevision;delete goal.progressScanResultFingerprint;
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
    if(goal.wallClock)return goal.wallClock.elapsed(now);
    return goal.elapsed + (goal.runtime === 'running' ? (now - goal.since) / 1000 : 0);
  }
  private observeMilestone(goal:Goal,progress:ProgressState,messages:ObserverInput['messages'],nowMs:number):void {
    observeProgress(progress,messages,atMs=>{
      // Only the presently observed runtime segment is invertible. Prior
      // transitions, restart gaps and clock uncertainty never get interpolated.
      if(goal.runtime!=='running'||goal.timingUncertain||goal.runtimeUncertain||goal.recoveryPending||goal.recovered||
        !Number.isFinite(atMs)||atMs<goal.since||atMs>nowMs)return null;
      return this.active(goal,atMs);
    });
  }
  private invalidate(goal: Goal): void {
    goal.epoch++;
    delete goal.pending;
  }
  private transition(goal: Goal, runtime: Runtime, now: number): void {
    if (runtime === goal.runtime) return;
    if(runtime==='interrupted'||runtime==='failed'||runtime==='stopped')this.pendingMilestones.delete(goal);
    this.progress(goal,now);
    goal.elapsed = this.active(goal, now);
    goal.since = now;
    goal.runtime = runtime;
    this.invalidate(goal);
    this.rotateMeasurementScope(goal);
  }

  private startTurn(goal:Goal,turnKey:string,nowMs:number):void {
    this.pendingMilestones.delete(goal);
    delete goal.progressState;delete goal.progressScanRevision;delete goal.progressScanResultFingerprint;
    goal.generation++;
    goal.turnGenerationStarted=true;
    delete goal.recoveryPending;delete goal.recovered;delete goal.recoveryGapSeconds;goal.progressFloor=0;
    delete goal.terminalHook;delete goal.sourceStopped;delete goal.executionIdentity;delete goal.runtimeUncertain;delete goal.terminalSince;
    goal.turnKey=turnKey;goal.elapsed=0;goal.since=nowMs;goal.candidateBase=0;
    if(this.timeBasis)goal.wallClock=new EtaLiveClock(nowMs);
    goal.relationPending=true;goal.summary=null;delete goal.summaryThroughSequence;delete goal.contextFloorTurnKey;
    goal.prediction=null;goal.predictionIdentity=null;goal.identity={};goal.status='unknown';goal.runtime='running';
    goal.timingUncertain=false;goal.lastObservedAt=nowMs;this.invalidate(goal);this.rotateMeasurementScope(goal);
  }

  canAdmitRecovery(sessionKey:string,nowMs:number):boolean {
    return this.clock(nowMs)&&!this.ended.has(sessionKey)&&!this.goals.has(sessionKey)&&this.goals.size<32;
  }

  observe(envelope: HookEnvelope, follow: boolean, nowMs: number): void {
    let goal = this.goals.get(envelope.sessionKey);
    if (!this.clock(nowMs, goal) || !follow || envelope.turnKey === undefined ||
        this.ended.has(envelope.sessionKey) || envelope.receivedAt > nowMs) return;
    const hook = envelope.hook;
    if (!['UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt'].includes(hook)) return;
    if(goal?.recoveryPending&&goal.turnKey===envelope.turnKey){
      if(hook==='Interrupt'){
        this.recovery.delete(envelope.sessionKey);delete goal.recoveryPending;
      }else{if(hook==='Stop')goal.terminalHook=true;goal.lastObservedAt=nowMs;return;}
    }
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
        ...(this.timeBasis?{wallClock:new EtaLiveClock(nowMs)}:{}),
        relationPending: true, elapsed: 0, since: nowMs, candidateBase: 0,
        runtime: 'running', status: 'unknown', prediction: null, identity: {}, predictionIdentity: null,
        measurementScope: {}, lastObservedAt: nowMs};
      this.goals.set(envelope.sessionKey, goal);
      if(goal.wallClock&&hook!=='UserPromptSubmit'){
        goal.timingUncertain=true;goal.wallClock.uncertain=true;
      }
      this.beginRecovery(envelope.sessionKey,goal,nowMs);
      if(goal.recoveryPending)return;
    }
    if (goal.turnKey === envelope.turnKey && (goal.terminalHook||goal.sourceStopped) &&
        (hook === 'PostToolUse' || hook === 'UserPromptSubmit')) return;
    if (hook === 'UserPromptSubmit') {
      if (goal.turnKey !== envelope.turnKey) {this.recovery.delete(envelope.sessionKey);this.startTurn(goal,envelope.turnKey,nowMs);}
    } else if (goal.turnKey === envelope.turnKey) {
      if (hook === 'Stop' || hook === 'Interrupt') {goal.terminalHook = true;delete goal.runtimeUncertain;}
      if (hook === 'Interrupt') {
        goal.wallClock?.end(nowMs);
        this.transition(goal, 'interrupted', nowMs);
        goal.status = 'interrupted'; goal.prediction = null;
      } else if (goal.runtime !== 'interrupted' && goal.runtime !== 'failed' && goal.runtime !== 'paused' && goal.runtime !== 'stopped') {
        if(hook==='Stop')goal.wallClock?.blocking('unknown',nowMs);
        this.transition(goal, hook === 'Stop' ? 'waiting' : 'running', nowMs);
        goal.status = hook === 'Stop' || goal.relationPending ? 'unknown' : 'running';
      }
    }
    goal.lastObservedAt = nowMs;
  }

  runtime(sessionKey: string, turnKey: string, state: Runtime, nowMs: number): void {
    const goal = this.goals.get(sessionKey);
    if (!goal || !this.clock(nowMs, goal) || goal.turnKey !== turnKey || goal.runtime === 'interrupted' || goal.runtime === 'failed') return;
    if(goal.recoveryPending){
      const saved=this.recovery.get(sessionKey);
      if(saved&&(state==='paused'||state==='waiting'||state==='running')){
        this.recovery.set(sessionKey,{...saved,runtime:state,status:state});
        goal.runtime=state==='paused'?'paused':'waiting';goal.status=state==='paused'?'paused':'unknown';
        goal.since=nowMs;goal.lastObservedAt=nowMs;goal.runtimeUncertain=true;
        if(state==='running')delete goal.terminalHook;
        return;
      }
      this.recovery.delete(sessionKey);delete goal.recoveryPending;
    }
    if (state === 'running') {delete goal.terminalHook;delete goal.sourceStopped;}
    delete goal.runtimeUncertain;
    if(state==='interrupted'||state==='failed')goal.wallClock?.end(nowMs);
    else if(state==='waiting')goal.wallClock?.blocking('unknown',nowMs);
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
    this.researchBoundary(sessionKey,goal,nowMs);
    // A read already in flight may finish after manual pause/stop. Never let
    // its takeover mutate source ownership or restart the active clock.
    if(goal.runtime==='stopped')return null;
    if(goal.runtime==='paused'&&!goal.recoveryPending){
      if(!goal.recovered)return null;
      try{if(!this.source.execution(sessionKey,goal.turnKey)?.outcome)return null;}catch{return null;}
    }
    if(this.source.takeover){
      try{
        const takeover=this.source.takeover(sessionKey,goal.turnKey);
        if(takeover){const previousTurnKey=goal.turnKey;this.recovery.delete(sessionKey);this.startTurn(goal,takeover.turnKey,nowMs);
          if(Number.isSafeInteger(takeover.startedAtMs)&&takeover.startedAtMs<=nowMs)
            goal.wallClock?.earlierStart(takeover.startedAtMs);
          return {...takeover,previousTurnKey};}
      }catch{/* source evidence is advisory until a verified snapshot is available */}
    }
    if(!this.finishRecovery(sessionKey,goal,nowMs))return null;
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
    if(goal.wallClock&&Number.isSafeInteger(evidence.startedAtMs)&&evidence.startedAtMs!<=nowMs&&
      goal.wallClock.earlierStart(evidence.startedAtMs!)){
      goal.prediction=null;goal.predictionIdentity=null;delete goal.progressState;
      this.pendingMilestones.delete(goal);this.invalidate(goal);
    }
    const priorRuntime=goal.runtime,priorUncertain=goal.runtimeUncertain;
    const uncertain=evidence.state==='unknown';
    const boundary=goal.wallClock?evidence.wallClockBoundaryMs:evidence.boundaryMs;
    const missingWallBoundary=!!goal.wallClock&&!Number.isSafeInteger(boundary);
    // Legacy boundaries are zero-clamped and cannot prove a new-clock endpoint.
    // Preserve native outcome authority, but label observation-time fallback unknown.
    if(missingWallBoundary)goal.timingUncertain=true;
    const at=missingWallBoundary?nowMs:goal.runtimeUncertain&&evidence.state==='running'?nowMs:
      Number.isSafeInteger(boundary)?Math.max(goal.wallClock?.startedAt??goal.since,Math.min(nowMs,boundary!)):
        uncertain?goal.lastObservedAt:nowMs;
    goal.sourceStopped=evidence.state!=='running';
    if(goal.wallClock){
      if(evidence.outcome)goal.wallClock.end(at);
      else {
        const proof=evidence.humanBlock;
        const confirmed=proof?.humanActionRequired===true&&proof.wholeTurnBlocked===true&&
          proof.relevantWorkRunning===false&&evidence.attention?.relevantWorkRunning!==true&&typeof proof.evidenceRef==='string'&&proof.evidenceRef.length>0;
        const blocking=confirmed?'confirmed_human':evidence.state!=='running'||
          (evidence.attention?.required===true&&evidence.attention.relevantWorkRunning!==true)?'unknown':
          evidence.blockingEvidenceComplete===false?'uncovered':'none';
        goal.wallClock.blocking(blocking,Math.max(goal.lastObservedAt,at));
      }
    }
    if(uncertain){goal.timingUncertain=true;goal.runtimeUncertain=true;}
    else delete goal.runtimeUncertain;
    this.transition(goal,uncertain?'waiting':evidence.state as Runtime,at);
    // Host quiescence is not semantic "waiting for user" or goal completion.
    if(uncertain)goal.status='unknown';
    else if(evidence.outcome==='completed'){goal.status='completed';this.pendingMilestones.delete(goal);}
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

  private ticketIdentityIsCurrent(ticket:object,checkMeasurement=true):Ticket|null {
    const captured=this.tickets.get(ticket),goal=captured?this.goals.get(captured.sessionKey):undefined;
    if(!captured||!goal||goal!==captured.goal||goal.pending!==ticket||goal.epoch!==captured.epoch||
      goal.runtime==='paused'||goal.runtime==='interrupted'||goal.runtime==='failed'||
      goal.runtime==='stopped'||goal.status==='completed')return null;
    if(captured.sourceEpoch!==undefined){try{if(this.source?.epoch(captured.sessionKey)!==captured.sourceEpoch)return null;}catch{return null;}}
    if(checkMeasurement&&captured.sourceMeasurementEpoch!==undefined){try{
      const current=this.source?.measurementEpoch?.(captured.sessionKey);
      const proof=this.nativeValidationEpochs.get(ticket);
      if(current!==captured.sourceMeasurementEpoch&&(proof===undefined||current!==proof))return null;
    }catch{return null;}}
    return captured;
  }

  private ticketIsCurrent(ticket:object,nowMs:number):Ticket|null {
    const captured=this.ticketIdentityIsCurrent(ticket),goal=captured?this.goals.get(captured.sessionKey):undefined;
    return captured&&goal&&this.clock(nowMs,goal)?captured:null;
  }

  /** Non-consuming fence used by asynchronous preparation before dispatch. */
  isTicketValid(ticket:object,nowMs:number):boolean {return this.ticketIsCurrent(ticket,nowMs)!==null;}

  /** Refresh only at the exact frozen source revision, never append newer evidence to an older import. */
  progressAtSnapshot(ticket:object,input:ObserverInput,revision:number,nowMs:number):ObserverInput {
    const captured=this.ticketIsCurrent(ticket,nowMs);if(!captured)return input;
    const current=this.sourceContext(captured.sessionKey,captured.goal,nowMs);
    if(!current||current.revision!==revision||current.epoch!==captured.sourceEpoch||
      current.userFingerprint!==captured.userFingerprint)return input;
    const activeSeconds=current.input.activeSeconds;
    if(!Number.isFinite(activeSeconds)||activeSeconds<captured.activeSeconds||activeSeconds>31_536_000)return input;
    const progress=this.progressFor(captured.sessionKey,captured.goal);this.observeMilestone(captured.goal,progress,current.input.messages,nowMs);
    const candidate=this.pendingFor(captured.goal,progress.scope);
    this.progressTickets.set(ticket,{scope:progress.scope,sequence:progress.observedEventSequence,state:structuredClone(progress),...(candidate?{candidate:structuredClone(candidate)}:{})});
    captured.sourceRevision=revision;
    captured.activeSeconds=activeSeconds;
    const updated={...input,activeSeconds,...(current.input.observation?{observation:current.input.observation}:{}),progressState:structuredClone(progress)};
    delete updated.pendingMilestone;
    return candidate?{...updated,pendingMilestone:structuredClone(candidate)}:updated;
  }

  async openHistory(ticket:object,signal:AbortSignal):Promise<OpenHistoryResult|null> {
    const known=this.tickets.get(ticket);
    const captured=known&&this.ticketIdentityIsCurrent(ticket);
    if(!captured)throw Object.assign(new Error('goal ticket is stale'),{code:'GOAL_TICKET_STALE'});
    if(!this.source?.openHistory)return null;
    signal.throwIfAborted();
    const result=await this.source.openHistory(captured.sessionKey,captured.goal.turnKey,signal);
    if(!this.ticketIdentityIsCurrent(ticket)||signal.aborted){
      if(result!==null){try{await result.snapshot.close();}catch{/* stale history must not leak */}}
      throw Object.assign(new Error('goal ticket is stale'),{code:'GOAL_TICKET_STALE'});
    }
    return result;
  }

  async openNativeSource(ticket:object,signal:AbortSignal,destination:NativeSourceDestination):Promise<OpenNativeSourceResult|null> {
    const captured=this.ticketIdentityIsCurrent(ticket);
    if(!captured)throw Object.assign(new Error('goal ticket is stale'),{code:'GOAL_TICKET_STALE'});
    if(!this.source?.openNativeSource)return null;
    signal.throwIfAborted();
    const result=await this.source.openNativeSource(captured.sessionKey,captured.goal.turnKey,signal,destination);
    if(!this.ticketIdentityIsCurrent(ticket)||signal.aborted){
      if(result!==null)await result.snapshot.close();
      throw Object.assign(new Error('goal ticket is stale'),{code:'GOAL_TICKET_STALE'});
    }
    if(result)this.nativeTickets.set(ticket,false);
    return result;
  }

  async openNativeTurn(ticket:object,signal:AbortSignal):Promise<BoundNativeTurnSource|null>{
    const stale=()=>Object.assign(new Error('goal ticket is stale'),{code:'GOAL_TICKET_STALE'});
    const captured=this.ticketIdentityIsCurrent(ticket);if(!captured)throw stale();
    if(!this.source?.openNativeTurn)return null;
    signal.throwIfAborted();
    const result=await this.source.openNativeTurn(captured.sessionKey,captured.goal.turnKey,signal);
    if(!this.ticketIdentityIsCurrent(ticket)||signal.aborted){if(result)await result.close();throw stale();}
    if(!result)return null;
    this.nativeTickets.set(ticket,false);
    return {...result,validate:async checkSignal=>{
      // Display/pace projection loss is not loss of the frozen raw source.
      // Re-attest raw bytes, preserving all goal/turn/source-epoch fences.
      this.nativeValidationEpochs.delete(ticket);
      const combined=AbortSignal.any([signal,checkSignal]);
      if(!this.ticketIdentityIsCurrent(ticket,false))throw stale();combined.throwIfAborted();
      await result.validate(combined);
      if(!this.ticketIdentityIsCurrent(ticket,false))throw stale();combined.throwIfAborted();
      const epoch=this.source?.measurementEpoch?.(captured.sessionKey);
      if(epoch!==undefined&&epoch!==null)this.nativeValidationEpochs.set(ticket,epoch);
    }};
  }

  async openNativeHistoryFallback(ticket:object,signal:AbortSignal):Promise<OpenHistoryResult|null>{
    const result=await this.openHistory(ticket,signal);
    if(result)this.nativeTickets.set(ticket,false);
    return result;
  }

  private nativeTickets=new WeakMap<object,boolean>();
  /** Only a completed raw-byte validation grants a current projection epoch. */
  private nativeValidationEpochs=new WeakMap<object,number>();
  /** One bounded local supplement. Never called from settlement/arrival. */
  refreshNativeObservation(ticket:object,nowMs:number):import('../observer/native-source-request.js').NativeObservationSample|null {
    const captured=this.ticketIsCurrent(ticket,nowMs);
    if(!captured||this.nativeTickets.get(ticket)!==false||captured.goal.runtime!=='running')return null;
    const current=this.sourceContext(captured.sessionKey,captured.goal,nowMs,true);
    if(!current?.ready||!this.ticketIsCurrent(ticket,nowMs)||
      (current.revision!==captured.sourceRevision&&(captured.userFingerprint===undefined||current.userFingerprint!==captured.userFingerprint)))return null;
    const requestActiveSeconds=captured.activeSeconds;
    const activeSeconds=this.active(captured.goal,nowMs);
    if(activeSeconds<requestActiveSeconds)return null;
    this.nativeTickets.set(ticket,true);
    captured.activeSeconds=activeSeconds;
    return {activeSeconds,runtime:'running',requestActiveSeconds,...(this.timeBasis?{timeBasis:this.timeBasis}:{})};
  }

  request(sessionKey: string, nowMs: number): {ticket: object; input: ObserverInput}|null {
    const goal = this.goals.get(sessionKey);
    if (!goal || goal.recoveryPending || !this.clock(nowMs, goal) || goal.pending || goal.runtime === 'interrupted' || goal.runtime === 'failed' || goal.runtime === 'stopped' ||
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
    const progressState=this.progressFor(sessionKey,goal);
    this.observeMilestone(goal,progressState,baseInput.messages,nowMs);
    const candidate=this.pendingFor(goal,progressState.scope);
    const input:ObserverInput={...baseInput,...(this.timeBasis?{timeBasis:this.timeBasis}:{}),
      ...(this.predictionTarget?{predictionTarget:this.predictionTarget,objectiveTargetId:objectiveId(sessionKey,goal.turnKey)}:{}),progressState:structuredClone(progressState)};
    delete input.pendingMilestone;
    const frozen=freezePaceRequest({...input,...(candidate?{pendingMilestone:structuredClone(candidate)}:{})},this.paceMeasurements.snapshot(goal.measurementScope));
    const ticket = Object.freeze({});
    this.progressTickets.set(ticket,{scope:progressState.scope,sequence:progressState.observedEventSequence,state:structuredClone(progressState),...(candidate?{candidate:structuredClone(candidate)}:{})});
    goal.pending = ticket;
    this.tickets.set(ticket, {sessionKey, goal, goalIdentity:goal.identity, measurementScope:goal.measurementScope, epoch: goal.epoch, activeSeconds, requestedAt: nowMs,
      paceLookup:frozen.intervals,
      ...(selected?{sourceEpoch:selected.epoch,sourceRevision:selected.revision,
        ...(goal.measurementEpoch===undefined?{}:{sourceMeasurementEpoch:goal.measurementEpoch}),
        userFingerprint:selected.userFingerprint,...(selected.researchFingerprint===undefined?{}:{researchFingerprint:selected.researchFingerprint})}: {})});
    return {ticket, input:frozen.input};
  }

  scheduling(sessionKey: string, nowMs: number): PassiveGoalScheduling|null {
    let view = this.view(sessionKey, nowMs);const goal = this.goals.get(sessionKey);
    if (!view || !goal) return null;
    if(goal.recoveryPending)return {view,goalIdentity:goal.identity,predictionIdentity:goal.predictionIdentity,sourceAvailable:false,ready:false,finalAvailable:false};
    if(this.source){
      const selected=this.sourceContext(sessionKey,goal,nowMs,true);
      // A semantic milestone is not locally complete when a tool ends, but a
      // newly paired result is evidence worth reviewing at the next ETA call.
      if(selected&&goal.progressState?.milestone?.judgment==='in_progress'&&goal.progressScanRevision!==selected.revision){
        if(selected.pairedResultFingerprint!==undefined&&goal.progressScanResultFingerprint===selected.pairedResultFingerprint)
          goal.progressScanRevision=selected.revision;
        else {
          const detailed=this.sourceContext(sessionKey,goal,nowMs);
          if(detailed){
            this.observeMilestone(goal,this.progressFor(sessionKey,goal),detailed.input.messages,nowMs);
            goal.progressScanRevision=selected.revision;
            if(selected.pairedResultFingerprint===undefined)delete goal.progressScanResultFingerprint;
            else goal.progressScanResultFingerprint=selected.pairedResultFingerprint;
          }
        }
      }
      view=this.view(sessionKey,nowMs)!;
      // Revisions, action IDs and user-identity fences also advance for
      // bookkeeping. Only a current-turn text fingerprint qualifies here.
      const contentIdentity=selected?.contentFingerprint===undefined?undefined:
        `source:${goal.turnKey}:${selected.contentFingerprint}`;
      const progressDiagnostic=this.progressDiagnostic(sessionKey);
      return {view,goalIdentity:goal.identity,predictionIdentity:goal.predictionIdentity,sourceAvailable:selected!==null,ready:selected?.ready??false,
        finalAvailable:selected?.finalAvailable??false,revision:selected?.revision??0,
        currentActionId:selected?.currentActionId??null,...(contentIdentity===undefined?{}:{contentIdentity}),
        ...(progressDiagnostic?{progressDiagnostic}:{})};
    }
    const messages = this.contexts.read(sessionKey)?.entries.filter(entry => entry.turnKey === goal.turnKey) ?? [];
    const hasUser = messages.some(entry => entry.content.kind === 'user');
    // Match request(): a current user message is enough for an initial estimate.
    // Whether its meaning supplies an ETA basis belongs to the observer model.
    const contentIdentity=this.contextContentIdentity(sessionKey,goal.turnKey);
    const progressDiagnostic=this.progressDiagnostic(sessionKey);
    return {view,goalIdentity:goal.identity,predictionIdentity:goal.predictionIdentity,
      sourceAvailable:true,
      ready: messages.length > 0 && (goal.summary !== null || hasUser),
      ...(contentIdentity===null?{}:{contentIdentity}),
      ...(progressDiagnostic?{progressDiagnostic}:{}),
      finalAvailable: messages.some(entry => entry.content.kind === 'assistant')};
  }

  progressDiagnostic(sessionKey:string):ProgressDiagnostic|undefined {
    const progress=this.goals.get(sessionKey)?.progressState;
    if(!progress)return undefined;
    const milestone=progress.milestone;
    return {scope:progress.scope,observedEventSequence:progress.observedEventSequence,
      ...(progress.pairedResultSequence===undefined?{}:{pairedResultSequence:progress.pairedResultSequence}),
      milestone:milestone?{id:milestone.id,judgment:milestone.judgment,completionCriterion:milestone.completionCriterion,
        operationRef:milestone.operationRef,prediction:milestone.prediction?{...milestone.prediction}:null}:null,
      ...(progress.reviewApplication?{reviewApplication:{...progress.reviewApplication}}:{}),
      ...(progress.milestoneApplication?{milestoneApplication:{...progress.milestoneApplication}}:{}),
      ...(progress.reviewApplication?.outcome==='applied'&&progress.review?
        {reviewEvidenceRefs:[...progress.review.evidenceRefs]}:{}),
      ...(progress.lastObservedMilestone?{lastObservedMilestone:{milestoneId:progress.lastObservedMilestone.milestoneId,
        operationRef:progress.lastObservedMilestone.operationRef,evidenceRef:progress.lastObservedMilestone.evidenceRef,
        sourceEndedAtMs:progress.lastObservedMilestone.sourceEndedAtMs,
        actualRemainingActiveSeconds:progress.lastObservedMilestone.actualRemainingActiveSeconds,
        ...(progress.lastObservedMilestone.forecastErrorSeconds===undefined?{}:
          {forecastErrorSeconds:progress.lastObservedMilestone.forecastErrorSeconds})}}:{})};
  }

  settle(ticket: object, response: unknown, nowMs: number, source?:PredictionSource): boolean {
    const captured = this.tickets.get(ticket);
    if (!captured) {
      if (!this.rejectionReasons.has(ticket)) this.rejectionReasons.set(ticket,'ticket_missing');
      return false;
    }
    this.tickets.delete(ticket);
    const goal = this.goals.get(captured.sessionKey);
    if (goal?.pending === ticket) delete goal.pending;
    if(captured.sourceEpoch!==undefined){
      try{if(this.source?.epoch(captured.sessionKey)!==captured.sourceEpoch)return this.reject(ticket,'source_epoch_changed');}
      catch{return this.reject(ticket,'source_epoch_unavailable');}
    }
    if(captured.sourceMeasurementEpoch!==undefined){
      try{
        const current=this.source?.measurementEpoch?.(captured.sessionKey);
        const proof=this.nativeValidationEpochs.get(ticket);
        if(current!==captured.sourceMeasurementEpoch&&(proof===undefined||current!==proof))return this.reject(ticket,'measurement_epoch_changed');
      }
      catch{return this.reject(ticket,'measurement_epoch_unavailable');}
    }
    const clockValid=this.clock(nowMs,goal);
    if (!clockValid || nowMs < captured.requestedAt || goal !== captured.goal || goal.epoch !== captured.epoch ||
        goal.runtime === 'interrupted' || goal.runtime === 'failed' || goal.runtime === 'stopped') {
      const reason:ResultRejectionReason=!clockValid?'clock_invalid':
        nowMs<captured.requestedAt?'response_before_request':goal!==captured.goal?'goal_replaced':
        goal.epoch!==captured.epoch?'epoch_changed':'runtime_terminal';
      return this.reject(ticket,reason);
    }
    let aged=false;
    if(captured.sourceRevision!==undefined){
      const current=this.sourceContext(captured.sessionKey,goal,nowMs,true);
      if(!current?.ready||goal.epoch!==captured.epoch)
        return this.reject(ticket,!current?.ready?'source_not_ready':'epoch_changed');
      aged=current.revision!==captured.sourceRevision;
      if(aged&&(captured.userFingerprint===undefined||current.userFingerprint!==captured.userFingerprint))
        return this.reject(ticket,captured.userFingerprint===undefined?'source_revision_changed':'source_identity_changed');
    }
    const parsed = observerResponseSchema.safeParse(response);
    const progressTicket=this.progressTickets.get(ticket);
    if(goal.progressState?.milestone&&this.source){const current=this.sourceContext(captured.sessionKey,goal,nowMs);if(current)this.observeMilestone(goal,goal.progressState,current.input.messages,nowMs);}
    if(progressTicket&&goal.progressState&&(progressTicket.scope!==goal.progressState.scope||
      progressTicket.sequence!==goal.progressState.observedEventSequence))return this.reject(ticket,'critical_event_after_snapshot');
    if (!parsed.success) return this.reject(ticket,'schema_invalid');
    const result = parsed.data;
    // A blocker-report duration is not a forecast of achieving the task objective.
    if(this.predictionTarget&&result.estimate!==null&&result.estimateConditions?.selectedPath==='report_blocker')
      return this.reject(ticket,'prediction_target_mismatch');
    // Age against the actual sampled active clock, excluding pauses/waits.
    // Never re-anchor an already expired number to its arrival time.
    if(result.estimate!==null&&result.estimate.remainingSeconds<=Math.max(0,this.active(goal,nowMs)-captured.activeSeconds)){
      // A numeric deadline can expire while a snapshot-bound historical review
      // remains useful. Keep only that review, never a new forecast or milestone.
      if(goal.runtime==='running'&&goal.status!=='completed'&&result.status!=='completed')
        this.settlePendingMilestone(ticket,captured,result,false);
      return this.reject(ticket,'estimate_expired_on_arrival');
    }
    this.progress(goal,nowMs);
    if(aged){
      // A same-instruction numeric snapshot can age without becoming a new goal.
      // Do not apply its relation, summary, semantic state or summary watermark.
      // Preserve the same rejection boundary, but distinguish why no snapshot
      // can be applied. Semantic states take precedence over their null estimate.
      if(result.relation==='unknown'){
        if(goal.runtime==='running')this.settlePendingMilestone(ticket,captured,result,false);
        return this.reject(ticket,'aged_response_unknown_relation');
      }
      if(result.status==='completed')return this.reject(ticket,'aged_response_completed');
      if(result.estimate===null){
        if(goal.runtime==='running')this.settlePendingMilestone(ticket,captured,result,false);
        return this.reject(ticket,'aged_response_no_estimate');
      }
      if(goal.runtime!=='running')return this.reject(ticket,'aged_response_not_running');
      goal.prediction={...result.estimate,observedActiveSeconds:captured.activeSeconds};
      goal.estimateUncertain=estimateUncertain(result);
      goal.estimateCondition=assessEstimateCondition(result);
      delete goal.changeReason;
      goal.predictionIdentity={};
      const predictionSource=projectPredictionSource(source);
      if(predictionSource)this.predictionSources.set(goal.predictionIdentity,predictionSource);
      goal.estimateRevision++;goal.lastObservedAt=nowMs;
      // Aged responses can refresh the numeric turn ETA only, never milestone semantics.
      this.recordProgressSettlement(ticket,result.nextMilestone,'aged_numeric_only');
      this.settlePendingMilestone(ticket,captured,result,true);
      this.settledAnchors.set(ticket,captured.activeSeconds);
      this.acceptSettledPace(ticket,captured,goal);
      return true;
    }
    if (result.relation === 'unknown') {
      this.settlePendingMilestone(ticket,captured,result,false);
      this.recordProgressSettlement(ticket,result.nextMilestone,'unknown_relation');
      goal.estimateRevision++;
      goal.status = 'unknown';
      // An inconclusive refresh is not evidence that the established goal
      // changed. New user turns remain fenced by relationPending and must not
      // inherit an unrelated countdown.
      if(goal.relationPending&&!goal.recovered){goal.prediction=null;goal.predictionIdentity=null;}
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
        (result.status === 'completed' && (this.timeBasis!==undefined||goal.runtime !== 'waiting'||goal.runtimeUncertain))) {
      const reason:ResultRejectionReason=result.relation==='continue'&&goal.summary===null&&!bootstrap?
        'continue_without_summary':result.relation==='replace'&&!goal.relationPending?
        'replace_without_pending_relation':'completed_runtime_mismatch';
      return this.reject(ticket,reason);
    }
    let anchor = captured.activeSeconds;
    if ((result.relation === 'replace' || bootstrap)&&!goal.recovered) {
      const base = goal.candidateBase;
      goal.elapsed = this.active(goal, nowMs) - base;
      goal.since = nowMs;
      anchor -= base;
      goal.candidateBase = 0;
      if(!goal.turnGenerationStarted)goal.generation++;
      delete goal.turnGenerationStarted;
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
      (!bootstrap||goal.recovered) && result.status !== 'completed';
    if (!retainPrediction) {
      goal.prediction = result.estimate === null ? null : {...result.estimate, observedActiveSeconds: anchor};
      goal.estimateUncertain=result.estimate!==null&&estimateUncertain(result);
      goal.estimateCondition=assessEstimateCondition(result);
      goal.changeReason=result.estimate===null?undefined:result.work?.changeReason;
      goal.predictionIdentity = result.estimate === null ? null : {};
      const predictionSource=projectPredictionSource(source);
      if(goal.predictionIdentity&&predictionSource)this.predictionSources.set(goal.predictionIdentity,predictionSource);
    }
    goal.estimateRevision++;
    goal.lastObservedAt = nowMs;
    applyProgress(this.progressFor(captured.sessionKey,goal),result.status==='completed'?null:result.nextMilestone,result.progressReview,result.estimate,anchor);
    this.settlePendingMilestone(ticket,captured,result,false);
    if(result.status==='completed')this.pendingMilestones.delete(goal);
    this.recordProgressSettlement(ticket,result.nextMilestone,'progress_applied');
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

  /** Safe diagnostic for the last settlement attempt represented by an opaque ticket. */
  rejectionReason(ticket:object):ResultRejectionReason|undefined {return this.rejectionReasons.get(ticket);}
  private recordProgressSettlement(ticket:object,next:unknown,outcome:'aged_numeric_only'|'unknown_relation'|'progress_applied'):void {
    this.progressSettlements.set(ticket,Object.freeze({responseKind:next===undefined?'omitted':next===null?'explicit_null':'provided',outcome}));
  }
  progressSettlement(ticket:object) {return this.progressSettlements.get(ticket);}
  pendingMilestoneDecision(ticket:object) {return this.pendingDecisions.get(ticket);}
  private pendingFor(goal:Goal,scope:string):PendingMilestone|undefined {
    const candidate=this.pendingMilestones.get(goal);
    if(candidate?.scope!==scope){this.pendingMilestones.delete(goal);return undefined;}
    return candidate;
  }
  private settlePendingMilestone(ticket:object,captured:Ticket,result:import('../estimation/observer-contract.js').ObserverResponse,aged:boolean):void {
    const proof=this.progressTickets.get(ticket);if(!proof)return;
    if(!aged&&!proof.candidate)return;
    const outcome=reviewPendingMilestone(proof.candidate,result.pendingMilestoneReview,proof.state);
    if(outcome==='reviewed'&&['inferred_complete','superseded'].includes(result.pendingMilestoneReview!.assessment)&&
      this.pendingMilestones.get(captured.goal)?.id===proof.candidate?.id)this.pendingMilestones.delete(captured.goal);
    let retained=false,retainedCandidate:PendingMilestoneTelemetry|undefined;
    if(aged){
      // Store only a historical forecast from the exact request snapshot. Never
      // install it into progressState.milestone or synthesize a critical event.
      const candidate=retainPendingMilestone(result.nextMilestone,proof.state,captured.activeSeconds,captured.sourceRevision,
        proof.state.pairedResultOrdinal!==undefined&&proof.state.pairedResultOrdinal>=0?proof.state.pairedResultOrdinal:null,
        result.estimate?.remainingSeconds??null);
      if(candidate){this.pendingMilestones.set(captured.goal,candidate);retained=true;
        retainedCandidate={id:candidate.id,observedActiveSeconds:candidate.observedActiveSeconds,sourceRevision:candidate.sourceRevision,
          completionCriterion:candidate.forecast.completionCriterion,estimate:structuredClone(candidate.forecast.estimate)};}
    }
    this.pendingDecisions.set(ticket,Object.freeze({retained,reviewOutcome:outcome,
      ...(retainedCandidate?{retainedCandidate}:{}),
      ...(outcome==='reviewed'?{candidateId:proof.candidate!.id,assessment:result.pendingMilestoneReview!.assessment,
        evidenceRefs:Object.freeze([...result.pendingMilestoneReview!.evidenceRefs]),snapshotActiveSeconds:captured.activeSeconds,
        ...(captured.sourceRevision===undefined?{}:{sourceRevision:captured.sourceRevision})}:{})}));
  }

  view(sessionKey: string, nowMs: number): PassiveGoalView|null {
    const goal = this.goals.get(sessionKey);
    if (!goal || !this.clock(nowMs, goal)) return null;
    this.progress(goal,nowMs);
    let evidence:ReturnType<NonNullable<GoalContextSource['execution']>>=null;
    try{if(this.predictionTarget)evidence=this.source?.execution?.(sessionKey,goal.turnKey)??null;}catch{/* Unavailable evidence is not proof of achievement or no pending attention. */}
    const outcome=goal.status==='completed'?'completed':goal.runtime==='failed'?'failed':goal.runtime==='interrupted'?'interrupted':undefined;
    const targetId=objectiveId(sessionKey,goal.turnKey);
    const objective=this.predictionTarget?objectiveState(targetId,outcome,evidence?.objectiveEvidence):undefined;
    const attention=evidence?.attention;
    const attentionRequired=attention?.required===true&&!!attention.evidenceRef?.trim();
    return {generation: goal.generation, estimateRevision: goal.estimateRevision,
      status:objective==='completed'||objective==='unverified'?'completed':objective==='interrupted'?'interrupted':goal.status, runtime: goal.runtime,
      ...(objective?{predictionTarget:TASK_OBJECTIVE_TARGET,objectiveTargetId:targetId,objectiveState:objective,
        ...(outcome?{executionOutcome:outcome}:{}),
        ...(outcome?{attentionRequired:false}:goal.wallClock?.humanBlocked===true?{attentionRequired:true,attentionWorkContinuing:false}:
          attention?.evidenceRef?.trim()?{attentionRequired,
            ...(typeof attention.relevantWorkRunning==='boolean'?{attentionWorkContinuing:attentionRequired&&attention.relevantWorkRunning}:{})}:{} )}:{}),
      ...(this.timeBasis?{timeBasis:this.timeBasis,blockingUnknown:goal.wallClock?.unknownBlocking??true,
        blockingEvidenceIncomplete:goal.wallClock?.blockingEvidenceIncomplete??false,humanBlocked:goal.wallClock?.humanBlocked??false}:{}),
      ...(goal.prediction&&goal.predictionIdentity&&this.predictionSources.has(goal.predictionIdentity)?
        {predictionSource:{...this.predictionSources.get(goal.predictionIdentity)!}}:{}),
      ...(goal.progressState?{progressState:{scope:goal.progressState.scope,observedEventSequence:goal.progressState.observedEventSequence,
        ...(goal.progressState.reviewApplication?{reviewApplication:{...goal.progressState.reviewApplication}}:{}),
        milestone:goal.progressState.milestone?{id:goal.progressState.milestone.id,definition:goal.progressState.milestone.definition,
          prediction:goal.progressState.milestone.prediction?{...goal.progressState.milestone.prediction}:null,judgment:goal.progressState.milestone.judgment}:null}}:{}),
      ...(goal.progressFloor===undefined?{}:{progressFloor:goal.progressFloor}),
      ...(goal.recoveryPending?{recoveryState:'pending' as const}:goal.recovered?{recoveryState:'restored' as const}:{}),
      ...(goal.recoveryGapSeconds===undefined?{}:{recoveryGapSeconds:goal.recoveryGapSeconds}),
      ...(goal.timingUncertain||goal.wallClock?.uncertain?{timingUncertain:true}:{}),...(goal.runtimeUncertain?{runtimeUncertain:true}:{}),
      activeSeconds: this.active(goal, nowMs), prediction: objective&&objective!=='ongoing'?null:goal.prediction && {...goal.prediction},
      ...(goal.prediction&&goal.estimateUncertain?{estimateUncertain:true}:{}),
      ...(goal.prediction?{estimateCondition:goal.estimateCondition?{...goal.estimateCondition}:
        {selectedPath:'unknown' as const,displayPath:'unknown' as const,issue:'missing_conditions' as const}}:{}),
      ...(goal.prediction&&goal.changeReason?{changeReason:goal.changeReason}:{})};
  }
  end(sessionKey: string): void {
    this.milestoneRecovery.delete(sessionKey);
    this.recovery.delete(sessionKey);
    const goal=this.goals.get(sessionKey);if (!goal) return;
    this.paceMeasurements.clear(goal.measurementScope);
    this.goals.delete(sessionKey);
    // This is an additional recent-session fence, not the authoritative Hook replay
    // registry. The authenticated router/context owner must reject expired events.
    this.ended.add(sessionKey);
    if (this.ended.size > 4096) this.ended.delete(this.ended.values().next().value!);
  }
  activeTimeKnown(sessionKey:string):boolean {
    const goal=this.goals.get(sessionKey);
    return !!goal&&this.source===undefined&&!goal.wallClock?.uncertain;
  }
  clockBasis():typeof ETA_TIME_BASIS|undefined {return this.timeBasis;}
  predictionEndpoint():typeof TASK_OBJECTIVE_TARGET|undefined {return this.predictionTarget;}
  clear(): void {
    this.milestoneRecovery.clear();
    this.recovery.clear();
    for(const goal of this.goals.values())this.paceMeasurements.clear(goal.measurementScope);
    this.goals.clear(); this.ended.clear(); this.tickets = new WeakMap(); this.rejectionReasons = new WeakMap(); this.settledAnchors = new WeakMap(); this.settledPace = new WeakMap();
  }

  private reject(ticket:object,reason:ResultRejectionReason):false {this.rejectionReasons.set(ticket,reason);return false;}
}

/** Shared production composition for the desktop and pinned evaluation driver.
 * The raw constructor remains available only for explicit legacy compatibility. */
export function createProductionPassiveGoals(contexts:PassiveContextStore,source?:GoalContextSource,
  onResearchBoundary?:(event:ResearchBoundary)=>void):PassiveGoals {
  return new PassiveGoals(contexts,source,onResearchBoundary,ETA_TIME_BASIS,TASK_OBJECTIVE_TARGET);
}
