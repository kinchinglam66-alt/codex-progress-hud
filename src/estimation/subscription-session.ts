import { metricsSchema, type Metrics, type Prediction } from "./contracts.js";
import { createCodexOutputParser, createObserverOutputParser, createCompressionOutputParser, type CodexOutput, type SubscriptionUsage, type ObserverOutput } from "./codex-output.js";
import {CompressionDispatchError, validateCompressionRequest, validateCompressionSummary, type CompressionDispatchResult, type CompressionRequest, type CompressionSummary} from './context-compression.js';
import type {ObserverInput, ObserverResponse} from './observer-contract.js';
import {packObserverInput} from './observer-input.js';
import type { createOwnedProcessRunner, Invocation, OwnedProcessResult } from "./owned-process.js";
import type {AccountingPurpose, AdmissionKind, SettlementClassification, SubscriptionAccounting} from './subscription-accounting.js';
import type {InvocationRecord} from './invocation-ownership.js';
import {ObserverPreDispatchTransient} from './observer-call-failure.js';
import {reportObserverStage, type ObserverCallStage} from './observer-provider.js';
import type {ObserverCallOutcomes, ObserverCallTimings, ObserverStatus, ObserverSubscriptionResult} from './observer-provider.js';
export type {ObserverCallOutcomes, ObserverCallTimings, ObserverSubscriptionResult} from './observer-provider.js';

type Status=ObserverStatus;
interface SessionResult<P> { status:Status; prediction:P|null; usage:SubscriptionUsage|null;admissionKind?:AdmissionKind;outcomes?:ObserverCallOutcomes;timings?:ObserverCallTimings }
export type SubscriptionResult = SessionResult<Prediction>;
interface Dependencies<I = Metrics> {
  ledger:SubscriptionAccounting;
  runner:ReturnType<typeof createOwnedProcessRunner>;
  prepare:(input:I, signal:AbortSignal)=>Invocation|Promise<Invocation>;
  invocationRecord?: (admissionId: string) => InvocationRecord;
}
interface SharedDependencies<I, P> extends Dependencies<I> {
  onStage?: (stage:ObserverCallStage)=>void;
  observerMode?:boolean;
  admissionKind?: AdmissionKind;
  purpose?: AccountingPurpose;
  authorize: () => boolean;
  parseInput: (input: unknown) => {success: true; data: I} | {success: false};
  createParser: () => {push(chunk: Uint8Array): boolean; end(): CodexOutput<P>&Partial<Pick<ObserverOutput,'framingValid'|'predictionStatus'|'usageStatus'>>};
  invocationRecord?: (admissionId: string) => InvocationRecord;
}

/** Internal offline orchestration seam. Dependencies are exclusively owned and
 * trusted, not task/model supplied. No default executable or live activation.
 * close drains this session; it does not implement a companion shutdown budget.
 */
