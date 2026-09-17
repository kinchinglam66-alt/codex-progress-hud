import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {openApprovedNativeTrial,openApprovedNativeLocalization,openApprovedNativeLocalizationR12,openApprovedNativeLocalizationR13,openApprovedNativeLocalizationSeries,openApprovedNativeComparisonSeries} from '../../src/evaluation/native-trial-authority.js';
const roots:string[]=[];
const binding={accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)};
it('uses a fresh bound large-series audit only for the explicit 1MiB stratum',async()=>{
 const {runtimeHome}=await fixture(),options={runtimeHome,binding,verifyStorage:async()=>{}};
 const normal=await openApprovedNativeComparisonSeries(options);await normal.budget.close();
 const normalPath=join(runtimeHome,'hud-native','custody',normal.approvedTrialId+'-budget.jsonl');
 const prior=await readFile(normalPath,'utf8');
 const large=await openApprovedNativeComparisonSeries(options,'1MiB');
 try{
  const header=JSON.parse((await readFile(join(runtimeHome,'hud-native','custody',large.approvedTrialId+'-budget.jsonl'),'utf8')).split('\n')[0]!);
  expect(header).toMatchObject({etaLimit:6,compactionLimit:24,binding});
  for(let i=0;i<7;i++){const id=await large.budget.reserve('compaction');await large.budget.settle(id,'completed');}
  const id=await large.budget.reserve('eta');await large.budget.settle(id,'failed');
  await expect(large.budget.reserve('eta')).rejects.toThrow('TRIAL_STOPPED');
 }finally{await large.budget.close();}
 expect(await readFile(normalPath,'utf8')).toBe(prior);
 await expect(openApprovedNativeComparisonSeries(options,'arbitrary' as any)).rejects.toThrow('TRIAL_STRATUM_INVALID');
});
it('allocates a comparison series with six-pair-operation caps and never reopens spent r10',async()=>{
 const {runtimeHome}=await fixture(),options={runtimeHome,binding,verifyStorage:async()=>{}};
 const old=await openApprovedNativeTrial(options);await old.budget.close();
 const oldPath=join(runtimeHome,'hud-native','custody','native-context-20260915-r10-budget.jsonl'),prior=await readFile(oldPath,'utf8');
 const ids:string[]=[];
 for(let round=0;round<2;round++){
  const trial=await openApprovedNativeComparisonSeries(options);ids.push(trial.approvedTrialId);
  try{
   expect(trial.approvedTrialId).toMatch(/^native-comparison-20260915-[a-f0-9-]{36}$/);
   for(let i=0;i<6;i++){const id=await trial.budget.reserve('eta');await trial.budget.settle(id,'completed');}
   await expect(trial.budget.reserve('eta')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
   for(let i=0;i<6;i++){const id=await trial.budget.reserve('compaction');await trial.budget.settle(id,'completed');}
   await expect(trial.budget.reserve('compaction')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  }finally{await trial.budget.close();}
 }
 expect(ids[0]).not.toBe(ids[1]);expect(await readFile(oldPath,'utf8')).toBe(prior);
 await expect(openApprovedNativeTrial(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it('allocates separate audited experiments under continuing user authority without changing spent r13',async()=>{
 const {runtimeHome}=await fixture(),options={runtimeHome,binding,verifyStorage:async()=>{}};
 const old=await openApprovedNativeLocalizationR13(options);await old.budget.close();
 const oldPath=join(runtimeHome,'hud-native','custody','native-compression-20260915-r13-budget.jsonl'),prior=await readFile(oldPath,'utf8');
 const ids:string[]=[];
 for(let round=0;round<2;round++){
  const trial=await openApprovedNativeLocalizationSeries(options);ids.push(trial.approvedTrialId);
  try{
   expect(trial.approvedTrialId).toMatch(/^native-localization-20260915-[a-f0-9-]{36}$/);
   for(const kind of ['eta','compaction','eta','eta'] as const){const id=await trial.budget.reserve(kind);await trial.budget.settle(id,'completed');}
   await expect(trial.budget.reserve('eta')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
   const header=JSON.parse((await readFile(join(runtimeHome,'hud-native','custody',trial.approvedTrialId+'-budget.jsonl'),'utf8')).split('\n')[0]!);
   expect(header).toMatchObject({approvedTrialId:trial.approvedTrialId,etaLimit:3,compactionLimit:1,binding});
  }finally{await trial.budget.close();}
 }
 expect(ids[0]).not.toBe(ids[1]);expect(await readFile(oldPath,'utf8')).toBe(prior);
 await expect(openApprovedNativeLocalizationR13(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it.each([
 {oldId:'r11',newId:'r12',openOld:openApprovedNativeLocalization,openNew:openApprovedNativeLocalizationR12},
 {oldId:'r12',newId:'r13',openOld:openApprovedNativeLocalizationR12,openNew:openApprovedNativeLocalizationR13},
])('uses renewed $newId without reopening $oldId or enlarging the three-by-one cap',async({oldId,newId,openOld,openNew})=>{
 const {runtimeHome}=await fixture(),options={runtimeHome,binding,verifyStorage:async()=>{}};
 const old=await openOld(options);await old.budget.close();
 const oldPath=join(runtimeHome,'hud-native','custody',`native-compression-20260915-${oldId}-budget.jsonl`);
 const prior=await readFile(oldPath,'utf8');const next=await openNew(options);
 try{
  const header=JSON.parse((await readFile(join(runtimeHome,'hud-native','custody',`native-compression-20260915-${newId}-budget.jsonl`),'utf8')).split('\n')[0]!);
  expect(header).toMatchObject({approvedTrialId:`native-compression-20260915-${newId}`,etaLimit:3,compactionLimit:1,binding});
  for(const kind of ['eta','compaction','eta','eta'] as const){const id=await next.budget.reserve(kind);await next.budget.settle(id,'completed');}
  await expect(next.budget.reserve('eta')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  await expect(next.budget.reserve('compaction')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
 }finally{await next.budget.close();}
 expect(await readFile(oldPath,'utf8')).toBe(prior);
 await expect(openNew(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
 await expect(openOld(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
afterEach(async()=>{for(const root of roots.splice(0)){if(!basename(root).startsWith('hud-trial-authority-')||!resolve(root).startsWith(resolve(tmpdir())))throw Error('UNSAFE_CLEANUP');await rm(root,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'hud-trial-authority-'));roots.push(root);const runtimeHome=join(root,'observer-auth');await mkdir(join(runtimeHome,'hud-native','custody'),{recursive:true});return {root,runtimeHome};}
it('keeps localization in its own non-reopenable account-bound three-by-one audit',async()=>{
 const {runtimeHome}=await fixture(),options={runtimeHome,binding,verifyStorage:async()=>{}};
 const old=await openApprovedNativeTrial(options);await old.budget.close();
 const trial=await openApprovedNativeLocalization(options);await trial.budget.close();
 const header=JSON.parse((await readFile(join(runtimeHome,'hud-native','custody','native-compression-20260915-r11-budget.jsonl'),'utf8')).split('\n')[0]!);
 expect(header).toMatchObject({approvedTrialId:'native-compression-20260915-r11',etaLimit:3,compactionLimit:1,binding});
 await expect(openApprovedNativeLocalization(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
 await expect(openApprovedNativeTrial(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it('uses one account-bound authority independent of report location',async()=>{
 const {root,runtimeHome}=await fixture();const options={runtimeHome,binding,verifyStorage:async()=>undefined};
 // Reports can be stored anywhere, but are not an input to admission authority.
 await mkdir(join(root,'report-a'));const first=await openApprovedNativeTrial(options);
 const id=await first.budget.reserve('eta');await first.budget.settle(id,'completed');await first.budget.close();
 expect(first.ledgerDirectory).toBe(join(runtimeHome,'hud-native','custody','native-context-20260915-r10-ledger'));
 const header=JSON.parse((await readFile(join(runtimeHome,'hud-native','custody','native-context-20260915-r10-budget.jsonl'),'utf8')).split('\n')[0]!);
 expect(header.binding).toEqual(binding);expect(header.approvedTrialId).toBe('native-context-20260915-r10');
 await mkdir(join(root,'report-b'));await expect(openApprovedNativeTrial(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
 await expect(openApprovedNativeTrial({...options,binding:{...binding,accountFingerprint:'d'.repeat(64)}})).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it('uses renewed explicit authority without reopening or modifying either spent audit',async()=>{
 const {runtimeHome}=await fixture(),custody=join(runtimeHome,'hud-native','custody');
 const oldBudget=join(custody,'native-trial-budget.jsonl'),oldLedger=join(custody,'native-context-20260914-ledger');
 const prior='{"type":"reserved","kind":"eta","status":"unconfirmed"}\n';
 await writeFile(oldBudget,prior,{flag:'wx'});await mkdir(oldLedger);
 await writeFile(join(oldLedger,'sentinel.jsonl'),prior,{flag:'wx'});
 const secondBudget=join(custody,'native-context-20260915-budget.jsonl'),secondLedger=join(custody,'native-context-20260915-ledger');
 await writeFile(secondBudget,prior,{flag:'wx'});await mkdir(secondLedger);
 await writeFile(join(secondLedger,'sentinel.jsonl'),prior,{flag:'wx'});
 const thirdBudget=join(custody,'native-context-20260915-r3-budget.jsonl');
 await writeFile(thirdBudget,prior,{flag:'wx'});
 const diagnosticBudgets=['r4','r5','r6','r7','r8','r9'].map(id=>join(custody,`native-context-20260915-${id}-budget.jsonl`));
 for(const path of diagnosticBudgets)await writeFile(path,prior,{flag:'wx'});
 const options={runtimeHome,binding,verifyStorage:async()=>undefined};
 const trial=await openApprovedNativeTrial(options);await trial.budget.close();
 expect(await readFile(oldBudget,'utf8')).toBe(prior);
 expect(await readFile(join(oldLedger,'sentinel.jsonl'),'utf8')).toBe(prior);
 expect(await readFile(secondBudget,'utf8')).toBe(prior);
 expect(await readFile(join(secondLedger,'sentinel.jsonl'),'utf8')).toBe(prior);
 expect(await readFile(thirdBudget,'utf8')).toBe(prior);
 for(const path of diagnosticBudgets)expect(await readFile(path,'utf8')).toBe(prior);
 await expect(openApprovedNativeTrial(options)).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it('refuses missing account binding or failed storage attestation before creating an audit',async()=>{
 const {runtimeHome}=await fixture();
 await expect(openApprovedNativeTrial({runtimeHome,binding:{...binding,accountFingerprint:'unknown'},verifyStorage:async()=>undefined})).rejects.toThrow('TRIAL_BINDING_INVALID');
 await expect(openApprovedNativeTrial({runtimeHome,binding,verifyStorage:async()=>{throw Error('UNATTESTED');}})).rejects.toThrow('UNATTESTED');
 await expect(readFile(join(runtimeHome,'hud-native','custody','native-context-20260915-r10-budget.jsonl'))).rejects.toMatchObject({code:'ENOENT'});
});
