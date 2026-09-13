import {randomUUID} from 'node:crypto';
import {observerInputSchema} from './observer-contract.js';
import type {ObserverWorker} from './observer-scheduler.js';
import type {ObserverResult} from './observer-provider.js';
import {reportObserverStage} from './observer-provider.js';
import type {ReleaseAccountingOwner} from './release-accounting.js';
import type {SubscriptionAccounting} from './subscription-accounting.js';
import type {Invocation} from './owned-process.js';
import {createObserverSessionProcess} from './observer-session-process.js';
import {createPersistentObserverSession, type PersistentCompactionResult, type PersistentSessionError, type PersistentContextCapacityPolicy} from './observer-persistent-session.js';
import {createPersistentReceiptJournal,type PersistentReceiptBinding,type PersistentReceiptJournal} from './observer-persistent-receipt.js';
import {normalizeAdmissionReason} from '../core/observer-diagnostics.js';

export interface PersistentWorkerOptions {
 accounting:ReleaseAccountingOwner;prepareSession:(signal:AbortSignal)=>Promise<{invocation:Invocation;binding:PersistentReceiptBinding}>;
 authorize:()=>boolean;now:()=>number;outputSchema:unknown;
 receiptDirectory:string;
  sessionTimeoutMs?:number;bootstrapBatchByteCapacity?:number;retainedSummaryByteReserve?:number;receiptJournalFactory?:(directory:string)=>PersistentReceiptJournal;
  /** Finite, explicitly trusted policy for one history preparation. */
  historyBudget?:PersistentHistoryBudget;
 processFactory?:()=>ReturnType<typeof createObserverSessionProcess>;
}
export interface PersistentHistoryBudget {
  trusted:true;
  maxSourceBytes:number;
  maxCompactionOperations:number;
  contextCapacityBytes:number;
  retainedSummaryReserveBytes:number;
}
const empty=(status:ObserverResult['status']):ObserverResult=>({status,interpretation:null,usage:null});

/** Each source owns one process, each model operation a separate admission.
 * Invocation records remain in settling/pending while their process lives:
 * an operation terminal must never masquerade as a closed process. */
