import type {ContextCapacity} from './context-capacity.js';
import type {PersistentWorkerOptions} from './observer-persistent-worker.js';

/** Local import policy, not a measurement of opaque checkpoint resident tokens.
 * Text uses a conservative byte budget; half is reserved for retained context.
 * No original records are cropped to meet this policy: exhaustion is explicit.
 */
export function persistentHistoryPolicy(capacity:ContextCapacity|null):Pick<PersistentWorkerOptions,'bootstrapBatchByteCapacity'|'historyBudget'>{
 if(capacity===null)return {};
 if(!Number.isSafeInteger(capacity.contextTokens)||!Number.isSafeInteger(capacity.outputReserveTokens)||
   capacity.outputReserveTokens<0||capacity.contextTokens<=capacity.outputReserveTokens||
   (capacity.requestBytes!==null&&(!Number.isSafeInteger(capacity.requestBytes)||capacity.requestBytes<1)))throw Error('INVALID_HISTORY_CAPACITY');
 const available=capacity.contextTokens-capacity.outputReserveTokens;
 const reserve=Math.ceil(available/2),newInput=available-reserve;
 if(newInput<1024||!Number.isSafeInteger(newInput*16))throw Error('INVALID_HISTORY_CAPACITY');
 const frame=Math.min(65536,newInput,capacity.requestBytes===null?65536:Math.floor(capacity.requestBytes/2));
 if(frame<1024)throw Error('INVALID_HISTORY_CAPACITY');
 return {bootstrapBatchByteCapacity:frame,historyBudget:{trusted:true,
   contextCapacityBytes:available,retainedSummaryReserveBytes:reserve,
   maxSourceBytes:newInput*16,maxCompactionOperations:16}};
}