function createSession<I extends object, P>({ledger,runner,prepare,authorize,parseInput,createParser,observerMode=false,admissionKind,purpose='eta',invocationRecord,onStage}:SharedDependencies<I, P>) {
  let disabled=false, externallyDisabled=false, active=false;
  let pending:Promise<SessionResult<P>>|undefined, closing:Promise<void>|undefined;
  let preparation:AbortController|undefined;
  const emptyOutcomes=(status:Status,usage:SubscriptionUsage|null):ObserverCallOutcomes=>({
    prediction:'invalid',call:status==='aborted'?'cancelled':'failed',usage:usage?'known':'unknown',
    framingValid:false,closureConfirmed:false,dispatch:'not_started'});
  const result=(status:Status,usage:SubscriptionUsage|null=null,prediction:P|null=null,outcomes?:ObserverCallOutcomes):SessionResult<P>=>({status,prediction,usage,
    ...(admissionKind?{admissionKind}:{}),
    ...(observerMode?{outcomes:outcomes?{...outcomes,usage:usage?'known':outcomes.usage==='not_dispatched'?'not_dispatched':'unknown'}:emptyOutcomes(status,usage)}:{})});
  const authorized=()=>{try {return authorize() === true;} catch {return false;}};
  const disable=()=>{externallyDisabled=true;disabled=true;preparation?.abort();runner.disable();};
  async function execute(invocation:Invocation,signal:AbortSignal,timings:ObserverCallTimings):Promise<SessionResult<P>> {
    const outcomes=observerMode?emptyOutcomes('process_error',null):undefined;
    let id:string|null;
    reportObserverStage(onStage,'reservation');
    try { id=await ledger.reserve(admissionKind, purpose); }
    catch { disable(); return result("accounting_error"); }
    if(id===null) return result("admission_denied");
    const ownedInvocation = invocationRecord === undefined ? undefined : {
      ...invocationRecord(id),
      ...(purpose === 'context_compression' ? {purpose} : {}),
    };
    try { if (ownedInvocation) await ledger.bindInvocation?.(id, ownedInvocation); }
    catch { disable(); return result('accounting_error'); }
    let usage:SubscriptionUsage|null=null, prediction:P|null=null;
    let cleanupConfirmed = false;
    let settlementClassification: SettlementClassification = 'unsafe_unknown';
    let status:Status="process_error";
    if(disabled || signal.aborted || !authorized()) {
      // Persist cancellation as its own transition. No provider usage was reported.
      status=signal.aborted?"aborted":"disabled";
      const cancellationStarted=performance.now();
      try{await ledger.cancelBeforeDispatch(id);}
      catch{disable();return result('accounting_error');}
      finally{timings.settlementMs=Math.round(performance.now()-cancellationStarted);}
      if(outcomes){outcomes.usage='not_dispatched';outcomes.closureConfirmed=true;outcomes.call='cancelled';}
      return result(status,null,null,outcomes);
    } else {
      const parser=createParser();
      try {
        if(outcomes)outcomes.dispatch='unknown';
        const providerStarted=performance.now();
        if (ownedInvocation) await ledger.updateInvocation?.(id, {phase: 'dispatching'});
        reportObserverStage(onStage,'dispatch');
        const process=await runner.run({...invocation, ...(ownedInvocation ? {
          ownership: ownedInvocation,
          onSpawnIdentity: async (pid:number, creationIdentity:string) => {
            if (!ledger.updateInvocation) throw new Error('INVOCATION_BINDING_UNAVAILABLE');
            await ledger.updateInvocation(id,{pid,creationIdentity,phase:'dispatching'});
          }
        } : {}), onStdout:parser.push},signal)
          .finally(()=>{timings.providerMs=Math.round(performance.now()-providerStarted);});
        reportObserverStage(onStage,'provider_returned');
        cleanupConfirmed = process.closed === true;
        const output=parser.end();
        if(outcomes){
          outcomes.processReason=process.reason;
          outcomes.closureConfirmed=process.closed;outcomes.framingValid=output.framingValid===true;
          outcomes.prediction=output.predictionStatus??'invalid';
          outcomes.call=process.reason==='exited'&&process.exitCode===0?'success':
            process.reason==='timeout'?'timeout':process.reason==='aborted'?'cancelled':'failed';
          if(['exited','timeout','output_limit','stdin_error','protocol_error'].includes(process.reason))outcomes.dispatch='started';
          if(['busy','unavailable'].includes(process.reason))outcomes.dispatch='not_started';
        }
        // Only confirmed exit makes the reported stream final. Cancellation can
        // suppress a prediction while an already-complete usage frame settles.
        if(process.closed && (output.ok || output.usage !== null || (observerMode&&output.framingValid===true))) usage=output.usage;
        const safeUnknown = observerMode && process.closed && output.framingValid === true &&
          output.predictionStatus !== 'invalid' && outcomes?.dispatch === 'started' &&
          outcomes.call === 'success' && !signal.aborted && !disabled && authorized();
        settlementClassification = usage === null
          ? safeUnknown ? 'safe_unknown' : 'unsafe_unknown'
          : process.closed && outcomes?.call === 'success' && output.framingValid === true &&
            !signal.aborted && !disabled && authorized() ? 'known_success' : 'known_non_success';
        if(disabled || !authorized()) status="disabled";
        else if(signal.aborted) status="aborted";
        else if(process.closed && process.reason==="exited" && process.exitCode===0 &&
          (output.ok || (observerMode&&output.framingValid===true&&output.predictionStatus!=='invalid'))) {
          prediction=output.prediction; status=prediction?"estimated":"unavailable";
        }
      } catch { /* A launch may have happened; never invent zero usage. */ }
    }
    const settlementStarted=performance.now();
    reportObserverStage(onStage,'settlement');
    try {
      if (ownedInvocation) await ledger.updateInvocation?.(id, {phase: 'settling'});
      await ledger.settle(id,usage?{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cachedInputTokens:usage.cachedInputTokens}:null,settlementClassification);
      if (ownedInvocation) await ledger.updateInvocation?.(id, {phase: 'closed', cleanupOutcome: cleanupConfirmed ? 'confirmed' : 'unconfirmed'});
      if(outcomes)outcomes.accounting='durably_settled';
    } catch { disable(); return result("accounting_error",usage,null,outcomes); }
    finally {timings.settlementMs=Math.round(performance.now()-settlementStarted);}
    if(usage===null) {disabled=true;runner.disable();}
    // Cancellation or disable can occur while settlement is fsyncing.
    if(((disabled&&(!observerMode||externallyDisabled)) || !authorized()) && (status==="estimated" || status==="unavailable")) return result("disabled",usage,null,outcomes);
    if(signal.aborted && (status==="estimated" || status==="unavailable")) return result("aborted",usage,null,outcomes);
    return result(status,usage,prediction,outcomes);
  }
  return {
    disable,
    estimate(input:unknown,signal:AbortSignal):Promise<SessionResult<P>> {
      if(disabled || !authorized()) return Promise.resolve(result("disabled"));
      if(active) return Promise.resolve(result("busy"));
      if(signal.aborted) return Promise.resolve(result("aborted"));
      const parsed=parseInput(input);
      if(!parsed.success) return Promise.resolve(result("invalid_input"));
      active=true;
      const startedAt=performance.now();
      const timings:ObserverCallTimings={preparationMs:0,providerMs:0,settlementMs:0,deliveryMs:0,totalMs:0};
      preparation=new AbortController();
      const prepareSignal=AbortSignal.any([signal,preparation.signal]);
      // Schedule after assigning pending so reentrant close/disable owns the
      // entire preparation operation, not just a subsequently spawned child.
      pending=Promise.resolve().then(async()=>{
        if(disabled || !authorized()) return result('disabled');
        if(signal.aborted) return result('aborted');
        try {
          const preparationStarted=performance.now();
          reportObserverStage(onStage,'preparation');
          let prepared:Invocation;
          try {prepared=await prepare(Object.freeze(parsed.data),prepareSignal);}
          finally {timings.preparationMs=Math.round(performance.now()-preparationStarted);}
          if(disabled || !authorized()) return result('disabled');
          if(signal.aborted) return result('aborted');
          const invocation={...prepared,args:[...prepared.args],env:{...prepared.env}};
          return execute(invocation,signal,timings);
        } catch(error) {
          if(observerMode&&!disabled&&!signal.aborted&&authorized()&&error instanceof ObserverPreDispatchTransient)
            return result('process_error',null,null,{...emptyOutcomes('process_error',null),preparationFailed:true,closureConfirmed:true,retryable:'pre_dispatch_transient'});
          const failedStatus=disabled?'disabled':signal.aborted?'aborted':'process_error';
          return result(failedStatus,null,null,observerMode?{...emptyOutcomes(failedStatus,null),preparationFailed:true}:undefined);
        }
      }).then(value=>observerMode?{...value,timings:{...timings,totalMs:Math.round(performance.now()-startedAt)}}:value)
        .finally(()=>{active=false;preparation=undefined;});
      return pending;
    },
    close():Promise<void> {
      if(closing) return closing;
      disable();
      closing=(pending??Promise.resolve()).then(()=>ledger.close()).catch(()=>{throw new Error("SUBSCRIPTION_SESSION_CLOSE_FAILED");});
      return closing;
    }
  };
}

