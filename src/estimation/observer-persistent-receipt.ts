import {appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {RawTokens} from './observer-persistent-session.js';

const token=z.object({totalTokens:z.number().int().nonnegative().safe(),inputTokens:z.number().int().nonnegative().safe(),
  outputTokens:z.number().int().nonnegative().safe(),cachedInputTokens:z.number().int().nonnegative().safe(),
  cacheWriteInputTokens:z.number().int().nonnegative().safe(),reasoningOutputTokens:z.number().int().nonnegative().safe()}).strict();
const sourceKey=z.string().min(1).max(512), sourceEpoch=z.string().max(4096).nullable().optional();
const ownerUuid=z.string().uuid(), operationId=z.string().uuid();
export interface PersistentReceiptBinding {accountFingerprint:string;routeFingerprint:string;assetsFingerprint:string}
export type PersistentOperationKind='eta'|'context_compression';
const preparationStages=['session_setup','checkpoint_import','history_import','context_compression'] as const;
export type PersistentPreparationStage=typeof preparationStages[number];
const preparationCodes=['PREPARATION_UNKNOWN','CHECKPOINT_INVALID','CHECKPOINT_REBUILD_REQUIRED','CHECKPOINT_ACK_INVALID',
 'APP_SERVER_RPC_ERROR','APP_SERVER_RPC_CLOSED','APP_SERVER_RPC_EOF','APP_SERVER_RPC_TIMEOUT','APP_SERVER_RPC_FRAME_TOO_LARGE',
 'APP_SERVER_RPC_WRITE_FAILED','SESSION_THREAD_MISSING','SESSION_PROTOCOL_FAILED','SESSION_TIMEOUT',
 'SOURCE_REWRITE','SOURCE_GAP','SOURCE_INVALID','capacity_unknown','context_too_large','ABORTED'] as const;
export function preparationErrorCode(error:unknown):typeof preparationCodes[number]{
 if(error instanceof Error){
   if(error.name==='AbortError')return 'ABORTED';
   if(error.message.startsWith('context_too_large:'))return 'context_too_large';
   for(const code of preparationCodes)if(error.message===code)return code;
 }
 return 'PREPARATION_UNKNOWN';
}
export interface PersistentReceiptJournal {
 preparationFailed?(value:{ownerUuid:string;sourceKey:string;generation:number;stage:PersistentPreparationStage;code:string}):Promise<void>;
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
 const base=(kind:string,value:RecordValue)=>record({kind,at:Date.now(),fullPipelineVerified:false,...value});
 return {
   preparationFailed:async value=>{
     await append(base('preparation_failure',{ownerUuid:ownerUuid.parse(value.ownerUuid),sourceKey:sourceKey.parse(value.sourceKey),
       generation:z.number().int().nonnegative().safe().parse(value.generation),stage:z.enum(preparationStages).parse(value.stage),code:z.enum(preparationCodes).parse(value.code)}));
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
