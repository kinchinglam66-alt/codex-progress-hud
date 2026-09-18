import {createHash} from 'node:crypto';
import type {HistorySnapshot} from './history-snapshot.js';
import {parseCodexCheckpoint} from './codex-checkpoint.js';

export interface VerifiedHistoryFallback {
 snapshot:HistorySnapshot;
 currentTurnId:string;
 validate(signal:AbortSignal):Promise<void>;
}

/** A bounded effective model window, never permission to replay lifetime history. */
export async function assertCheckpointWindow(snapshot:HistorySnapshot,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();
 if(!snapshot.checkpoint)throw Error('CHECKPOINT_REQUIRED');
 const checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:snapshot.checkpoint.items}});
 if(!checkpoint||checkpoint.fingerprint!==snapshot.checkpoint.fingerprint)throw Error('CHECKPOINT_INVALID');
 let bytes=checkpoint.encodedBytes;
 const checkSize=()=>{if(bytes>8*1024*1024)throw Error('context_too_large:checkpoint_window');};
 checkSize();
 for await(const item of snapshot.records(signal)){
  signal.throwIfAborted();bytes+=Buffer.byteLength(JSON.stringify(item),'utf8');checkSize();
 }
 if(!snapshot.coverage.complete||snapshot.coverage.gaps.length)throw Error('history_incomplete');
}

/** Reuses a fixed-watermark snapshot; retains per-record digests, never a second
 * history text buffer. Snapshot/attachment ownership remains with the caller. */
export async function verifyHistoryFallback(history:{snapshot:HistorySnapshot;currentTurnId:string},signal:AbortSignal,checkTicket:(signal:AbortSignal)=>Promise<void>):Promise<VerifiedHistoryFallback>{
 const snapshot=history.snapshot;
 const records:string[]=[];
 const fingerprint=(item:unknown)=>createHash('sha256').update(JSON.stringify(item)).digest('hex');
 const metadata=()=>fingerprint([snapshot.identity,snapshot.sourceEpoch,snapshot.revision,history.currentTurnId,snapshot.checkpoint??null]);
 const initialMetadata=metadata();
 const digest=async(s:AbortSignal,capture=false)=>{
  s.throwIfAborted();await checkTicket(s);
  const hash=createHash('sha256').update(metadata()+'\n');
  let ordinal=0;
  for await(const item of snapshot.records(s)){
   s.throwIfAborted();if(item.ordinal!==ordinal++)throw Error('history_incomplete');
   hash.update(JSON.stringify(item)+'\n');
   if(capture)records.push(fingerprint(item));
  }
  if(!snapshot.coverage.complete||snapshot.coverage.gaps.length)throw Error('history_incomplete');
  await checkTicket(s);s.throwIfAborted();return hash.digest('hex');
 };
 const initial=await digest(signal,true);
 const verifiedSnapshot:HistorySnapshot={...snapshot,async *records(s){
  await checkTicket(s);s.throwIfAborted();if(metadata()!==initialMetadata)throw Error('HISTORY_FALLBACK_CHANGED');
  let ordinal=0;
  for await(const item of snapshot.records(s)){
   s.throwIfAborted();
   if(item.ordinal!==ordinal||fingerprint(item)!==records[ordinal])throw Error('HISTORY_FALLBACK_CHANGED');
   ordinal++;yield item;
  }
  if(ordinal!==records.length||metadata()!==initialMetadata||!snapshot.coverage.complete||snapshot.coverage.gaps.length)throw Error('HISTORY_FALLBACK_CHANGED');
  await checkTicket(s);s.throwIfAborted();
 }};
 return {...history,snapshot:verifiedSnapshot,validate:async(s:AbortSignal)=>{if(await digest(s)!==initial)throw Error('HISTORY_FALLBACK_CHANGED');}};
}