export function createSubscriptionSession(dependencies: Dependencies) {
  return createSession({...dependencies, authorize: () => true,
    parseInput: input => metricsSchema.safeParse(input), createParser: createCodexOutputParser});
}

/** Owner-provided authorization must attest current consent and route. No default
 * activation is supplied here. The owner must disable the session on revocation
 * to abort an already-running process, not merely change the callback result.
 */
export function createObserverSubscriptionSession(dependencies: Dependencies<ObserverInput> & {authorize: () => boolean; admissionKind?: AdmissionKind;onStage?:(stage:ObserverCallStage)=>void}) {
  const session = createSession<ObserverInput, ObserverResponse>({...dependencies,
    observerMode:true,
    parseInput(input) {
      try {return {success: true, data: JSON.parse(packObserverInput(input)) as ObserverInput};}
      catch {return {success: false};}
    },
    createParser() {
      const parser = createObserverOutputParser();
      return {push: parser.push, end() {
        const {interpretation, ...output} = parser.end();
        return {...output, prediction: interpretation};
      }};
    }
  });
  return {
    disable: session.disable,
    close: session.close,
    status: dependencies.runner.status,
    async observe(input: unknown, signal: AbortSignal): Promise<ObserverSubscriptionResult> {
      const {status, prediction, usage,admissionKind,outcomes,timings} = await session.estimate(input, signal);
      return {status: status === 'estimated' ? 'interpreted' : status, interpretation: prediction, usage,
        ...(admissionKind?{admissionKind}:{}),
        ...(outcomes?{outcomes}:{}),...(timings?{timings}:{})};
    }
  };
}

