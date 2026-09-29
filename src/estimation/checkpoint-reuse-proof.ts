import {createHash} from 'node:crypto';
import type {VerifiedHistoryFallback} from '../observer/verified-history-fallback.js';

/** Local-only evidence. Never a substitute for session/account/terminal checks. */
export interface CheckpointReuseProof {
 readonly key:string;readonly generation:number;readonly turn:string;
 readonly identity:string;readonly epoch:number;readonly revision:number;
 readonly checkpoint:string;readonly records:readonly string[];
}
export async function captureCheckpointReuseProof(history:VerifiedHistoryFallback,key:string,generation:number,
 signal:AbortSignal):Promise<CheckpointReuseProof|null>{
 const snapshot=history.snapshot;
 if(!snapshot.checkpoint)return null;
 const checkpoint=snapshot.checkpoint.fingerprint;
 const identity=snapshot.identity,epoch=snapshot.sourceEpoch,revision=snapshot.revision,turn=history.currentTurnId;
 if(!identity||!key||!turn||![epoch,revision,generation].every(n=>Number.isSafeInteger(n)&&n>=0))return null;
 const records:string[]=[];
 await history.validate(signal);
 for await(const item of snapshot.records(signal)){
  signal.throwIfAborted();
  if(item.ordinal!==records.length)throw Error('HISTORY_FALLBACK_CHANGED');
  records.push(createHash('sha256').update(JSON.stringify(item)).digest('hex'));
 }
 await history.validate(signal);signal.throwIfAborted();
 if(snapshot.identity!==identity||snapshot.sourceEpoch!==epoch||snapshot.revision!==revision||
   history.currentTurnId!==turn||snapshot.checkpoint?.fingerprint!==checkpoint||
   !snapshot.coverage.complete||snapshot.coverage.gaps.length)throw Error('HISTORY_FALLBACK_CHANGED');
 return Object.freeze({key,generation,turn,identity,epoch,revision,checkpoint,records:Object.freeze(records)});
}
export function checkpointPrefixReusable(previous:CheckpointReuseProof|null,next:CheckpointReuseProof|null,
 acceptedThroughOrdinal:number|null):boolean{
 if(!previous||!next||previous.key!==next.key||previous.generation!==next.generation||previous.turn!==next.turn||
   previous.identity!==next.identity||previous.epoch!==next.epoch||previous.checkpoint!==next.checkpoint||
   next.revision<previous.revision||next.records.length<previous.records.length)return false;
 if(next.revision===previous.revision&&next.records.length!==previous.records.length)return false;
 if((acceptedThroughOrdinal??-1)!==previous.records.length-1)return false;
 return previous.records.every((hash,index)=>hash===next.records[index]);
}
