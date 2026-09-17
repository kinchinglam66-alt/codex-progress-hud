import {randomUUID} from 'node:crypto';
import {observerInputSchema,isInferenceEligible} from './observer-contract.js';
import type {ObserverInput} from './observer-contract.js';
import type {HistorySnapshot} from '../observer/history-snapshot.js';
import type {ObserverWorker} from './observer-scheduler.js';
import type {ObserverResult} from './observer-provider.js';
import {reportObserverStage} from './observer-provider.js';
import type {ReleaseAccountingOwner} from './release-accounting.js';
import type {SubscriptionAccounting} from './subscription-accounting.js';
import type {Invocation} from './owned-process.js';
import {createObserverSessionProcess} from './observer-session-process.js';
import {createPersistentObserverSession, type PersistentCompactionResult, type PersistentSessionError, type PersistentContextCapacityPolicy,type PersistentSourcePart,type PersistentSourceRecord} from './observer-persistent-session.js';
import {resolveImageAttachment} from '../observer/image-attachment.js';
import {createPersistentReceiptJournal,preparationErrorCode,type PersistentPreparationStage,type PersistentReceiptBinding,type PersistentReceiptJournal} from './observer-persistent-receipt.js';
import {normalizeAdmissionReason} from '../core/observer-diagnostics.js';
import type {NativeSourceDestination,OpenNativeSourceResult,NativeTurnSource} from '../observer/native-source-request.js';
import {createNativeTurnBaseOwner} from './native-turn-base.js';
import {createNativeTurnTiming,type NativeTurnTiming} from './native-turn-timing.js';
import type {SessionAccountReuse,SessionAccountProof} from './session-account-reuse.js';
import type {SessionPreparationPolicy} from './account-attestation-cache.js';
import {nativeRetentionValid,nativeProcessRetentionValid,type NativeRetentionPermit,type NativeRetentionState,type NativeLifecycleDiagnostic,type NativeRetirementReason} from './native-owner-retention.js';

export interface NativeWorkerResources {
 destination(signal:AbortSignal,role?:'request'|'base'):Promise<NativeSourceDestination>;
 /** No copied snapshot; requires an acknowledged base owned by this generation. */
 claimChild?(source:{baseThreadId:string;rootSourceThreadId:string},invocation:Invocation,process:{pid:number;creationIdentity:string},signal:AbortSignal):Promise<NativeWorkerClaim>;
 usage?():Promise<{requests:number;knownBytes:number}>;
 /** Also owns resources created before source acquisition/fork can succeed. */
 release?():Promise<void>;
 /** Custody intent must be durable before this returns and before fork RPC. */
 claim(source:OpenNativeSourceResult,invocation:Invocation,process:{pid:number;creationIdentity:string},signal:AbortSignal):Promise<NativeWorkerClaim>;
}
export interface NativeWorkerClaim {tag:string;recordFork(threadId:string):Promise<void>;afterProcessClosed():Promise<void>}

