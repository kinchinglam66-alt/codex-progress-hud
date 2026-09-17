/** Diagnostic adapter only. Refresh metadata inside the measured request but
 * before worker admission checks. Transfer that preparation once, so neither
 * strategy gains unmeasured work or pays for the same preparation twice. */
export function createMeasuredComparisonPreparation<T>(options:{
 accountPhase:()=>void;
 prepare:(signal:AbortSignal)=>Promise<T>;
 disposeUnused:(value:T)=>void;
}){
 let held:{value:T}|undefined,measuring=false;
 return {
  async runMeasured<R>(signal:AbortSignal,operation:()=>Promise<R>):Promise<R>{
   if(measuring)throw Error('TRIAL_PREPARATION_OVERLAP');
   measuring=true;
   try{
    signal.throwIfAborted();options.accountPhase();
    held={value:await options.prepare(signal)};
    signal.throwIfAborted();
    return await operation();
   }finally{
    const unused=held;held=undefined;measuring=false;
    if(unused)options.disposeUnused(unused.value);
   }
  },
  async prepareSession(signal:AbortSignal):Promise<T>{
   const prepared=held;held=undefined;
   if(prepared){
    try{signal.throwIfAborted();return prepared.value;}
    catch(error){options.disposeUnused(prepared.value);throw error;}
   }
   signal.throwIfAborted();return options.prepare(signal);
  },
 };
}