export interface CompressionSubscriptionSessionDependencies extends Dependencies<CompressionRequest> {
  authorize: () => boolean;
  onStage?: (stage: ObserverCallStage) => void;
  admissionKind?: AdmissionKind;
  purpose?: 'context_compression';
}

/** Accounted subscription dispatch seam for context compression. It shares
 * createSession's reservation, owned-process, cancellation, settlement and
 * cleanup state machine; it never invokes the ETA scheduler. */
export function createSubscriptionCompressionSession(dependencies: CompressionSubscriptionSessionDependencies) {
  const session = createSession<CompressionRequest, CompressionSummary>({
    ...dependencies,
    purpose: 'context_compression',
    parseInput(input) {
      try { return {success: true, data: validateCompressionRequest(input)}; }
      catch { return {success: false}; }
    },
    createParser() {
      const parser = createCompressionOutputParser();
      return {push: parser.push, end() {
        const output = parser.end();
        return {
          ok: output.framingValid && output.summary !== null,
          prediction: output.summary,
          usage: output.usage,
          error: output.error,
          framingValid: output.framingValid,
          predictionStatus: output.summaryStatus === 'valid' ? 'numeric' as const : 'invalid' as const,
          usageStatus: output.usage === null ? 'unknown' as const : 'known' as const,
        };
      }};
    },
  });
  return {
    disable: session.disable,
    close: session.close,
    status: dependencies.runner.status,
    async summarize(request: CompressionRequest, signal: AbortSignal): Promise<CompressionDispatchResult> {
      const result = await session.estimate(request, signal);
      if (result.status === 'estimated' && result.prediction !== null) {
        try { return {summary: validateCompressionSummary(result.prediction, request), usage: result.usage}; }
        catch { throw new CompressionDispatchError('COMPRESSION_COVERAGE_INVALID', result.usage); }
      }
      if (result.status === 'aborted') throw new CompressionDispatchError('COMPRESSION_ABORTED', result.usage);
      if (result.status === 'invalid_input') throw new CompressionDispatchError('COMPRESSION_REQUEST_INVALID', result.usage);
      if (result.status === 'accounting_error') throw new CompressionDispatchError('COMPRESSION_ACCOUNTING_FAILED', result.usage);
      throw new CompressionDispatchError('COMPRESSION_PROVIDER_FAILED', result.usage);
    },
  };
}