export interface PersistentWorkerOptions {
 /** Trusted host assets, not user/source-provided instructions. */
 nativeInstructions?:string;
 /** Optional monotonic evaluation instrumentation; never an authority gate. */
 onContextPhase?:(phase:'accountProcessMs'|'forkImportMs'|'compactionMs'|'inferenceMs'|'deliveryMs')=>void;
 nativeContext?:NativeWorkerResources;
 /** Candidate-only until completed-turn compatibility and performance gates pass. */
 completedTurnContext?:boolean;
 reuseNativeTurnSession?:boolean;
 /** Opt-in experiment on the completed-turn route only; installed default stays unchanged. */
 inlineCurrentTurnSupplement?:boolean;
 onNativeTurnTiming?:(event:Readonly<NativeTurnTiming>)=>void;
 nativeRequestByteLimit?:number;
 monotonicNow?:()=>number;
 scheduleIdle?:(callback:()=>void,delayMs:number)=>()=>void;
 accounting:ReleaseAccountingOwner;prepareSession:(signal:AbortSignal,policy?:SessionPreparationPolicy)=>Promise<{invocation:Invocation;binding:PersistentReceiptBinding;reuse?:SessionAccountReuse;validateAcceptance?:(signal:AbortSignal)=>Promise<boolean>}>;
 invalidateSessionReuse?:()=>void;
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
 if(options.reuseNativeTurnSession&&(!options.completedTurnContext||!options.nativeContext))throw Error('NATIVE_TURN_REUSE_OPTIONS_INVALID');
 const timing=createNativeTurnTiming(()=>performance.now(),options.onNativeTurnTiming);
 const phaseListeners=new Set<Parameters<NonNullable<ObserverWorker['subscribeContextPhase']>>[0]>();
 const phase=(value:Parameters<NonNullable<PersistentWorkerOptions['onContextPhase']>>[0])=>{
  try{options.onContextPhase?.(value);}catch{/* Diagnostics cannot cancel or authorize a call. */}
  for(const listener of phaseListeners)try{listener(value);}catch{/* Passive diagnostics. */}
 };
 let disabled=false,poisoned=false,pending:Promise<unknown>|undefined,controller:AbortController|undefined;
 let owner:ReturnType<typeof createObserverSessionProcess>|undefined;
 let processIdentity:{pid:number;creationIdentity:string}|undefined;
 let processBinding:PersistentReceiptBinding|undefined;
 let admittedModelWindow=false,unexpectedRecorded=false,unexpectedWrite:Promise<void>|undefined;
 let validateAcceptance:((signal:AbortSignal)=>Promise<boolean>)|undefined;
 let session:ReturnType<typeof createPersistentObserverSession>|undefined;
 let processRpc:Awaited<ReturnType<ReturnType<typeof createObserverSessionProcess>['start']>>['rpc']|undefined;
 let nativeCleanup:(()=>Promise<void>)|undefined;
 let nativeSnapshot:OpenNativeSourceResult['snapshot']|undefined;
 const nativeCleanups:Array<()=>Promise<void>>=[],nativeSnapshots:Array<OpenNativeSourceResult['snapshot']>=[];
 let nativeGenerationSource:string|undefined,nativeRequestAcquired=false,nativeTerminal=false;
 let nativeBase=createNativeTurnBaseOwner(),nativeBaseRoot:string|undefined,nativeTurnPrepared=false;
 let nativeProcessSource:string|undefined;
 let nativeSessionRevision:number|undefined;
 // First-turn sessions are ephemeral: process custody is journalled, no raw
 // snapshot/fork manifest exists. Count their requests and imported byte bounds.
 let ephemeralRequests=0,ephemeralImportedBytes=0;
 let nativeTurnValidation:((signal:AbortSignal)=>Promise<void>)|undefined;
 let nativeOwnerState:NativeRetentionState|null=null,exitRecorded=false;
 let nativeResourcesOpen=false;
 let nativeStarts=0,nativeReuses=0,resourceRequests:number|null=0,resourceBytes:number|null=0;
 let retirementReason:NativeRetirementReason|null=null,resourceFailure:NativeRetirementReason='resource_unknown';
 let retentionState:NativeRetentionState|null=null,retentionPermit:NativeRetentionPermit|null=null;
 let cancelIdle:(()=>void)|undefined,idleFence=0,lastMonotonic=-1;
 const monotonic=()=>{const value=(options.monotonicNow??(()=>performance.now()))();
  if(!Number.isFinite(value)||value<0||value<lastMonotonic)throw Error('NATIVE_RETENTION_CLOCK');
  lastMonotonic=value;return value;};
 const revokeIdle=()=>{retentionPermit=null;idleFence++;cancelIdle?.();cancelIdle=undefined;};
 let sourceKey:string|undefined,sourceEpoch:string|undefined,generation=-1;
 type PreparedOwner={ownerUuid:string;generation:number;key:string;epoch:string|undefined;revision:number;
  pid:number;creationIdentity:string;binding:string;reuse?:SessionAccountReuse;validateSource?:(signal:AbortSignal)=>Promise<void>};
 const preparedOwners=new WeakMap<object,PreparedOwner>();
 let requestRevision=0,preparedReuse:SessionAccountReuse|undefined,unsubscribeAccount:(()=>void)|undefined;
 const invalidateReuse=()=>{preparedReuse?.invalidate();preparedReuse=undefined;};
 const matchesOwner=(prepared:PreparedOwner)=>prepared.ownerUuid===processOwnerUuid&&prepared.generation===generation&&
  prepared.key===sourceKey&&prepared.epoch===sourceEpoch&&prepared.revision===requestRevision&&
  prepared.pid===processIdentity?.pid&&prepared.creationIdentity===processIdentity?.creationIdentity&&
  prepared.binding===JSON.stringify(processBinding)&&owner?.status().alive===true&&owner.status().disabled===false&&
  owner.status().poisoned===false&&!session?.status().uncertain;
 const rememberPrepared=(input:object,key:string,g:number)=>{
  if(!processIdentity||!processBinding)throw Error('SOURCE_PREPARATION_STALE');
  preparedOwners.set(input,{ownerUuid:processOwnerUuid,generation:g,key,epoch:sourceEpoch,revision:requestRevision,
   ...processIdentity,binding:JSON.stringify(processBinding),...(preparedReuse?{reuse:preparedReuse}:{}),...(nativeTurnValidation?{validateSource:nativeTurnValidation}:{})});
 };
 // Local-only prepared attachment manifest: no bytes, paths in receipts, or remote serialization.
 let attachments:Array<{path:string;digest:string|null;maxEncodedBytes:number}>=[];
 async function attachmentsUnchanged(signal:AbortSignal):Promise<boolean>{
   for(const attachment of attachments){
     try{
       const current=await resolveImageAttachment({type:'local_image',path:attachment.path},{signal,maxEncodedBytes:attachment.maxEncodedBytes});
       if((current.state==='missing'?null:current.digest)!==attachment.digest)return false;
     }catch{signal.throwIfAborted();return false;}
   }
   return true;
 }
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
 let closing:Promise<void>|undefined,releasing:Promise<void>|undefined;
 const turns=new Map<string,number>();
 const authorized=()=>{try{return !disabled&&!poisoned&&options.authorize()===true;}catch{return false;}};
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!authorized())throw Error('OBSERVER_NOT_AUTHORIZED');};
 const bind=(key:string,g:number)=>{
   if(sourceKey!==undefined&&sourceKey!==key)throw Error('SOURCE_MISMATCH');
   if(!Number.isSafeInteger(g)||g<0||g<generation)throw Error('SOURCE_GENERATION');
   sourceKey=key;generation=g;
 };
 async function reset(reason:NativeRetirementReason='request_end'){
   if(options.nativeContext&&(nativeResourcesOpen||owner))retirementReason=reason;
   revokeIdle();nativeRequestAcquired=false;nativeTerminal=false;
   invalidateReuse();unsubscribeAccount?.();unsubscribeAccount=undefined;validateAcceptance=undefined;
   if(owner){try{await owner.close();}catch{poisoned=true;options.invalidateSessionReuse?.();throw Error('SESSION_PROCESS_CLOSE_UNCONFIRMED');}
     await unexpectedWrite;
     if(unexpectedRecorded&&processIdentity){
       if(!options.accounting.confirmUnexpectedExit)throw Error('UNEXPECTED_WORK_ACCOUNTING_UNAVAILABLE');
       await options.accounting.confirmUnexpectedExit({ownerUuid:processOwnerUuid,...processIdentity});
     }
     if(processIdentity&&!exitRecorded){await journal!.processExit({ownerUuid:processOwnerUuid,...(sourceKey===undefined?{}:{sourceKey}),sourceEpoch:sourceEpoch??null,processExitState:'closed',at:options.now()});exitRecorded=true;}
   }
   // Keep ownership references on cleanup failure for a later safe recovery.
   while(nativeCleanups.length){await nativeCleanups[0]!();nativeCleanups.shift();}
   nativeCleanup=undefined;
   while(nativeSnapshots.length){await nativeSnapshots[0]!.close();nativeSnapshots.shift();}
   nativeSnapshot=undefined;
   await options.nativeContext?.release?.();
   await nativeBase.close();nativeBase=createNativeTurnBaseOwner();nativeBaseRoot=undefined;nativeTurnPrepared=false;nativeTurnValidation=undefined;
   ephemeralRequests=0;ephemeralImportedBytes=0;
   owner=undefined;processRpc=undefined;session=undefined;nativeSessionRevision=undefined;processIdentity=undefined;processBinding=undefined;sourceEpoch=undefined;turns.clear();attachments=[];
   nativeGenerationSource=undefined;nativeProcessSource=undefined;nativeOwnerState=null;exitRecorded=false;nativeResourcesOpen=false;
   resourceRequests=0;resourceBytes=0;
   processOwnerUuid=randomUUID();
   admittedModelWindow=false;unexpectedRecorded=false;unexpectedWrite=undefined;
 }
 async function ensure(signal:AbortSignal,nativeSource?:OpenNativeSourceResult,captureReuse=false,nativeTurn?:NativeTurnSource,historyFallback=false){
   check(signal);
   phase('accountProcessMs');
   invalidateReuse();
   // Only normal context preparation opts into short-lived account evidence.
   // Observe fallback always performs a full check; request authority is separate.
   const prepare=()=>options.prepareSession(signal,{accountCache:captureReuse?'allow':'bypass'});
   const prepared=await (nativeTurn?timing.measure('session_preparation',prepare):prepare());check(signal);
   if(owner&&(owner.status().closed||session?.status().uncertain))await reset('process_unhealthy');
   if(processBinding&&JSON.stringify(processBinding)!==JSON.stringify(prepared.binding)){
    if(nativeSource||nativeTurn)throw Error('SESSION_BINDING_CHANGED');
    await reset('binding_changed');
   }
   validateAcceptance=prepared.validateAcceptance;
   if(session&&!nativeSource&&!nativeTurn&&!historyFallback){if(captureReuse)preparedReuse=prepared.reuse;else prepared.reuse?.invalidate();phase('forkImportMs');return session;}
   if(options.nativeContext&&!nativeSource&&!nativeTurn&&!historyFallback)throw Error('NATIVE_CONTEXT_NOT_PREPARED');
   if(nativeTurn){
    nativeResourcesOpen=true;
    const processSource=JSON.stringify([nativeTurn.identity,nativeTurn.sourceEpoch]);
    if(nativeProcessSource!==undefined&&nativeProcessSource!==processSource)throw Error('NATIVE_SOURCE_GENERATION_CHANGED');
    const source=JSON.stringify([nativeTurn.identity,nativeTurn.currentTurnId,nativeTurn.sourceEpoch]);
    if(nativeGenerationSource!==undefined&&nativeGenerationSource!==source){
     // Runtime custody survives the turn; historical bases and ETA sessions do
     // not. Keep every old lease until confirmed process exit, counting all of
     // them toward the existing per-process bounds.
     if(nativeProcessSource===undefined||!retentionState?.running||!nativeOwnerState||
       retentionState.generation<=nativeOwnerState.generation)throw Error('NATIVE_SOURCE_GENERATION_CHANGED');
     await nativeBase.close();nativeBase=createNativeTurnBaseOwner();nativeBaseRoot=undefined;
     session=undefined;nativeSessionRevision=undefined;nativeTurnValidation=undefined;turns.clear();attachments=[];
    }
    nativeProcessSource=processSource;nativeGenerationSource=source;nativeOwnerState=retentionState;
    sourceEpoch=JSON.stringify([nativeTurn.sourceEpoch,nativeTurn.revision]);
    if(options.reuseNativeTurnSession&&session&&nativeSessionRevision!==undefined){
     if(!Number.isSafeInteger(nativeTurn.revision)||nativeTurn.revision<nativeSessionRevision)throw Error('NATIVE_SOURCE_REVISION_REGRESSED');
     await timing.measure('base_reuse_validation',()=>nativeBase.acquire(nativeTurn,signal,async()=>{throw Error('NATIVE_BASE_REUSE_MISSING');}));check(signal);
     if(captureReuse)preparedReuse=prepared.reuse;else prepared.reuse?.invalidate();
     phase('forkImportMs');return session;
    }
   }
   if(nativeSource){
    nativeResourcesOpen=true;
    const source=JSON.stringify([nativeSource.snapshot.sourceThreadId,nativeSource.currentTurnId,nativeSource.snapshot.sourceEpoch]);
    if(nativeGenerationSource!==undefined&&nativeGenerationSource!==source)throw Error('NATIVE_SOURCE_GENERATION_CHANGED');
    nativeGenerationSource=source;nativeSnapshot=nativeSource.snapshot;nativeSnapshots.push(nativeSnapshot);
    nativeOwnerState??=retentionState;
    sourceEpoch=JSON.stringify([nativeSource.snapshot.sourceEpoch,nativeSource.snapshot.revision]);
   }
   if(!owner){
    owner=(options.processFactory??createObserverSessionProcess)();
    const opened=await owner.start(prepared.invocation);processIdentity={pid:opened.pid,creationIdentity:opened.creationIdentity};processBinding=prepared.binding;processRpc=opened.rpc;check(signal);
    if(options.nativeContext)nativeStarts++;
    unsubscribeAccount=opened.rpc.subscribe(notification=>{
     if(notification.method==='account/updated'){
      invalidateReuse();options.invalidateSessionReuse?.();
      if(options.nativeContext){retentionState=null;retireNative('account_changed');}
     }
     if(options.nativeContext&&!admittedModelWindow&&
       ['turn/started','turn/completed','item/started','item/completed','thread/tokenUsage/updated'].includes(notification.method)&&!unexpectedRecorded){
       unexpectedRecorded=true;poisoned=true;controller?.abort();owner?.disable();
       const incident={ownerUuid:processOwnerUuid,conversationKey:sourceKey??'unknown',generation,
         pid:opened.pid,creationIdentity:opened.creationIdentity,at:options.now(),
         reason:notification.method as import('./unexpected-model-work.js').UnexpectedModelWork['reason']};
       unexpectedWrite=Promise.resolve().then(async()=>{
         if(!options.accounting.recordUnexpectedOperation)throw Error('UNEXPECTED_WORK_ACCOUNTING_UNAVAILABLE');
         await options.accounting.recordUnexpectedOperation(incident);
       });
       // Keep the original rejected promise for reset to join and fail closed.
       void unexpectedWrite.catch(()=>undefined);
     }
    });
    await journal!.ownerStarted({ownerUuid:processOwnerUuid,sourceKey:sourceKey??'unknown',sourceEpoch:sourceEpoch??null,pid:opened.pid,creationIdentity:opened.creationIdentity,binding:prepared.binding});
    await opened.rpc.call('initialize',{clientInfo:{name:'codex_progress_hud',version:'0.2.1'},capabilities:{experimentalApi:true,requestAttestation:false}});
    opened.rpc.notify('initialized',{});
   }
   if(!processRpc||!processIdentity)throw Error('SESSION_PROCESS_IDENTITY');
   if(captureReuse)preparedReuse=prepared.reuse;else prepared.reuse?.invalidate();
    const newSession=()=>createPersistentObserverSession(processRpc!,{cwd:prepared.invocation.cwd,outputSchema:options.outputSchema,now:options.now,
      runtimeManagedContext:nativeTurn!==undefined,
      retainSubmittedSupplement:!!(nativeTurn&&options.reuseNativeTurnSession&&options.inlineCurrentTurnSupplement),
      ...(options.nativeInstructions===undefined?{}:{nativeInstructions:options.nativeInstructions}),
      ...(options.nativeRequestByteLimit===undefined?{}:{nativeRequestByteLimit:options.nativeRequestByteLimit}),
      ...(options.sessionTimeoutMs===undefined?{}:{timeoutMs:options.sessionTimeoutMs}),
      ...(options.bootstrapBatchByteCapacity===undefined?{}:{bootstrapBatchByteCapacity:options.bootstrapBatchByteCapacity}),
       ...(options.retainedSummaryByteReserve===undefined?{}:{retainedSummaryByteReserve:options.retainedSummaryByteReserve}),
       ...(budget===undefined?{}:{contextCapacityPolicy:{trusted:true,contextCapacityBytes:budget.contextCapacityBytes,retainedSummaryReserveBytes:budget.retainedSummaryReserveBytes} satisfies PersistentContextCapacityPolicy})});
    session=newSession();
    phase('forkImportMs');
    if(nativeTurn){
     const resources=options.nativeContext;if(!resources?.claimChild)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
     const claimChild=resources.claimChild.bind(resources),childSession=session;
     const measuredSource={...nativeTurn,validate:(s:AbortSignal)=>timing.measure('source_validation',()=>nativeTurn.validate(s))};
     const baseState=nativeTurn.boundary.completed===null?'empty':nativeBaseRoot?'warm':'cold';
     const base=await timing.measure('base_acquire',()=>nativeBase.acquire(measuredSource,signal,async()=>{
      const destination=await timing.measure('base_storage',()=>resources.destination(signal,'base'),'cold');check(signal);
      const snapshot=await timing.measure('base_copy',()=>nativeTurn.openBase(destination,signal),'cold');
      if(!snapshot)throw Error('NATIVE_BASE_SNAPSHOT_MISSING');
      nativeSnapshots.push(snapshot);
      if(!snapshot.sourceTurnId||snapshot.sourceTurnId!==nativeTurn.boundary.completed?.turnId||snapshot.sourceEpoch!==nativeTurn.sourceEpoch)throw Error('NATIVE_BASE_SOURCE_MISMATCH');
      const lastTurnId=snapshot.sourceTurnId;
      return timing.measure('base_fork',async()=>{
      const custody=await resources.claim({snapshot,currentTurnId:nativeTurn.currentTurnId},prepared.invocation,processIdentity!,signal);
      nativeCleanups.push(custody.afterProcessClosed);check(signal);
      const baseSession=newSession();
      await baseSession.startNative({kind:'snapshot',sourceThreadId:snapshot.sourceThreadId,path:snapshot.path,lastTurnId,custodyTag:custody.tag},signal,custody.recordFork);
      nativeBaseRoot=snapshot.sourceThreadId;
      return baseSession.status().threadId!;
      },'cold');
     }),baseState);
     await measuredSource.validate(signal);check(signal);
     await timing.measure('child_fork',async()=>{
     if(base.threadId===null){await childSession.start();ephemeralRequests++;}
     else{
      if(!nativeBaseRoot||!base.lastTurnId)throw Error('NATIVE_BASE_SOURCE_MISMATCH');
      const custody=await claimChild({baseThreadId:base.threadId,rootSourceThreadId:nativeBaseRoot},prepared.invocation,processIdentity!,signal);
      nativeCleanups.push(custody.afterProcessClosed);check(signal);
      await childSession.startNative({kind:'owned-base',sourceThreadId:base.threadId,rootSourceThreadId:nativeBaseRoot,lastTurnId:base.lastTurnId,custodyTag:custody.tag},signal,custody.recordFork);
     }
     },baseState);
     turns.clear();attachments=[];
    }else if(nativeSource){
      if(!options.nativeContext)throw Error('NATIVE_CONTEXT_UNAVAILABLE');
      const custody=await options.nativeContext.claim(nativeSource,prepared.invocation,processIdentity,signal);
      nativeCleanup=custody.afterProcessClosed;
      nativeCleanups.push(nativeCleanup);
      check(signal);
      await session.startNative({sourceThreadId:nativeSource.snapshot.sourceThreadId,path:nativeSource.snapshot.path,custodyTag:custody.tag},signal,custody.recordFork);
    }else {await session.start();if(historyFallback)ephemeralRequests++;}
    check(signal);return session;
  }
  async function importHistory(input:ObserverInput,history:{snapshot:HistorySnapshot},live:ReturnType<typeof createPersistentObserverSession>,combined:AbortSignal,key:string,g:number,stage:(value:PersistentPreparationStage)=>void,batchCompleteRecords=false){
         if(history.snapshot.checkpoint){stage('checkpoint_import');await live.bootstrapCheckpoint(history.snapshot.checkpoint,combined);}
         stage('history_import');
          let count=0,sourceBytes=0,compactionCount=0,missingImages=0;
          const manifest:typeof attachments=[];let manifestBytes=0;
          const compact=budget===undefined?undefined:async(compactSignal:AbortSignal,onDispatch?:()=>void)=>{
           if(compactionCount>=budget.maxCompactionOperations)throw Error('context_too_large:compaction_budget_exhausted');
           stage('context_compression');
           await nativeTurnValidation?.(compactSignal);
           const result=await runCompaction(live,compactSignal,key,g,()=>onDispatch?.());
           stage('history_import');compactionCount++;return result;
          };
          let buffered:PersistentSourceRecord[]=[],bufferedBytes=0;
          const completeSnapshot=batchCompleteRecords&&options.reuseNativeTurnSession?[] as PersistentSourceRecord[]:undefined;
          const flush=async()=>{
           if(!buffered.length)return;
           check(combined);
           if(!(batchCompleteRecords&&options.inlineCurrentTurnSupplement&&live.stageSupplement(buffered,combined))){
            await live.flushSupplement(combined,compact);await live.append(buffered,combined,compact);
           }
           buffered=[];bufferedBytes=0;
          };
          for await(const item of history.snapshot.records(combined)){
           check(combined);
           const {id:_id,turnId,sourceTurnId,actionId:_actionId,contentParts,...data}=item.record;
           let content:PersistentSourcePart[]|undefined;
           if(contentParts!==undefined){
             content=[];
             const maxEncodedBytes=budget?Math.min(budget.maxSourceBytes,budget.contextCapacityBytes-budget.retainedSummaryReserveBytes):options.bootstrapBatchByteCapacity??65536;
             for(const part of contentParts){
               check(combined);
               if(part.type==='text'){content.push({type:'input_text',text:part.text});continue;}
               if(part.type==='local_image'&&item.record.kind!=='user')throw Error('IMAGE_PATH_REJECTED');
               const image=await resolveImageAttachment(part,{signal:combined,maxEncodedBytes});
               if(part.type==='local_image'){
                 manifestBytes+=Buffer.byteLength(part.path)+128;
                 if(manifestBytes>(budget?.maxSourceBytes??16*1024*1024))throw Error('context_too_large:attachment_manifest');
                 manifest.push({path:part.path,digest:image.state==='missing'?null:image.digest,maxEncodedBytes});
               }
               if(image.state==='missing'){
                 missingImages++;
                 content.push({type:'input_text',text:'[Historical attachment missing: image content unavailable. Do not infer its visual contents.]'});
                 continue;
               }
               content.push({type:'input_image',image_url:image.imageUrl});
             }
             delete data.text;
           }
           // Canonicalize redundant aliases only; distinct output and completion
           // evidence remain intact, and the source snapshot is never mutated.
           if(typeof data.text==='string'&&data.output===data.text)delete data.output;
           const turn=sourceTurnId??turnId;
            if(turn!==null&&turn!==undefined&&!turns.has(turn))turns.set(turn,turns.size);
            const text=JSON.stringify({sourceTurn:turn===null||turn===undefined?null:turns.get(turn),...data});
            const encodedSourceBytes=Buffer.byteLength(text,'utf8')+(content===undefined?0:Buffer.byteLength(JSON.stringify(content),'utf8'));
            if(budget!==undefined&&sourceBytes+encodedSourceBytes>budget.maxSourceBytes)throw Error('context_too_large:source_budget_exhausted');
            const record={ordinal:item.ordinal,text,...(content===undefined?{}:{content})};
            if(completeSnapshot){
             if(sourceBytes+encodedSourceBytes+64*(count+1)>(options.nativeRequestByteLimit??16*1024*1024))throw Error('NATIVE_REQUEST_TOO_LARGE');
             completeSnapshot.push(record);
            }else if(batchCompleteRecords&&content===undefined&&encodedSourceBytes<=16384){
             if(buffered.length>=32||bufferedBytes+encodedSourceBytes>16384)await flush();
             buffered.push(record);bufferedBytes+=encodedSourceBytes;
            }else{await flush();await live.flushSupplement(combined,compact);await live.append([record],combined,compact);}
            count++;sourceBytes+=encodedSourceBytes;
          }
          await flush();
          if(completeSnapshot){
           if(!history.snapshot.coverage.complete||history.snapshot.coverage.gaps.length||missingImages)throw Error('SOURCE_SNAPSHOT_INCOMPLETE');
           if(!(options.inlineCurrentTurnSupplement&&live.stageSupplement(completeSnapshot,combined)))
            await live.appendSnapshot(completeSnapshot,combined,compact);
          }
          check(combined);
         attachments=manifest;
         const importStatus=live.status();
         const sourceComplete=history.snapshot.coverage.complete&&missingImages===0;
         const sourceGaps=[...history.snapshot.coverage.gaps,...(missingImages?['missing_image' as const]:[])];
         const representation={mode:sourceComplete?'full' as const:'incomplete' as const,
            sourceComplete,missingImages,sourceGaps,inferenceEligible:history.snapshot.coverage.complete&&history.snapshot.coverage.gaps.length===0,originalRecords:input.messages.length,
            sessionCoveredRecords:count,compressedThroughOrdinal:null,sizing:'conservative' as const,
            importedThroughOrdinal:importStatus.cursor>=0?importStatus.cursor:null,
            importedRecords:importStatus.importedRecords,importedEncodedBytes:importStatus.importedEncodedBytes,
            ...(batchCompleteRecords&&options.reuseNativeTurnSession?{acceptedThroughOrdinal:importStatus.acceptedThroughOrdinal}:{}),
            ...(batchCompleteRecords&&options.inlineCurrentTurnSupplement?{stagedRecords:importStatus.stagedRecords,
              stagedEncodedBytes:importStatus.stagedEncodedBytes,stagedThroughOrdinal:importStatus.stagedThroughOrdinal}:{}),
            sourceRepresentation:history.snapshot.checkpoint?'upstream_compacted' as const:'raw_history' as const,
            checkpointBootstrapped:importStatus.checkpointBootstrapped,
            checkpointEncodedBytes:importStatus.checkpointEncodedBytes,checkpointItemCount:importStatus.checkpointItemCount,
            confirmedCompactions:importStatus.compactions,
            confirmedCompactionThroughOrdinal:importStatus.confirmedCompactionThroughOrdinal,
            compressionState:importStatus.compactions>0?'confirmed' as const:'none' as const,
            residentBound:importStatus.residentBound,retainedSummaryReserveBytes:importStatus.retainedSummaryReserveBytes,
            ...(importStatus.contextCapacityBytes===null?{}:{contextCapacityBytes:importStatus.contextCapacityBytes}),
            budgetStatus:budget===undefined?'unconfigured' as const:'trusted' as const};
         const preparedInput={...input,imageContextPending:false,representation,
           ...(input.observation?{observation:{...input.observation,historyComplete:representation.sourceComplete}}:{})};
         return {input:preparedInput,representation};
  }
  async function resourcesReusable(maxRequests=2):Promise<boolean>{
   resourceFailure='resource_unknown';
   if(!options.nativeContext?.usage){resourceRequests=null;resourceBytes=null;return false;}
   try{const measured=await options.nativeContext.usage();
    if(!Number.isSafeInteger(measured.requests)||measured.requests<0||!Number.isSafeInteger(measured.knownBytes)||measured.knownBytes<0)throw Error('NATIVE_RESOURCE_USAGE_INVALID');
    const usage={requests:measured.requests+ephemeralRequests,knownBytes:measured.knownBytes+ephemeralImportedBytes};
    if(!Number.isSafeInteger(usage.requests)||usage.requests<1||!Number.isSafeInteger(usage.knownBytes)||usage.knownBytes<0){resourceRequests=null;resourceBytes=null;return false;}
    resourceRequests=usage.requests;resourceBytes=usage.knownBytes;resourceFailure='resource_limit';
    return usage.requests<=maxRequests&&usage.knownBytes<64*1024*1024;
   }catch{resourceRequests=null;resourceBytes=null;return false;}
  }
  /** Synchronous fence first; work and cleanup are then serialized with the current operation. */
  function retireNative(reason:NativeRetirementReason='state_revoked'):Promise<void>{
   revokeIdle();controller?.abort();
   if(releasing)return releasing;
   const cleanup=(async()=>{await pending?.catch(()=>undefined);await reset(reason);})();
   releasing=cleanup.finally(()=>{releasing=undefined;});
   void releasing.catch(()=>{poisoned=true;});
   return releasing;
  }
  async function acquireNative():Promise<void>{
   if(nativeRequestAcquired)return;
   if(owner){
    let valid=false,reason:NativeRetirementReason='permit_invalid';try{const now=monotonic();valid=(nativeProcessSource!==undefined?nativeProcessRetentionValid:nativeRetentionValid)(retentionPermit,retentionState,now)&&authorized();if(retentionPermit&&now>=retentionPermit.deadlineMs)reason='idle_expired';}catch{reason='clock_invalid';}
    if(!valid)await reset(reason);
    else if(!await resourcesReusable())await reset(resourceFailure);
    else nativeReuses++;
   }
   revokeIdle();nativeRequestAcquired=true;nativeTerminal=false;
  }
  function armIdle(permit:NativeRetentionPermit):boolean{
   retentionPermit=Object.freeze({...permit});const fence=++idleFence;
   const permitCopy=retentionPermit;
   const setTimer=(delay:number)=>{
    cancelIdle=options.scheduleIdle?options.scheduleIdle(schedule,delay):(()=>{
     const timer=setTimeout(schedule,delay);timer.unref?.();return()=>clearTimeout(timer);
    })();
   };
   const schedule=()=>{
    if(fence!==idleFence||retentionPermit!==permitCopy)return;
    let delay=0;try{delay=permitCopy.deadlineMs-monotonic();}catch{void retireNative('clock_invalid');return;}
    if(delay<=0){void retireNative('idle_expired');return;}
    try{setTimer(delay);}catch{void retireNative('clock_invalid');}
   };
   // During release, retirement would join this same release promise. Tell
   // its caller to reset directly if the initial arm loses the time window.
   try{const delay=permitCopy.deadlineMs-monotonic();if(delay>0){setTimer(delay);return true;}}catch{}
   revokeIdle();return false;
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
    invalidateReuse();
    let view:SubscriptionAccounting|undefined,id:string|undefined,operationId:string|undefined,dispatched=false,settled=false,bound=false,settlementAttempted=false,receiptFailure=false;
    try{
      phase('accountProcessMs');
      const prepared=await options.prepareSession(signal,{accountCache:'bypass'});check(signal);
      prepared.reuse?.invalidate();
      if(!processBinding||JSON.stringify(processBinding)!==JSON.stringify(prepared.binding))throw Error('SESSION_BINDING_CHANGED');
      const admission=await beginModelOperation(key,g,signal,'context_compression');
      if('denialReason' in admission){view=admission.view;throw Error(`COMPACTION_ADMISSION_DENIED:${admission.denialReason}`);}
      view=admission.view;id=admission.id;
      bound=true;
      operationId=randomUUID();
      try{await journal!.operationStarted({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,operationKind:'context_compression'});}
      catch(error){receiptFailure=true;throw error;}
      check(signal);await view.updateInvocation!(id,{phase:'dispatching'});check(signal);
      await nativeTurnValidation?.(signal);check(signal);
      const persistEvidence=async(evidence:Parameters<NonNullable<Parameters<typeof live.compact>[1]>>[0])=>{
        try{
          if(evidence.kind==='snapshot')await journal!.usageSnapshot({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence,completenessReason:'compaction_observed'});
          else await journal!.usageGap({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence});
        }catch(error){receiptFailure=true;throw error;}
      };
      phase('compactionMs');
      admittedModelWindow=true;
      const result=await live.compact(signal,persistEvidence,()=>{dispatched=true;onDispatch();}).finally(()=>{admittedModelWindow=false;});
      if(!result.terminalConfirmed||result.cancelled)throw Error('SESSION_COMPACTION_UNCONFIRMED');
      try{await journal!.operationTerminal({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
        ...(result.turnId===undefined?{}:{turnId:result.turnId}),terminalState:'completed',usageCompleteness:result.usageCompleteness,operationKind:'context_compression'});}
      catch(error){receiptFailure=true;throw error;}
      await view.updateInvocation!(id,{phase:'settling',cleanupOutcome:'pending'});
      settlementAttempted=true;
      // Native compression counters may be absent, placeholder or otherwise
      // unverifiable. Its confirmed completion is independent of usage quality;
      // retain unknown usage and raw evidence without treating it as failure.
      await view.settle(id,null,'confirmed_compression_unknown');settled=true;
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
      phase('forkImportMs');
    }
  }
 function operation<T>(signal:AbortSignal,work:(combined:AbortSignal)=>Promise<T>):Promise<T>{
   const owned=new AbortController();controller=owned;
   const combined=AbortSignal.any([signal,owned.signal]);
   const p=work(combined).finally(()=>{if(pending===p)pending=undefined;if(controller===owned)controller=undefined;});pending=p;return p;
 }
 const nativeDiagnostic=():NativeLifecycleDiagnostic=>{
  let idleRemainingMs:number|null=null;
  // Observing status must not refresh a permit, retire a process or alter clock state.
  if(retentionPermit)try{const now=(options.monotonicNow??(()=>performance.now()))();if(Number.isFinite(now)&&now>=lastMonotonic)idleRemainingMs=Math.max(0,retentionPermit.deadlineMs-now);}catch{}
  return {generation:nativeStarts,processStarts:nativeStarts,reuses:nativeReuses,requests:resourceRequests,knownBytes:resourceBytes,
   retained:retentionPermit!==null,idleRemainingMs,retirementReason};
 };
 const worker:ObserverWorker={
   subscribeContextPhase(listener){phaseListeners.add(listener);return ()=>{phaseListeners.delete(listener);};},
   status:()=>({active:pending!==undefined||releasing!==undefined,disabled,poisoned:poisoned||owner?.status().poisoned===true,
    ...(options.nativeContext?{cleanupPending:nativeResourcesOpen||owner!==undefined,nativeLifecycle:nativeDiagnostic()}:{})}),
   disable(){disabled=true;revokeIdle();invalidateReuse();unsubscribeAccount?.();unsubscribeAccount=undefined;controller?.abort();owner?.disable();
    if(options.nativeContext)void retireNative('disabled');},
   close(){if(closing)return closing;worker.disable();closing=(async()=>{await pending?.catch(()=>undefined);await releasing?.catch(()=>undefined);await reset();})();return closing;},
   updateRetentionState(state){
    if(!options.nativeContext)return;
    retentionState=state?Object.freeze({...state}):null;
    // Only already settled, idle completed-turn owners can bridge a normal
    // turn boundary. Never transfer active operations or an unissued permit.
    if(nativeProcessSource!==undefined&&retentionPermit&&!pending&&!releasing&&!nativeRequestAcquired&&authorized()&&
      owner?.status().alive===true&&!owner.status().disabled&&!owner.status().poisoned&&!session?.status().uncertain){
     try{if(nativeProcessRetentionValid(retentionPermit,retentionState,monotonic())){
      invalidateReuse();requestRevision++;return;
     }}catch{/* Invalid clocks retire below. */}
    }
    if(!state||!state.running||(sourceKey!==undefined&&(state.conversationKey!==sourceKey||state.generation!==generation))||
      (nativeOwnerState!==null&&(state.turnKey!==nativeOwnerState.turnKey||state.generation!==nativeOwnerState.generation))){
     void retireNative();
    }
   },
   release(permit){
     invalidateReuse();
     if(releasing)return releasing;
     const cleanup=(async()=>{await pending?.catch(()=>undefined);
       if(options.nativeContext){
        const fence=idleFence;
        let retain=false,resourceRejected=false,clockInvalid=false;
        try{
         if(nativeTerminal&&authorized()&&owner?.status().alive===true&&!owner.status().poisoned&&
           !owner.status().disabled&&!session?.status().uncertain&&nativeRetentionValid(permit,retentionState,monotonic())){
          resourceRejected=!await resourcesReusable();
          retain=!resourceRejected&&fence===idleFence&&authorized()&&nativeRetentionValid(permit,retentionState,monotonic());
         }
        }catch{clockInvalid=true;}
        if(retain&&permit){
         // Terminal settlement has finished; retained branch data is not a reusable request proof.
         nativeRequestAcquired=false;nativeSnapshot=undefined;nativeTurnPrepared=false;nativeTurnValidation=undefined;nativeTerminal=false;requestRevision++;
         if(armIdle(permit))return;
         await reset('idle_expired');return;
        }
        await reset(fence!==idleFence?'state_revoked':clockInvalid?'clock_invalid':resourceRejected?resourceFailure:'request_end');
       }else if(session?.status().uncertain||owner?.status().closed)await reset();
     })();
     releasing=cleanup.finally(()=>{releasing=undefined;});return releasing;
   },
   ...(options.nativeContext?{
    ...(options.completedTurnContext?{
    prepareNativeHistoryFallback(input,history,signal,key,g,_at,sample){
     if(pending||releasing||!authorized())return Promise.reject(Error('CONTEXT_UNAVAILABLE'));
     return operation(signal,combined=>timing.measure('preparation_total',async()=>{
      let preparationStage:PersistentPreparationStage='session_setup';
      try{
       check(combined);if(nativeTurnPrepared)throw Error('NATIVE_REQUEST_NOT_RELEASED');
       await timing.measure('source_validation',()=>history.validate(combined),'fallback');check(combined);
       await reset();requestRevision++;bind(key,g);nativeRequestAcquired=true;nativeResourcesOpen=true;nativeOwnerState=retentionState;
       sourceEpoch=JSON.stringify([history.snapshot.identity,history.snapshot.sourceEpoch,history.snapshot.revision]);
       const live=await ensure(combined,undefined,true,undefined,true);
       nativeTurnPrepared=true;nativeTurnValidation=s=>timing.measure('source_validation',()=>history.validate(s),'fallback');
       const imported=await timing.measure('supplement_import',()=>importHistory(input,history,live,combined,key,g,value=>{preparationStage=value;}),'fallback');
       ephemeralImportedBytes+=live.status().importedEncodedBytes;
       await nativeTurnValidation(combined);check(combined);
       const fresh=sample?.(),preparedInput={...imported.input,...(fresh?{activeSeconds:fresh.activeSeconds,runtime:fresh.runtime,nativeTiming:{requestActiveSeconds:fresh.requestActiveSeconds}}:{})};
       if(!observerInputSchema.safeParse(preparedInput).success)throw Error('INVALID_OBSERVER_INPUT');
       rememberPrepared(preparedInput,key,g);return {...imported,input:preparedInput};
      }catch(error){
       try{await journal?.preparationFailed?.({ownerUuid:processOwnerUuid,sourceKey:key,generation:g,stage:preparationStage,code:preparationErrorCode(error)});}catch{}
       await reset();throw error;
      }
     }));
    },
    prepareNativeTurnContext(input,source,signal,key,g,_at,sample){
     if(pending||releasing||!authorized())return Promise.reject(Error('CONTEXT_UNAVAILABLE'));
     if(retentionState&&(!retentionState.running||retentionState.turnKey!==source.currentTurnId||retentionState.generation!==g))return Promise.reject(Error('SOURCE_PREPARATION_STALE'));
     return operation(signal,combined=>timing.measure('preparation_total',async()=>{
      let preparationStage:PersistentPreparationStage='session_setup';
      try{
       invalidateReuse();requestRevision++;bind(key,g);check(combined);
       if(nativeTurnPrepared)throw Error('NATIVE_REQUEST_NOT_RELEASED');
       await timing.measure('native_acquisition',()=>acquireNative());await timing.measure('source_validation',()=>source.validate(combined));check(combined);
       const live=await timing.measure('session_ensure',()=>ensure(combined,undefined,true,source));
       nativeTurnPrepared=true;nativeTurnValidation=s=>timing.measure('source_validation',()=>source.validate(s));
       const previousBytes=live.status().importedEncodedBytes+live.status().stagedEncodedBytes+live.status().acceptedInlineEncodedBytes;
       const imported=await timing.measure('supplement_import',()=>importHistory(input,{snapshot:source.supplement},live,combined,key,g,value=>{preparationStage=value;},true));
       if(source.boundary.completed===null)ephemeralImportedBytes+=live.status().importedEncodedBytes+live.status().stagedEncodedBytes+live.status().acceptedInlineEncodedBytes-previousBytes;
       await nativeTurnValidation(combined);check(combined);
       if(options.reuseNativeTurnSession)nativeSessionRevision=source.revision;
       const fresh=sample?.();
       const preparedInput={...imported.input,...(fresh?{activeSeconds:fresh.activeSeconds,runtime:fresh.runtime,nativeTiming:{requestActiveSeconds:fresh.requestActiveSeconds}}:{})};
       if(!observerInputSchema.safeParse(preparedInput).success)throw Error('INVALID_OBSERVER_INPUT');
       rememberPrepared(preparedInput,key,g);return {...imported,input:preparedInput};
      }catch(error){
       try{await journal?.preparationFailed?.({ownerUuid:processOwnerUuid,sourceKey:key,generation:g,stage:preparationStage,code:preparationErrorCode(error)});}catch{}
       await reset();throw error;
      }
     }));
    }
    } satisfies Pick<ObserverWorker,'prepareNativeTurnContext'|'prepareNativeHistoryFallback'>:{}),
    nativeSourceDestination(signal:AbortSignal){
      if(pending||releasing||!authorized())return Promise.reject(Error('NATIVE_DESTINATION_UNAVAILABLE'));
      return operation(signal,async combined=>{check(combined);await acquireNative();check(combined);
       nativeResourcesOpen=true;
       const destination=await options.nativeContext!.destination(combined);check(combined);return destination;});
    },
    prepareNativeContext(input,source,signal,key,g,_at,sample){
      if(pending||releasing||!authorized())return source.snapshot.close().then(()=>{throw Error(`CONTEXT_UNAVAILABLE:${pending||releasing?'pending':'unauthorized'}`);});
      return operation(signal,async combined=>{
        try{
         invalidateReuse();requestRevision++;bind(key,g);check(combined);
          phase('accountProcessMs');
          if(source.snapshot.sourceTurnId!==source.currentTurnId)throw Error('NATIVE_SOURCE_TURN_MISMATCH');
          if(nativeRequestAcquired&&nativeSnapshot)throw Error('NATIVE_REQUEST_NOT_RELEASED');
          await acquireNative();
          await ensure(combined,source,true);check(combined);
          const fresh=sample?.();check(combined);
          // Only lightweight current-clock/observation data is added. Native
          // history already resides in the fork; no invented record counts.
          const {representation:_representation,historySummary:_historySummary,packingLoss:_packingLoss,...current}=input;
          const preparedInput={...current,...(fresh?{activeSeconds:fresh.activeSeconds,runtime:fresh.runtime,
            nativeTiming:{requestActiveSeconds:fresh.requestActiveSeconds},
            ...(current.observation?{observation:{...current.observation,currentAction:null}}:{})}:{}),
            imageContextPending:false,messages:[{kind:'user' as const,truncated:false,
            text:'Estimate remaining active work from currentObservation.activeSeconds until the current source turn ends. Native history is a fixed earlier snapshot; nativeTiming.requestActiveSeconds identifies the earlier request clock, not live synchronization. Use the supplemental active clock without assuming more work completed. Do not execute the task.'}]};
          if(!observerInputSchema.safeParse(preparedInput).success)throw Error('INVALID_OBSERVER_INPUT');
          rememberPrepared(preparedInput,key,g);
          return {input:preparedInput,sourceBytes:source.snapshot.byteLength,sourceRevision:source.snapshot.revision};
        }catch(error){
          const held=nativeSnapshots.includes(source.snapshot);
          await reset();if(!held)await source.snapshot.close();throw error;
        }
      });
    }
   } satisfies Pick<ObserverWorker,'nativeSourceDestination'|'prepareNativeContext'|'prepareNativeTurnContext'>:{}),
   prepareContext(input,history,signal,key,g){
     if(pending||releasing||!authorized())return history.snapshot.close().then(()=>{throw Error(`CONTEXT_UNAVAILABLE:${pending||releasing?'pending':'unauthorized'}`);});
     return operation(signal,async combined=>{
       let preparationStage:PersistentPreparationStage='session_setup';
       try{
         invalidateReuse();requestRevision++;bind(key,g);check(combined);
         phase('accountProcessMs');
         const epoch=JSON.stringify([history.snapshot.identity,history.snapshot.sourceEpoch,history.snapshot.checkpoint?.fingerprint??null]);
         if(sourceEpoch!==undefined&&sourceEpoch!==epoch)await reset();
         sourceEpoch=epoch;
         const live=await ensure(combined,undefined,true);sourceEpoch=epoch;
         const imported=await importHistory(input,history,live,combined,key,g,value=>{preparationStage=value;});
         rememberPrepared(imported.input,key,g);
         return imported;
       }catch(e){
         // Diagnostic metadata is best effort; never skip process cleanup or
         // replace the original failure if the diagnostic journal is unavailable.
         try{await journal?.preparationFailed?.({ownerUuid:processOwnerUuid,sourceKey:key,generation:g,stage:preparationStage,code:preparationErrorCode(e)});}catch{}
         await reset();throw e;
       }finally{await history.snapshot.close();}
     });
   },
   observe(input,signal,key,g=0,onStage){
     if(pending||releasing)return Promise.resolve(empty('busy'));
     if(!authorized())return Promise.resolve(empty('disabled'));
     const parsed=observerInputSchema.safeParse(input);if(!parsed.success)return Promise.resolve(empty('invalid_input'));
     if(parsed.data.imageContextPending===true||
       (parsed.data.representation&&!isInferenceEligible(parsed.data.representation)))return Promise.resolve(empty('invalid_input'));
     const preparedOwner=preparedOwners.get(input);
     if(options.nativeContext&&!preparedOwner)return Promise.resolve(empty('invalid_input'));
     if(parsed.data.representation&&!preparedOwner)return Promise.resolve(empty('invalid_input'));
     try{bind(key,g);}catch{return Promise.resolve(empty('invalid_input'));}
     // A paired-context child belongs to one ETA only. Failed/denied dispatch
     // cannot turn its prepared input into a replay capability.
     if(preparedOwner?.validateSource)preparedOwners.delete(input);
     return operation(signal,async combined=>{
       let view:SubscriptionAccounting|undefined,id:string|undefined,operationId:string|undefined,dispatched=false,settled=false,bound=false,settlementAttempted=false,receiptFailure=false;
       try{
         reportObserverStage(onStage,'preparation');
         phase('accountProcessMs');
         let proof:SessionAccountProof|null|undefined;
         if(preparedOwner&&matchesOwner(preparedOwner))proof=await preparedOwner.reuse?.claim(combined);
         check(combined);
         let live;
         if(proof&&matchesOwner(preparedOwner!)&&proof.valid())live=session!;
         else {proof=undefined;live=await ensure(combined);}
         check(combined);
         phase('accountProcessMs');
         if(preparedOwner&&!matchesOwner(preparedOwner))throw Error('SOURCE_PREPARATION_STALE');
         await preparedOwner?.validateSource?.(combined);check(combined);
         if(!await attachmentsUnchanged(combined))throw Error('IMAGE_SOURCE_CHANGED');
         if(proof&&!proof.valid()){
          proof=undefined;live=await ensure(combined);check(combined);
          if(preparedOwner&&!matchesOwner(preparedOwner))throw Error('SOURCE_PREPARATION_STALE');
         }
         // Freeze and size the complete request before ledger admission. A
         // staged prefix always fits the original bootstrap import budget;
         // if the combined ETA request does not fit, import it in full first.
         try{live.prepareEstimate(parsed.data,combined);}catch(error){
          if(live.status().stagedRecords===0||!(error instanceof Error)||
            !['NATIVE_REQUEST_TOO_LARGE','SESSION_INLINE_CAPACITY_EXCEEDED'].includes(error.message))throw error;
          phase('forkImportMs');await live.flushSupplement(combined);check(combined);
          const status=live.status();
          if(parsed.data.representation)parsed.data.representation={...parsed.data.representation,
            importedThroughOrdinal:status.cursor>=0?status.cursor:null,importedRecords:status.importedRecords,
            importedEncodedBytes:status.importedEncodedBytes,stagedRecords:0,stagedEncodedBytes:0,stagedThroughOrdinal:null,
            ...(options.reuseNativeTurnSession?{acceptedThroughOrdinal:status.acceptedThroughOrdinal}:{})};
          live.prepareEstimate(parsed.data,combined);
         }
         reportObserverStage(onStage,'admission');
          if(options.nativeContext?.usage&&!await resourcesReusable(3))throw Error('NATIVE_RESOURCE_LIMIT');
          check(combined);
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
         if(proof&&(!await proof.validate(combined)||!proof.valid()))throw Error('ACCOUNT_REUSE_INVALID_BEFORE_DISPATCH');
         await preparedOwner?.validateSource?.(combined);
         check(combined);
         if(preparedOwner&&!matchesOwner(preparedOwner))throw Error('SOURCE_PREPARATION_STALE');
         reportObserverStage(onStage,'dispatch');phase('inferenceMs');
         const persistEvidence=async(evidence:Parameters<NonNullable<Parameters<typeof live.estimate>[2]>>[0])=>{
           try{
             if(evidence.kind==='snapshot')await journal!.usageSnapshot({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence,completenessReason:'observed'});
             else await journal!.usageGap({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence});
           }catch(error){receiptFailure=true;throw error;}
         };
         // Stage listeners are synchronous but can cancel/invalidate. Nothing
         // asynchronous may run between this final fence and the model method.
         check(combined);
         if(proof&&!proof.valid())throw Error('ACCOUNT_REUSE_INVALID_BEFORE_DISPATCH');
         if(preparedOwner&&!matchesOwner(preparedOwner))throw Error('SOURCE_PREPARATION_STALE');
         dispatched=true;
         const acceptanceGuard=validateAcceptance;
         admittedModelWindow=true;
         const result=await live.estimate(parsed.data,combined,persistEvidence).finally(()=>{admittedModelWindow=false;});
         phase('deliveryMs');
         reportObserverStage(onStage,'provider_returned');
         // Once a terminal response exists, cancellation must not erase its usage.
         const imageSourceValid=!combined.aborted&&await attachmentsUnchanged(combined).catch(()=>false)&&
          (preparedOwner?.validateSource?await preparedOwner.validateSource(combined).then(()=>true,()=>false):true);
         // Dispatch reuse expires quickly; result acceptance instead validates
         // the captured account binding. Missing/failed guards fail closed,
         // without throwing away the terminal response or its token evidence.
         const accountValid=!combined.aborted&&acceptanceGuard!==undefined&&
          await acceptanceGuard(combined).catch(()=>false);
         if(operationId){
           try{
             await journal!.operationTerminal({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
                ...(result.turnId===undefined?{}:{turnId:result.turnId}),terminalState:result.cancelled?'cancelled':result.interpretation?'completed':'failed',usageCompleteness:result.usageCompleteness??'missing',operationKind:'eta'});
           }catch(error){receiptFailure=true;throw error;}
         }
         const accepted=accountValid&&imageSourceValid&&authorized()&&!combined.aborted&&result.interpretation!==null;
          await view.updateInvocation!(id,{phase:'settling',cleanupOutcome:'pending'});
         reportObserverStage(onStage,'settlement');
         const accountedUsage=result.usage?{inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,cachedInputTokens:result.usage.cachedInputTokens}:null;
         settlementAttempted=true;
         await view.settle(id,accountedUsage,result.usage?(accepted?'known_success':'known_non_success'):'safe_unknown');settled=true;
         nativeTerminal=accepted&&result.terminalConfirmed&&!result.cancelled;
         if(!imageSourceValid||!accountValid)await reset();
         return {status:result.cancelled?'aborted':accepted?'interpreted':'process_error',interpretation:accepted?result.interpretation:null,usage:result.usage} as ObserverResult;
       }catch(error){
         const sessionFailure=error as PersistentSessionError;
         if(operationId&&!dispatched&&!receiptFailure){
          try{await journal!.operationTerminal({operationId,admissionId:id!,ownerUuid:processOwnerUuid,sourceKey:key,
           sourceEpoch:sourceEpoch??null,generation:g,terminalState:'cancelled',usageCompleteness:'cancelled_before_dispatch',operationKind:'eta'});}
          catch{receiptFailure=true;}
         }
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
