import {open,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
type Kind='eta'|'compaction';
type Completion='completed'|'failed'|'unconfirmed';
/** Extra diagnostic ceiling, NOT a replacement for subscription authorization,
 * invocation ownership or the release ledger. A spent or interrupted run is
 * never reopened. The harness must use its fixed approved audit directory. */
export type NativeApprovedTrialId='native-context-20260914'|'native-context-20260915'|'native-context-20260915-r3'|'native-context-20260915-r4'|'native-context-20260915-r5'|'native-context-20260915-r6'|'native-context-20260915-r7'|'native-context-20260915-r8'|'native-context-20260915-r9'|'native-context-20260915-r10'|'native-compression-20260915-r11'|'native-compression-20260915-r12'|'native-compression-20260915-r13'|`native-localization-20260915-${string}`|`native-comparison-20260915-${string}`;
export async function openNativeTrialBudget(directory:string,authority?:{approvedTrialId:NativeApprovedTrialId;binding:{accountFingerprint:string;routeFingerprint:string;assetsFingerprint:string}}){
 const series=/^native-(?:localization-20260915-|comparison-20260915-(?:large-)?)[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(authority?.approvedTrialId??'');
 if(authority&&!series&&!['native-context-20260914','native-context-20260915','native-context-20260915-r3','native-context-20260915-r4','native-context-20260915-r5','native-context-20260915-r6','native-context-20260915-r7','native-context-20260915-r8','native-context-20260915-r9','native-context-20260915-r10','native-compression-20260915-r11','native-compression-20260915-r12','native-compression-20260915-r13'].includes(authority.approvedTrialId))throw Error('TRIAL_AUTHORITY_INVALID');
 const localization=(series&&authority!.approvedTrialId.startsWith('native-localization-'))||authority?.approvedTrialId==='native-compression-20260915-r11'||authority?.approvedTrialId==='native-compression-20260915-r12'||authority?.approvedTrialId==='native-compression-20260915-r13';
 // Separately registered 1MiB comparison: three full baseline imports need
 // 21 explicit compressions in local sizing; reserve three additional slots.
 // Old authorities keep their original limits and cannot be reopened.
 const largeComparison=series&&authority!.approvedTrialId.startsWith('native-comparison-20260915-large-');
 const etaLimit=localization?3:6,compactionLimit=localization?1:largeComparison?24:6;
 if(!isAbsolute(directory))throw Error('TRIAL_DIRECTORY_INVALID');
 const stat=await lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('TRIAL_DIRECTORY_INVALID');
 // Legacy authorities remain fixed and spent. Continuing authorization uses
 // only the validated generated series IDs, never report paths or accounts.
 const auditName=series?`${authority!.approvedTrialId}-budget.jsonl`:authority?.approvedTrialId==='native-compression-20260915-r13'?'native-compression-20260915-r13-budget.jsonl':authority?.approvedTrialId==='native-compression-20260915-r12'?'native-compression-20260915-r12-budget.jsonl':localization?'native-compression-20260915-r11-budget.jsonl':authority?.approvedTrialId==='native-context-20260915-r10'?'native-context-20260915-r10-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r9'?'native-context-20260915-r9-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r8'?'native-context-20260915-r8-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r7'?'native-context-20260915-r7-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r6'?'native-context-20260915-r6-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r5'?'native-context-20260915-r5-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r4'?'native-context-20260915-r4-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915-r3'?'native-context-20260915-r3-budget.jsonl':
  authority?.approvedTrialId==='native-context-20260915'?'native-context-20260915-budget.jsonl':'native-trial-budget.jsonl';
 const file=await open(join(directory,auditName),'wx',0o600).catch(error=>{
  if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('TRIAL_ALREADY_STARTED');throw error;
 });
 let eta=0,compaction=0,active:string|undefined,activeKind:Kind|undefined,stopped=false,closing=false;
 let tail:Promise<unknown>=Promise.resolve(),closePromise:Promise<void>|undefined;
 async function append(value:unknown){
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}
  catch(error){stopped=true;throw error;}
 }
 try{await append({type:'started',version:1,runId:randomUUID(),model:'gpt-5.6-luna',effort:'medium',serviceTier:'default',etaLimit,compactionLimit,synthetic:true,...authority});}
 catch(error){await file.close();throw error;}
 function serial<T>(work:()=>Promise<T>):Promise<T>{
  if(closing)return Promise.reject(Error('TRIAL_CLOSED'));
  const result=tail.then(work);tail=result.catch(()=>undefined);return result;
 }
 return {
  snapshot:()=>Object.freeze({eta,compaction,inFlight:active!==undefined,stopped}),
  reserve(kind:Kind):Promise<string>{return serial(async()=>{
   if(stopped)throw Error('TRIAL_STOPPED');
   if(kind!=='eta'&&kind!=='compaction')throw Error('TRIAL_KIND_INVALID');
   if(active)throw Error('TRIAL_OPERATION_IN_FLIGHT');
   if((kind==='eta'?eta:compaction)>=(kind==='eta'?etaLimit:compactionLimit))throw Error('TRIAL_BUDGET_EXHAUSTED');
   // Leave one unspent compaction slot available for an unexpected runtime
   // compaction nested in this ETA. It is released if the ETA ends without one.
   // Localization deliberately probes after its single explicit compaction.
   // Any automatic compaction stops it and remains recorded, never hidden.
   if(!localization&&kind==='eta'&&compaction>=compactionLimit)throw Error('TRIAL_COMPACTION_CONTINGENCY_EXHAUSTED');
   const id=randomUUID();await append({type:'reserved',id,kind});
   if(kind==='eta')eta++;else compaction++;
   active=id;activeKind=kind;return id;
  });},
  observeAutomaticCompaction():Promise<void>{return serial(async()=>{
   // Preserve every observed event, including an out-of-contract runtime flood.
   // The harness immediately kills the owner on the first unexpected event.
   stopped=true;await append({type:'automatic_compaction',etaAdmission:activeKind==='eta'?active:null,ordinal:compaction+1});
   compaction++;
   if(activeKind!=='eta'||compaction>compactionLimit)throw Error('TRIAL_AUTOMATIC_COMPACTION_VIOLATION');
  });},
  settle(id:string,status:Completion):Promise<void>{return serial(async()=>{
   if(id!==active||!['completed','failed','unconfirmed'].includes(status))throw Error('TRIAL_SETTLEMENT_INVALID');
   // A completed operation with unknown tokens is still completed here. Usage
   // completeness remains in the existing independent accounting/receipt log.
   await append({type:'terminal',id,status});active=undefined;activeKind=undefined;
   if(status!=='completed')stopped=true;
  });},
  close():Promise<void>{
   if(closePromise)return closePromise;closing=true;
   closePromise=(async()=>{await tail;await file.close();})();return closePromise;
  },
 };
}
