export interface SeedCompletion {terminalConfirmed:boolean;cancelled:boolean;turnId?:string;usageCompleteness:string}
interface SeedOperation<T extends SeedCompletion> {
 beforeDispatch():Promise<void>;dispatch(onDispatch:()=>void):Promise<T>;
 terminal(state:'completed'|'unconfirmed'|'cancelled',result?:T):Promise<void>;
 settleConfirmed():Promise<void>;settleUnconfirmed():Promise<void>;cancelBeforeDispatch():Promise<void>;
}
/** Diagnostic seed uses the same fail-closed distinction as the production
 * worker: an ambiguous receipt/settlement is never retried or reclassified.
 * Caller owns admission/binding and unconditional process/custody closure. */
export async function runSyntheticSeedOperation<T extends SeedCompletion>(options:SeedOperation<T>):Promise<T>{
 let dispatched=false,terminalAttempted=false,receiptFailed=false,settlementAttempted=false;
 const terminal=async(state:'completed'|'unconfirmed'|'cancelled',result?:T)=>{
  terminalAttempted=true;
  try{await options.terminal(state,result);}catch(error){receiptFailed=true;throw error;}
 };
 try{
  await options.beforeDispatch();
  const result=await options.dispatch(()=>{dispatched=true;});
  if(!result.terminalConfirmed||result.cancelled)throw Error('SEED_COMPACTION_UNCONFIRMED');
  await terminal('completed',result);
  settlementAttempted=true;await options.settleConfirmed();return result;
 }catch(error){
  if(!terminalAttempted)await terminal(dispatched?'unconfirmed':'cancelled');
  if(!receiptFailed&&!settlementAttempted){
   settlementAttempted=true;
   if(dispatched)await options.settleUnconfirmed();else await options.cancelBeforeDispatch();
  }
  throw error;
 }
}
