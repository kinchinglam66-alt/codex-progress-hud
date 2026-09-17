import {lstat,mkdir,realpath} from 'node:fs/promises';
import {basename,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openNativeTrialBudget,type NativeApprovedTrialId} from '../estimation/native-trial-budget.js';
export interface NativeTrialBinding {accountFingerprint:string;routeFingerprint:string;assetsFingerprint:string}
interface TrialOptions {runtimeHome:string;binding:NativeTrialBinding;verifyStorage:()=>Promise<void>}
const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
/** Exactly one approved authority under the independently attested home.
 * Report directories are intentionally not inputs. Changing accounts does not
 * create another trial: any existing audit is a permanent stop for this run. */
export async function openApprovedNativeTrial(options:TrialOptions){
 return openFixedNativeTrial(options,'native-context-20260915-r10');
}
export async function openApprovedNativeLocalization(options:TrialOptions){
 return openFixedNativeTrial(options,'native-compression-20260915-r11');
}
export async function openApprovedNativeLocalizationR12(options:TrialOptions){
 return openFixedNativeTrial(options,'native-compression-20260915-r12');
}
export async function openApprovedNativeLocalizationR13(options:TrialOptions){
 return openFixedNativeTrial(options,'native-compression-20260915-r13');
}
/** User granted continuing synthetic ETA/compaction experiments on 2026-09-15.
 * Each experiment remains independently audited; no old audit is reopened. */
export async function openApprovedNativeLocalizationSeries(options:TrialOptions){
 const approvedTrialId:NativeApprovedTrialId=`native-localization-20260915-${randomUUID()}`;
 return {...await openFixedNativeTrial(options,approvedTrialId),approvedTrialId};
}
export async function openApprovedNativeComparisonSeries(options:TrialOptions,stratum:'85KiB'|'1MiB'='85KiB'){
 if(stratum!=='85KiB'&&stratum!=='1MiB')throw Error('TRIAL_STRATUM_INVALID');
 const approvedTrialId:NativeApprovedTrialId=`native-comparison-20260915-${stratum==='1MiB'?'large-':''}${randomUUID()}`;
 return {...await openFixedNativeTrial(options,approvedTrialId),approvedTrialId};
}
async function openFixedNativeTrial(options:TrialOptions,approvedTrialId:NativeApprovedTrialId){
 const binding={...options.binding};
 if(Object.keys(binding).length!==3||!['accountFingerprint','routeFingerprint','assetsFingerprint'].every(key=>
  /^[a-f0-9]{64}$/.test(binding[key as keyof NativeTrialBinding]??'')))throw Error('TRIAL_BINDING_INVALID');
 if(!isAbsolute(options.runtimeHome)||basename(options.runtimeHome).toLowerCase()!=='observer-auth')throw Error('TRIAL_AUTHORITY_INVALID');
 await options.verifyStorage();
 const directory=join(options.runtimeHome,'hud-native','custody');
 for(const path of [options.runtimeHome,join(options.runtimeHome,'hud-native'),directory]){
  const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||canonical(await realpath(path))!==canonical(path))throw Error('TRIAL_AUTHORITY_INVALID');
 }
 // User authorized subsequent necessary model diagnostics on 2026-09-15.
 // Each bounded experiment still has a separate non-reopenable audit.
 const budget=await openNativeTrialBudget(directory,{approvedTrialId,binding});
 const ledgerDirectory=join(directory,`${approvedTrialId}-ledger`);
 try{await mkdir(ledgerDirectory);await options.verifyStorage();}
 catch(error){await budget.close();throw error;}
 return {budget,ledgerDirectory};
}
