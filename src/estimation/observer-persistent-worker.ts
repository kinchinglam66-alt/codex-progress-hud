import {randomUUID} from 'node:crypto';
import {observerInputSchema} from './observer-contract.js';
import type {ObserverWorker} from './observer-scheduler.js';
import type {ObserverResult} from './observer-provider.js';
import {reportObserverStage} from './observer-provider.js';
import type {ReleaseAccountingOwner} from './release-accounting.js';
import type {SubscriptionAccounting} from './subscription-accounting.js';
import type {Invocation} from './owned-process.js';
import {createObserverSessionProcess} from './observer-session-process.js';
import {createPersistentObserverSession} from './observer-persistent-session.js';
import {createPersistentReceiptJournal,type PersistentReceiptBinding,type PersistentReceiptJournal} from './observer-persistent-receipt.js';

export interface PersistentWorkerOptions {
 accounting:ReleaseAccountingOwner;prepareSession:(signal:AbortSignal)=>Promise<{invocation:Invocation;binding:PersistentReceiptBinding}>;
 authorize:()=>boolean;now:()=>number;outputSchema:unknown;
 receiptDirectory:string;
 processFactory?:()=>ReturnType<typeof createObserverSessionProcess>;
}
const empty=(status:ObserverResult['status']):ObserverResult=>({status,interpretation:null,usage:null});

/** Each source owns one process, each model operation a separate admission.
 * Invocation records remain in settling/pending while their process lives:
 * an operation terminal must never masquerade as a closed process. */
export function createPersistentObserverWorker(options:PersistentWorkerOptions):ObserverWorker {
 let disabled=false,poisoned=false,pending:Promise<unknown>|undefined,controller:AbortController|undefined;
 let owner:ReturnType<typeof createObserverSessionProcess>|undefined;
 let processIdentity:{pid:number;creationIdentity:string}|undefined;
 let session:ReturnType<typeof createPersistentObserverSession>|undefined;
 let sourceKey:string|undefined,sourceEpoch:string|undefined,generation=-1;
 let processOwnerUuid=randomUUID(),journal:PersistentReceiptJournal|undefined;
 if(!options.receiptDirectory)throw Error('PERSISTENT_RECEIPT_REQUIRED');
 journal=createPersistentReceiptJournal(options.receiptDirectory);
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
   owner=undefined;session=undefined;processIdentity=undefined;sourceEpoch=undefined;turns.clear();
   processOwnerUuid=randomUUID();
 }
 async function ensure(signal:AbortSignal){
   check(signal);
   // Fresh attestation every operation, even when its process is reused.
   const prepared=await options.prepareSession(signal);check(signal);
   if(owner&&(owner.status().closed||session?.status().uncertain))await reset();
   if(session)return session;
   owner=(options.processFactory??createObserverSessionProcess)();
   const opened=await owner.start(prepared.invocation);processIdentity={pid:opened.pid,creationIdentity:opened.creationIdentity};check(signal);
   await journal!.ownerStarted({ownerUuid:processOwnerUuid,sourceKey:sourceKey??'unknown',sourceEpoch:sourceEpoch??null,pid:opened.pid,creationIdentity:opened.creationIdentity,binding:prepared.binding});
   await opened.rpc.call('initialize',{clientInfo:{name:'codex_progress_hud',version:'0.2.1'},capabilities:{experimentalApi:true,requestAttestation:false}});
   opened.rpc.notify('initialized',{});
   session=createPersistentObserverSession(opened.rpc,{cwd:prepared.invocation.cwd,outputSchema:options.outputSchema,now:options.now});
   await session.start();check(signal);return session;
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
         const epoch=JSON.stringify([history.snapshot.identity,history.snapshot.sourceEpoch]);
         if(sourceEpoch!==undefined&&sourceEpoch!==epoch)await reset();
         sourceEpoch=epoch;
         const live=await ensure(combined);sourceEpoch=epoch;
         let count=0;
         for await(const item of history.snapshot.records(combined)){
           check(combined);
           const {id:_id,turnId,sourceTurnId,actionId:_actionId,...data}=item.record;
           const turn=sourceTurnId??turnId;
           if(turn!==null&&turn!==undefined&&!turns.has(turn))turns.set(turn,turns.size);
           const text=JSON.stringify({sourceTurn:turn===null||turn===undefined?null:turns.get(turn),...data});
           await live.append([{ordinal:item.ordinal,text}],combined);count++;
         }
         check(combined);
        const representation={mode:history.snapshot.coverage.complete?'full' as const:'incomplete' as const,
           sourceComplete:history.snapshot.coverage.complete,originalRecords:input.messages.length,
           sessionCoveredRecords:count,compressedThroughOrdinal:null,sizing:'conservative' as const};
         return {input:{...input,representation},representation};
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
         const admission=await options.accounting.recoveryAdmission?.(options.now(),true,key);
         if(admission&&!admission.allowed)return {...empty('admission_denied'),admissionReason:admission.reason??'unresolved_previous_call'};
         view=options.accounting.forConversation(key);
         id=(await view.reserve(admission?.kind??'ordinary','eta'))??undefined;
         if(!id)return empty('admission_denied');
         reportObserverStage(onStage,'reservation');check(combined);
         if(!processIdentity||!view.bindInvocation||!view.updateInvocation)throw Error('SESSION_ACCOUNTING_OWNERSHIP');
         await view.bindInvocation(id,{admissionId:id,conversationKey:key,turnGeneration:g,ownerUuid:processOwnerUuid,providerKind:'subscription',
           phase:'bound',deadline:options.now()+120000,cleanupOutcome:'pending',...processIdentity});bound=true;
         operationId=randomUUID();
         try{await journal!.operationStarted({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g});}
         catch(error){receiptFailure=true;throw error;}
         // Recheck trusted authorization at the irreversible request boundary.
         check(combined);await view.updateInvocation(id,{phase:'dispatching'});check(combined);
         dispatched=true;reportObserverStage(onStage,'dispatch');
         const result=await live.estimate(parsed.data,combined,evidence=>evidence.kind==='snapshot'
           ?journal!.usageSnapshot({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence,completenessReason:'observed'})
           :journal!.usageGap({operationId:operationId!,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,...evidence}));
         reportObserverStage(onStage,'provider_returned');
         if(operationId){
           try{
             await journal!.operationTerminal({operationId,admissionId:id,ownerUuid:processOwnerUuid,sourceKey:key,sourceEpoch:sourceEpoch??null,generation:g,
               ...(result.turnId===undefined?{}:{turnId:result.turnId}),terminalState:result.cancelled?'cancelled':result.interpretation?'completed':'failed',usageCompleteness:result.usageCompleteness??'missing'});
           }catch(error){receiptFailure=true;throw error;}
         }
         const accepted=authorized()&&!combined.aborted&&result.interpretation!==null;
         await view.updateInvocation(id,{phase:'settling',cleanupOutcome:'pending'});
         reportObserverStage(onStage,'settlement');
         const accountedUsage=result.usage?{inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,cachedInputTokens:result.usage.cachedInputTokens}:null;
         settlementAttempted=true;
         await view.settle(id,accountedUsage,result.usage?(accepted?'known_success':'known_non_success'):'safe_unknown');settled=true;
         return {status:result.cancelled?'aborted':accepted?'interpreted':'process_error',interpretation:accepted?result.interpretation:null,usage:result.usage} as ObserverResult;
       }catch{
         let cleaned=false;try{await reset();cleaned=true;}catch{poisoned=true;}
         if(receiptFailure){poisoned=true;return empty('accounting_error');}
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
