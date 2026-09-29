import {appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {currentRequestCorrelation} from './request-correlation.js';
import {identityPreparationCodes} from './identity-preparation-error.js';
import type {RawTokens} from './observer-persistent-session.js';
import type {HistoryCapacityDetail} from './history-capacity-error.js';

const capacityDetail=z.object({kind:z.enum(['checkpoint_window','attachment_manifest','source_budget_exhausted']),
 observedBytes:z.number().int().positive().safe(),limitBytes:z.number().int().positive().safe()}).strict()
 .refine(value=>value.observedBytes>value.limitBytes);

const token=z.object({totalTokens:z.number().int().nonnegative().safe(),inputTokens:z.number().int().nonnegative().safe(),
  outputTokens:z.number().int().nonnegative().safe(),cachedInputTokens:z.number().int().nonnegative().safe(),
  cacheWriteInputTokens:z.number().int().nonnegative().safe(),reasoningOutputTokens:z.number().int().nonnegative().safe()}).strict();
const sourceKey=z.string().min(1).max(512), sourceEpoch=z.string().max(4096).nullable().optional();
const ownerUuid=z.string().uuid(), operationId=z.string().uuid();
export interface PersistentReceiptBinding {accountFingerprint:string;routeFingerprint:string;assetsFingerprint:string}
export type PersistentOperationKind='eta'|'context_compression';
const preparationStages=['session_setup','checkpoint_import','history_import','source_revalidation','observation_refresh','input_validation','context_compression'] as const;
export type PersistentPreparationStage=typeof preparationStages[number];
const preparationCodes=[...identityPreparationCodes,'PREPARATION_UNKNOWN','CHECKPOINT_INVALID','CHECKPOINT_REBUILD_REQUIRED','CHECKPOINT_ACK_INVALID',
 'IMAGE_PATH_REJECTED','IMAGE_READ_FAILED','IMAGE_FORMAT_UNSUPPORTED','IMAGE_CAPACITY_EXCEEDED','NATIVE_REQUEST_TOO_LARGE',
 'APP_SERVER_RPC_ERROR','APP_SERVER_RPC_CLOSED','APP_SERVER_RPC_EOF','APP_SERVER_RPC_TIMEOUT','APP_SERVER_RPC_FRAME_TOO_LARGE',
 'APP_SERVER_RPC_WRITE_FAILED','SESSION_THREAD_MISSING','SESSION_PROTOCOL_FAILED','SESSION_TIMEOUT',
 'NATIVE_BASE_BINDING_CHANGED','NATIVE_BASE_ID_INVALID','NATIVE_BASE_REUSE_MISSING','NATIVE_BASE_SNAPSHOT_MISSING',
 'NATIVE_BASE_SOURCE_MISMATCH','NATIVE_BASE_UNAVAILABLE','NATIVE_CONTEXT_UNAVAILABLE','NATIVE_CONTEXT_STALE','SOURCE_PREPARATION_STALE','NATIVE_DESTINATION_UNAVAILABLE',
 'NATIVE_CONTROLLER_IDENTITY_UNAVAILABLE','NATIVE_FORK_CLEANUP_PENDING','NATIVE_GUARD_POISONED','NATIVE_OWNER_EXIT_UNCONFIRMED',
 'NATIVE_REQUEST_NOT_RELEASED','NATIVE_RESOURCE_BASE_EXISTS','NATIVE_RESOURCE_BASE_MISMATCH','NATIVE_RESOURCE_BUSY',
 'NATIVE_RESOURCE_FORK_LOG_UNKNOWN','NATIVE_RESOURCE_FORK_MISMATCH','NATIVE_RESOURCE_LIMIT','NATIVE_RESOURCE_MANIFEST_UNKNOWN',
 'NATIVE_RESOURCE_METADATA_UNKNOWN','NATIVE_RESOURCE_OWNERSHIP_UNKNOWN','NATIVE_RESOURCE_PATH','NATIVE_RESOURCE_REPARSE',
 'NATIVE_RESOURCE_REPLACED','NATIVE_RESOURCE_ROLE_INVALID','NATIVE_RESOURCE_SCAN_LIMIT','NATIVE_RESOURCE_SIZE_UNKNOWN',
 'NATIVE_RESOURCE_STALE','NATIVE_RESOURCE_UNREGISTERED','NATIVE_RESOURCE_USAGE_INVALID','NATIVE_RUNTIME_HOME_MISMATCH',
 'NATIVE_SNAPSHOT_CUSTODY_ALREADY_REGISTERED','NATIVE_SNAPSHOT_CUSTODY_EXIT_UNKNOWN','NATIVE_SNAPSHOT_CUSTODY_LIMIT',
 'NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','NATIVE_SNAPSHOT_CUSTODY_NONEMPTY','NATIVE_SNAPSHOT_CUSTODY_OUTSIDE_HOME',
 'NATIVE_SNAPSHOT_CUSTODY_OWNERSHIP_MISMATCH','NATIVE_SNAPSHOT_CUSTODY_PATH','NATIVE_SNAPSHOT_CUSTODY_PROCESS_INVALID',
 'NATIVE_SNAPSHOT_CUSTODY_PROCESS_NOT_EXITED','NATIVE_SNAPSHOT_CUSTODY_REPARSE','NATIVE_SNAPSHOT_CUSTODY_REPLACED',
 'NATIVE_SOURCE_GENERATION_CHANGED','NATIVE_SOURCE_LIMIT_INVALID','NATIVE_SOURCE_REVISION_REGRESSED',
 'NATIVE_SOURCE_TURN_MISMATCH','NATIVE_STORAGE_UNAVAILABLE',
 'SOURCE_REWRITE','SOURCE_GAP','SOURCE_INVALID','SOURCE_SNAPSHOT_INCOMPLETE','SOURCE_TRUNCATED','SOURCE_ACK_INVALID',
 'SOURCE_HISTORY_BINDING_CHANGED','GOAL_TICKET_STALE','INVALID_OBSERVER_INPUT',
 'SESSION_UNAVAILABLE','SESSION_SUPPLEMENT_PENDING_OR_SUBMITTED','SESSION_BATCH_CAPACITY_TOO_SMALL',
 'source_cancelled','source_closed','source_invalid_thread','source_unobserved','source_not_found','source_unavailable',
 'source_unsafe_path','source_ambiguous','source_identity_mismatch','source_limit','source_oversize','source_malformed',
 'source_terminal_unsupported','source_checkpoint_unsupported',
 'capacity_unknown','context_too_large','ABORTED'] as const;
export function preparationErrorCode(error:unknown):typeof preparationCodes[number]{
 if(error instanceof Error){
   if(error.name==='AbortError')return 'ABORTED';
   // Custody errors carry a bounded code separately from their potentially
   // private message. Do not execute accessors or accept a code by prefix.
   let structuredCode:unknown;
   try{structuredCode=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
   for(const code of preparationCodes)if(structuredCode===code)return code;
   if(error.message.startsWith('context_too_large:'))return 'context_too_large';
   for(const code of preparationCodes)if(error.message===code)return code;
 }
 return 'PREPARATION_UNKNOWN';
}
export interface PersistentReceiptJournal {
 preparationFailed?(value:{ownerUuid:string;sourceKey:string;generation:number;stage:PersistentPreparationStage;code:string;capacity?:Readonly<HistoryCapacityDetail>|undefined}):Promise<void>;
 ownerStarted(value:{ownerUuid:string;sourceKey:string;sourceEpoch?:string|null;pid:number;creationIdentity:string;binding?:PersistentReceiptBinding}):Promise<void>;
  operationStarted(value:{operationId:string;admissionId:string;ownerUuid:string;sourceKey:string;sourceEpoch?:string|null;generation:number;operationKind?:PersistentOperationKind}):Promise<void>;
 usageSnapshot(value:{operationId:string;sourceKey:string;sourceEpoch?:string|null;generation:number;total:RawTokens;last:RawTokens;observedAt:number;completenessReason:string}):Promise<void>;
 usageGap(value:{operationId:string;sourceKey:string;sourceEpoch?:string|null;generation:number;observedAt:number;reason:string}):Promise<void>;
  operationTerminal(value:{operationId:string;admissionId:string;ownerUuid:string;sourceKey:string;sourceEpoch?:string|null;generation:number;turnId?:string;terminalState:'completed'|'cancelled'|'failed'|'unconfirmed';usageCompleteness:string;operationKind?:PersistentOperationKind}):Promise<void>;
 processExit(value:{ownerUuid:string;sourceKey?:string;sourceEpoch?:string|null;processExitState:'closed'|'unconfirmed';at:number}):Promise<void>;
}
type RecordValue=Record<string,unknown>;
const record=(value:RecordValue)=>value;

/** Host-owned, append-only evidence for the persistent session. It deliberately
 * stores metadata and sanitized raw counters only; prompt text never enters it. */
export function createPersistentReceiptJournal(directory:string):PersistentReceiptJournal {
 if(typeof directory!=='string'||directory.length===0||directory.length>4096)throw Error('PERSISTENT_RECEIPT_DIRECTORY');
 const path=join(directory,'persistent-session-receipts.jsonl');
 let tail=Promise.resolve(),failed=false;
 const seen=new Set<string>();
 const append=(value:RecordValue):Promise<void>=>{
   if(failed)return Promise.reject(Error('PERSISTENT_RECEIPT_UNAVAILABLE'));
   const next=tail.then(async()=>{
     await mkdir(directory,{recursive:true,mode:0o700});
     await appendFile(path,`${JSON.stringify(value)}\n`,{encoding:'utf8',flag:'a'});
   }).catch(()=>{failed=true;throw Error('PERSISTENT_RECEIPT_WRITE_FAILED');});
   tail=next.catch(()=>undefined);return next;
 };
 const base=(kind:string,value:RecordValue)=>record({kind,at:Date.now(),fullPipelineVerified:false,
   ...(['preparation_failure','operation','usage_snapshot','usage_gap'].includes(kind)&&currentRequestCorrelation()
     ?{correlationId:currentRequestCorrelation()}:{}),...value});
 return {
   preparationFailed:async value=>{
     await append(base('preparation_failure',{ownerUuid:ownerUuid.parse(value.ownerUuid),sourceKey:sourceKey.parse(value.sourceKey),
       generation:z.number().int().nonnegative().safe().parse(value.generation),stage:z.enum(preparationStages).parse(value.stage),code:z.enum(preparationCodes).parse(value.code),
       ...(value.code==='context_too_large'&&value.capacity!==undefined?{capacity:capacityDetail.parse(value.capacity)}:{})}));
   },
   ownerStarted:async value=>{
     const source=sourceKey.parse(value.sourceKey),epoch=sourceEpoch.parse(value.sourceEpoch??null);
     const binding={accountFingerprint:z.string().regex(/^[a-f0-9]{64}$/).parse(value.binding?.accountFingerprint),routeFingerprint:z.string().regex(/^[a-f0-9]{64}$/).parse(value.binding?.routeFingerprint),assetsFingerprint:z.string().regex(/^[a-f0-9]{64}$/).parse(value.binding?.assetsFingerprint)};
     await append(base('process_owner',{ownerUuid:ownerUuid.parse(value.ownerUuid),sourceKey:source,sourceEpoch:epoch,pid:z.number().int().positive().safe().parse(value.pid),creationIdentity:z.string().min(1).max(256).parse(value.creationIdentity),binding}));
   },
    operationStarted:async value=>{
      await append(base('operation',{operationId:operationId.parse(value.operationId),admissionId:z.string().uuid().parse(value.admissionId),ownerUuid:ownerUuid.parse(value.ownerUuid),sourceKey:sourceKey.parse(value.sourceKey),sourceEpoch:sourceEpoch.parse(value.sourceEpoch??null),generation:z.number().int().nonnegative().safe().parse(value.generation),operationKind:z.enum(['eta','context_compression']).default('eta').parse(value.operationKind),terminalState:'pending'}));
   },
   usageSnapshot:async value=>{
     const total=token.parse(value.total),last=token.parse(value.last),key=JSON.stringify([value.operationId,total,last]);
     if(seen.has(key))return;
     seen.add(key);
     await append(base('usage_snapshot',{operationId:operationId.parse(value.operationId),sourceKey:sourceKey.parse(value.sourceKey),sourceEpoch:sourceEpoch.parse(value.sourceEpoch??null),generation:z.number().int().nonnegative().safe().parse(value.generation),total,last,observedAt:z.number().int().nonnegative().safe().parse(value.observedAt),completenessReason:z.string().min(1).max(128).parse(value.completenessReason)}));
   },
   usageGap:async value=>{
     await append(base('usage_gap',{operationId:operationId.parse(value.operationId),sourceKey:sourceKey.parse(value.sourceKey),sourceEpoch:sourceEpoch.parse(value.sourceEpoch??null),generation:z.number().int().nonnegative().safe().parse(value.generation),observedAt:z.number().int().nonnegative().safe().parse(value.observedAt),reason:z.string().min(1).max(128).parse(value.reason)}));
   },
   operationTerminal:async value=>{
      await append(base('operation',{operationId:operationId.parse(value.operationId),admissionId:z.string().uuid().parse(value.admissionId),ownerUuid:ownerUuid.parse(value.ownerUuid),sourceKey:sourceKey.parse(value.sourceKey),sourceEpoch:sourceEpoch.parse(value.sourceEpoch??null),generation:z.number().int().nonnegative().safe().parse(value.generation),...(value.turnId===undefined?{}:{turnId:z.string().min(1).max(256).parse(value.turnId)}),operationKind:z.enum(['eta','context_compression']).default('eta').parse(value.operationKind),terminalState:z.enum(['completed','cancelled','failed','unconfirmed']).parse(value.terminalState),usageCompleteness:z.string().min(1).max(128).parse(value.usageCompleteness)}));
   },
   processExit:async value=>{
     await append(base('process_exit',{ownerUuid:ownerUuid.parse(value.ownerUuid),...(value.sourceKey===undefined?{}:{sourceKey:sourceKey.parse(value.sourceKey)}),sourceEpoch:sourceEpoch.parse(value.sourceEpoch??null),processExitState:value.processExitState,at:z.number().int().nonnegative().safe().parse(value.at)}));
   },
 };
}