export function createPersistentObserverWorker(options:PersistentWorkerOptions):ObserverWorker {
 let disabled=false,poisoned=false,pending:Promise<unknown>|undefined,controller:AbortController|undefined;
 let owner:ReturnType<typeof createObserverSessionProcess>|undefined;
 let processIdentity:{pid:number;creationIdentity:string}|undefined;
 let processBinding:PersistentReceiptBinding|undefined;
 let session:ReturnType<typeof createPersistentObserverSession>|undefined;
 let sourceKey:string|undefined,sourceEpoch:string|undefined,generation=-1;
 let processOwnerUuid=randomUUID(),journal:PersistentReceiptJournal|undefined;
  if(!options.receiptDirectory)throw Error('PERSISTENT_RECEIPT_REQUIRED');
  const budget=options.historyBudget;
  if(budget!==undefined&&(
    budget.trusted!==true||!Number.isSafeInteger(budget.maxSourceBytes)||budget.maxSourceBytes<1||
    !Number.isSafeInteger(budget.maxCompactionOperations)||budget.maxCompactionOperations<0||
    !Number.isSafeInteger(budget.contextCapacityBytes)||budget.contextCapacityBytes<1||
    !Number.isSafeInteger(budget.retainedSummaryReserveBytes)||budget.retainedSummaryReserveBytes<0||
    budget.contextCapacityBytes<budget.retainedSummaryReserveBytes+(options.bootstrapBatchByteCapacity??65536)
  ))throw Error('INVALID_HISTORY_BUDGET');
 journal=(options.receiptJournalFactory??createPersistentReceiptJournal)(options.receiptDirectory);
 let closing:Promise<void>|undefined;
 const turns=new Map<string,number>();
 const authorized=()=>{try{return !disabled&&!poisoned&&options.authorize()===true;}catch{return false;}};
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!authorized())throw Error('OBSERVER_NOT_AUTHORIZED');};
 const bind=(key:string,g:number)=>{
   if(sourceKey!==undefined&&sourceKey!==key)throw Error('SOURCE_MISMATCH');
   if(!Number.isSafeInteger(g)||g<0||g<generation)throw Error('SOURCE_GENERATION');
   sourceKey=key;generation=g;
 };
 async function reset(){
   if(owner){try{await owner.close();}catch{poisoned=true;throw Error('SESSION_PROCESS_CLOSE_UNCONFIRMED');}
     if(processIdentity)await journal!.processExit({ownerUuid:processOwnerUuid,...(sourceKey===undefined?{}:{sourceKey}),sourceEpoch:sourceEpoch??null,processExitState:'closed',at:options.now()});
   }
   owner=undefined;session=undefined;processIdentity=undefined;processBinding=undefined;sourceEpoch=undefined;turns.clear();
   processOwnerUuid=randomUUID();
 }
 async function ensure(signal:AbortSignal){
   check(signal);
   // Fresh attestation every operation, even when its process is reused.
   const prepared=await options.prepareSession(signal);check(signal);
   if(owner&&(owner.status().closed||session?.status().uncertain))await reset();
   if(session&&processBinding&&JSON.stringify(processBinding)!==JSON.stringify(prepared.binding))await reset();
   if(session)return session;
   owner=(options.processFactory??createObserverSessionProcess)();
   const opened=await owner.start(prepared.invocation);processIdentity={pid:opened.pid,creationIdentity:opened.creationIdentity};processBinding=prepared.binding;check(signal);
   await journal!.ownerStarted({ownerUuid:processOwnerUuid,sourceKey:sourceKey??'unknown',sourceEpoch:sourceEpoch??null,pid:opened.pid,creationIdentity:opened.creationIdentity,binding:prepared.binding});
   await opened.rpc.call('initialize',{clientInfo:{name:'codex_progress_hud',version:'0.2.1'},capabilities:{experimentalApi:true,requestAttestation:false}});
   opened.rpc.notify('initialized',{});
    session=createPersistentObserverSession(opened.rpc,{cwd:prepared.invocation.cwd,outputSchema:options.outputSchema,now:options.now,
      ...(options.sessionTimeoutMs===undefined?{}:{timeoutMs:options.sessionTimeoutMs}),
      ...(options.bootstrapBatchByteCapacity===undefined?{}:{bootstrapBatchByteCapacity:options.bootstrapBatchByteCapacity}),
       ...(options.retainedSummaryByteReserve===undefined?{}:{retainedSummaryByteReserve:options.retainedSummaryByteReserve}),
       ...(budget===undefined?{}:{contextCapacityPolicy:{trusted:true,contextCapacityBytes:budget.contextCapacityBytes,retainedSummaryReserveBytes:budget.retainedSummaryReserveBytes} satisfies PersistentContextCapacityPolicy})});
    await session.start();check(signal);return session;
  }
  type ModelOperationKind='eta'|'context_compression';
  type ModelAdmission={view:SubscriptionAccounting;id:string;denialReason?:never}|{view?:SubscriptionAccounting;id?:never;denialReason:ReturnType<typeof normalizeAdmissionReason>};
  async function beginModelOperation(key:string,g:number,signal:AbortSignal,kind:ModelOperationKind):Promise<ModelAdmission>{
    check(signal);
    const admission=await options.accounting.recoveryAdmission?.(options.now(),true,key);
    if(admission&&!admission.allowed)return {denialReason:normalizeAdmissionReason(admission.reason??'unresolved_previous_call')};
    const view=options.accounting.forConversation(key);
    const id=(await view.reserve(admission?.kind??'ordinary',kind))??undefined;
    if(!id)return {view,denialReason:'local_policy'};
    if(!processIdentity||!view.bindInvocation||!view.updateInvocation)throw Error('SESSION_ACCOUNTING_OWNERSHIP');
    await view.bindInvocation(id,{admissionId:id,conversationKey:key,turnGeneration:g,ownerUuid:processOwnerUuid,providerKind:'subscription',
      phase:'bound',deadline:options.now()+120000,cleanupOutcome:'pending',purpose:kind,...processIdentity});
    return {view,id};
  }
  async function runCompaction(live:ReturnType<typeof createPersistentObserverSession>,signal:AbortSignal,key:string,g:number,onDispatch:()=>void):Promise<PersistentCompactionResult>{
    let view:SubscriptionAccounting|undefined,id:string|undefined,operationId:string|undefined,dispatched=false,settled=false,bound=false,settlementAttempted=false,receiptFailure=false;
    try{
      const prepared=await options.prepareSession(signal);check(signal);
      if(!processBinding||JSON.stringify(processBinding)!==JSON.stringify(prepared.binding))throw Error('SESSION_BINDING_CHANGED');
      const admission=await beginModelOperation(key,g,signal,'context_compression');
      if('denialReason' in admission){view=admission.view;throw Error(`COMPACTION_ADMISSION_DENIED:${admission.denialReason}`);}
      view=admission.view;id=admission.id;
      bound=true;
      operationId=randomUUID();
      try{await journal!.operationStarted({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,operationKind:'context_compression'});}
      catch(error){receiptFailure=true;throw error;}
      check(signal);await view.updateInvocation!(id,{phase:'dispatching'});check(signal);
      const persistEvidence=async(evidence:Parameters<NonNullable<Parameters<typeof live.compact>[1]>>[0])=>{
        try{
          if(evidence.kind==='snapshot')await journal!.usageSnapshot({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence,completenessReason:'compaction_observed'});
          else await journal!.usageGap({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence});
        }catch(error){receiptFailure=true;throw error;}
      };
      const result=await live.compact(signal,persistEvidence,()=>{dispatched=true;onDispatch();});
      try{await journal!.operationTerminal({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
        ...(result.turnId===undefined?{}:{turnId:result.turnId}),terminalState:'completed',usageCompleteness:result.usageCompleteness,operationKind:'context_compression'});}
      catch(error){receiptFailure=true;throw error;}
      await view.updateInvocation!(id,{phase:'settling',cleanupOutcome:'pending'});
      settlementAttempted=true;
      await view.settle(id,null,result.usageCompleteness==='missing'?'confirmed_compression_unknown':'safe_unknown');settled=true;
      return result;
    }catch(error){
      const sessionFailure=error as PersistentSessionError;
      if(operationId&&!receiptFailure){
        const typed=sessionFailure instanceof Error&&typeof sessionFailure.code==='string';
        const confirmed=typed&&sessionFailure.terminalConfirmed===true;
        const terminalStatus=typed?sessionFailure.terminalStatus:undefined;
        try{await journal!.operationTerminal({operationId,admissionId:id!,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
          ...(typed&&sessionFailure.turnId!==undefined?{turnId:sessionFailure.turnId}:{}),
          terminalState:!dispatched?'cancelled':!confirmed?'unconfirmed':terminalStatus==='interrupted'?'cancelled':'failed',
          usageCompleteness:!dispatched?'cancelled_before_dispatch':typed&&sessionFailure.code==='SESSION_TIMEOUT'?'timeout_unconfirmed':'protocol_failed',operationKind:'context_compression'});}
        catch{receiptFailure=true;}
      }
      let cleaned=false;try{await reset();cleaned=true;}catch{poisoned=true;}
      if(receiptFailure){if(id&&view&&bound)try{await view.updateInvocation?.(id,{phase:cleaned?'closed':'settling',cleanupOutcome:cleaned?'confirmed':'unconfirmed'});}catch{poisoned=true;}poisoned=true;throw error;}
      if(id&&view&&!settled){
        try{
          if(bound)await view.updateInvocation?.(id,{phase:cleaned?'closed':'settling',cleanupOutcome:cleaned?'confirmed':'unconfirmed'});
          if(settlementAttempted){poisoned=true;throw Error('COMPACTION_SETTLEMENT_UNCONFIRMED');}
          if(dispatched)await view.settle(id,null,cleaned?'safe_unknown':'unsafe_unknown');
          else await view.cancelBeforeDispatch(id);
        }catch{poisoned=true;throw error;}
      }
      throw error;
    }finally{
      await view?.releaseRecoveryAdmission?.().catch(()=>undefined);
      await options.accounting.releaseRecoveryAdmission?.(key).catch(()=>undefined);
      await view?.close().catch(()=>{poisoned=true;});
    }
  }
 function operation<T>(signal:AbortSignal,work:(combined:AbortSignal)=>Promise<T>):Promise<T>{
   const owned=new AbortController();controller=owned;
   const combined=AbortSignal.any([signal,owned.signal]);
   const p=work(combined).finally(()=>{if(pending===p)pending=undefined;if(controller===owned)controller=undefined;});pending=p;return p;
 }
 const worker:ObserverWorker={
   status:()=>({active:pending!==undefined,disabled,poisoned:poisoned||owner?.status().poisoned===true}),
   disable(){disabled=true;controller?.abort();owner?.disable();},
   close(){if(closing)return closing;worker.disable();closing=(async()=>{await pending?.catch(()=>undefined);await reset();})();return closing;},
   async release(){await pending?.catch(()=>undefined);if(session?.status().uncertain||owner?.status().closed)await reset();},
   prepareContext(input,history,signal,key,g){
     if(pending||!authorized())return history.snapshot.close().then(()=>{throw Error(`CONTEXT_UNAVAILABLE:${pending?'pending':'unauthorized'}`);});
     return operation(signal,async combined=>{
       try{
         bind(key,g);check(combined);
         const epoch=JSON.stringify([history.snapshot.identity,history.snapshot.sourceEpoch,history.snapshot.checkpoint?.fingerprint??null]);
         if(sourceEpoch!==undefined&&sourceEpoch!==epoch)await reset();
         sourceEpoch=epoch;
         const live=await ensure(combined);sourceEpoch=epoch;
         if(history.snapshot.checkpoint)await live.bootstrapCheckpoint(history.snapshot.checkpoint,combined);
          let count=0,sourceBytes=0,compactionCount=0,confirmedCompactionThroughOrdinal:number|null=null,lastCommittedOrdinal=-1;
          for await(const item of history.snapshot.records(combined)){
           check(combined);
           const {id:_id,turnId,sourceTurnId,actionId:_actionId,...data}=item.record;
           // Canonicalize redundant aliases only; distinct output and completion
           // evidence remain intact, and the source snapshot is never mutated.
           if(typeof data.text==='string'&&data.output===data.text)delete data.output;
           const turn=sourceTurnId??turnId;
            if(turn!==null&&turn!==undefined&&!turns.has(turn))turns.set(turn,turns.size);
            const text=JSON.stringify({sourceTurn:turn===null||turn===undefined?null:turns.get(turn),...data});
            const encodedSourceBytes=Buffer.byteLength(text,'utf8');
            if(budget!==undefined&&sourceBytes+encodedSourceBytes>budget.maxSourceBytes)throw Error('context_too_large:source_budget_exhausted');
            const compact=budget===undefined?undefined:async(compactSignal:AbortSignal,onDispatch?:()=>void)=>{
              if(compactionCount>=budget.maxCompactionOperations)throw Error('context_too_large:compaction_budget_exhausted');
              const checkpoint=lastCommittedOrdinal;
              const result=await runCompaction(live,compactSignal,key,g,()=>onDispatch?.());
              compactionCount+=1;confirmedCompactionThroughOrdinal=checkpoint>=0?checkpoint:null;
              return result;
            };
            await live.append([{ordinal:item.ordinal,text}],combined,compact);count++;sourceBytes+=encodedSourceBytes;lastCommittedOrdinal=item.ordinal;
          }
          check(combined);
         const importStatus=live.status();
         const representation={mode:history.snapshot.coverage.complete?'full' as const:'incomplete' as const,
            sourceComplete:history.snapshot.coverage.complete,originalRecords:input.messages.length,
            sessionCoveredRecords:count,compressedThroughOrdinal:null,sizing:'conservative' as const,
            importedThroughOrdinal:importStatus.cursor>=0?importStatus.cursor:null,
            importedRecords:importStatus.importedRecords,importedEncodedBytes:importStatus.importedEncodedBytes,
            sourceRepresentation:history.snapshot.checkpoint?'upstream_compacted' as const:'raw_history' as const,
            checkpointBootstrapped:importStatus.checkpointBootstrapped,
            checkpointEncodedBytes:importStatus.checkpointEncodedBytes,checkpointItemCount:importStatus.checkpointItemCount,
            confirmedCompactions:importStatus.compactions,
            confirmedCompactionThroughOrdinal:importStatus.confirmedCompactionThroughOrdinal,
            compressionState:importStatus.compactions>0?'confirmed' as const:'none' as const,
            residentBound:importStatus.residentBound,retainedSummaryReserveBytes:importStatus.retainedSummaryReserveBytes,
            ...(importStatus.contextCapacityBytes===null?{}:{contextCapacityBytes:importStatus.contextCapacityBytes}),
            budgetStatus:budget===undefined?'unconfigured' as const:'trusted' as const};
         return {input:{...input,representation,
           ...(input.observation?{observation:{...input.observation,historyComplete:representation.sourceComplete}}:{})},representation};
       }catch(e){await reset();throw e;}finally{await history.snapshot.close();}
     });
   },
   observe(input,signal,key,g=0,onStage){
     if(pending)return Promise.resolve(empty('busy'));
     if(!authorized())return Promise.resolve(empty('disabled'));
     const parsed=observerInputSchema.safeParse(input);if(!parsed.success)return Promise.resolve(empty('invalid_input'));
     try{bind(key,g);}catch{return Promise.resolve(empty('invalid_input'));}
     return operation(signal,async combined=>{
       let view:SubscriptionAccounting|undefined,id:string|undefined,operationId:string|undefined,dispatched=false,settled=false,bound=false,settlementAttempted=false,receiptFailure=false;
       try{
         reportObserverStage(onStage,'preparation');
         const live=await ensure(combined);check(combined);
         reportObserverStage(onStage,'admission');
          const admission=await beginModelOperation(key,g,combined,'eta');
          if('denialReason' in admission){view=admission.view;return {...empty('admission_denied'),admissionReason:admission.denialReason};}
          view=admission.view;id=admission.id;
          reportObserverStage(onStage,'reservation');check(combined);
          bound=true;
         operationId=randomUUID();
          try{await journal!.operationStarted({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,operationKind:'eta'});}
         catch(error){receiptFailure=true;throw error;}
         // Recheck trusted authorization at the irreversible request boundary.
         check(combined);await view.updateInvocation!(id,{phase:'dispatching'});check(combined);
         dispatched=true;reportObserverStage(onStage,'dispatch');
         const persistEvidence=async(evidence:Parameters<NonNullable<Parameters<typeof live.estimate>[2]>>[0])=>{
           try{
             if(evidence.kind==='snapshot')await journal!.usageSnapshot({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence,completenessReason:'observed'});
             else await journal!.usageGap({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence});
           }catch(error){receiptFailure=true;throw error;}
         };
         const result=await live.estimate(parsed.data,combined,persistEvidence);
         reportObserverStage(onStage,'provider_returned');
         if(operationId){
           try{
             await journal!.operationTerminal({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
                ...(result.turnId===undefined?{}:{turnId:result.turnId}),terminalState:result.cancelled?'cancelled':result.interpretation?'completed':'failed',usageCompleteness:result.usageCompleteness??'missing',operationKind:'eta'});
           }catch(error){receiptFailure=true;throw error;}
         }
         const accepted=authorized()&&!combined.aborted&&result.interpretation!==null;
          await view.updateInvocation!(id,{phase:'settling',cleanupOutcome:'pending'});
         reportObserverStage(onStage,'settlement');
         const accountedUsage=result.usage?{inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,cachedInputTokens:result.usage.cachedInputTokens}:null;
         settlementAttempted=true;
         await view.settle(id,accountedUsage,result.usage?(accepted?'known_success':'known_non_success'):'safe_unknown');settled=true;
         return {status:result.cancelled?'aborted':accepted?'interpreted':'process_error',interpretation:accepted?result.interpretation:null,usage:result.usage} as ObserverResult;
       }catch(error){
         const sessionFailure=error as PersistentSessionError;
         if(operationId&&!receiptFailure&&sessionFailure instanceof Error&&typeof sessionFailure.code==='string'&&
            (sessionFailure.code==='SESSION_TIMEOUT'||sessionFailure.code==='SESSION_PROTOCOL_FAILED')){
           try{await journal!.operationTerminal({operationId,admissionId:id!,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
              ...(sessionFailure.turnId===undefined?{}:{turnId:sessionFailure.turnId}),terminalState:!sessionFailure.terminalConfirmed?'unconfirmed':sessionFailure.terminalStatus==='completed'?'completed':sessionFailure.terminalStatus==='interrupted'?'cancelled':'failed',usageCompleteness:sessionFailure.code==='SESSION_TIMEOUT'?'timeout_unconfirmed':'protocol_failed',operationKind:'eta'});}
           catch{receiptFailure=true;}
         }
         let cleaned=false;try{await reset();cleaned=true;}catch{poisoned=true;}
         if(receiptFailure){
           if(id&&view&&bound)try{await view.updateInvocation?.(id,{phase:cleaned?'closed':'settling',cleanupOutcome:cleaned?'confirmed':'unconfirmed'});}catch{poisoned=true;}
           poisoned=true;return empty('accounting_error');
         }
         if(sessionFailure instanceof Error&&typeof sessionFailure.code==='string'&&sessionFailure.code.startsWith('SESSION_')){
           if(id&&view&&bound)try{await view.updateInvocation?.(id,{phase:cleaned?'closed':'settling',cleanupOutcome:cleaned?'confirmed':'unconfirmed'});}catch{poisoned=true;}
           return empty('process_error');
         }
         if(id&&view&&!settled){
           try{
             if(bound)await view.updateInvocation?.(id,{phase:cleaned?'closed':'settling',cleanupOutcome:cleaned?'confirmed':'unconfirmed'});
             if(settlementAttempted){poisoned=true;return empty('accounting_error');}
             if(dispatched)await view.settle(id,null,cleaned?'safe_unknown':'unsafe_unknown');
             else await view.cancelBeforeDispatch(id);
           }catch{poisoned=true;return empty('accounting_error');}
         }
         return empty(combined.aborted?'aborted':'process_error');
       }finally{
         await view?.releaseRecoveryAdmission?.().catch(()=>undefined);
         await options.accounting.releaseRecoveryAdmission?.(key).catch(()=>undefined);
         await view?.close().catch(()=>{poisoned=true;});
         reportObserverStage(onStage,'finished');
       }
     });
   },
 };
 return worker;
}
