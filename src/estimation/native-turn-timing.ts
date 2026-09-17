export interface NativeTurnTiming {
 phase:'base_acquire'|'base_storage'|'base_copy'|'base_fork'|'child_fork'|'supplement_import'|'source_validation'|'preparation_total'|'native_acquisition'|'session_preparation'|'base_reuse_validation'|'session_ensure';
 elapsedMs:number|null;
 outcome:'ok'|'failed';
 baseState?:'cold'|'warm'|'empty'|'fallback';
}
/** Diagnostic spans may nest: preparation_total includes its children and must
 * never be added to them. External acquisition/queue and dispatch costs still
 * belong to the existing end-to-end evaluator, not this worker-only timer. */
export function createNativeTurnTiming(now:()=>number,emit?:(event:Readonly<NativeTurnTiming>)=>void){
 const read=()=>{try{const value=now();return Number.isFinite(value)&&value>=0?value:null;}catch{return null;}};
 return {async measure<T>(phase:NativeTurnTiming['phase'],work:()=>Promise<T>,baseState?:NativeTurnTiming['baseState']):Promise<T>{
  if(!emit)return work();
  const start=read();let outcome:NativeTurnTiming['outcome']='failed';
  try{const result=await work();outcome='ok';return result;}
  finally{
   const end=read(),elapsedMs=start===null||end===null||end<start?null:end-start;
   try{emit(Object.freeze({phase,elapsedMs,outcome,...(baseState===undefined?{}:{baseState})}));}catch{/* Diagnostics never grant/revoke authority. */}
  }
 }};
}
