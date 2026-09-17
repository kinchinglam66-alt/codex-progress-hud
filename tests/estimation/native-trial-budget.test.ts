import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openNativeTrialBudget} from '../../src/estimation/native-trial-budget.js';
const roots:string[]=[];
const fixture=async()=>{const root=await mkdtemp(join(tmpdir(),'hud-native-budget-'));roots.push(root);return root;};
afterEach(async()=>{for(const root of roots.splice(0)){
 if(!root.startsWith(join(tmpdir(),'hud-native-budget-')))throw Error('UNSAFE_CLEANUP');await rm(root,{recursive:true,force:true});
}});
it('audits a separately identified large comparison with twenty-four compression slots and six ETA slots',async()=>{
 const root=await fixture(),binding={accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)};
 const authority={approvedTrialId:'native-comparison-20260915-large-11111111-1111-4111-8111-111111111111' as const,binding};
 const budget=await openNativeTrialBudget(root,authority);
 try{
  for(let i=0;i<21;i++){const id=await budget.reserve('compaction');await budget.settle(id,'completed');}
  for(let i=0;i<6;i++){const id=await budget.reserve('eta');await budget.settle(id,'completed');}
  await expect(budget.reserve('eta')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  for(let i=0;i<3;i++){const id=await budget.reserve('compaction');await budget.settle(id,'completed');}
  await expect(budget.reserve('compaction')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  expect(budget.snapshot()).toMatchObject({eta:6,compaction:24,inFlight:false});
 }finally{await budget.close();}
 await expect(openNativeTrialBudget(root,authority)).rejects.toThrow('TRIAL_ALREADY_STARTED');
 const first=JSON.parse((await readFile(join(root,authority.approvedTrialId+'-budget.jsonl'),'utf8')).split('\n')[0]!);
 expect(first).toMatchObject({etaLimit:6,compactionLimit:24,synthetic:true});
});
it('durably caps ETA and compression separately at six, without recycling spent slots',async()=>{
 const root=await fixture(),budget=await openNativeTrialBudget(root);
 try{
  for(let i=0;i<6;i++)for(const kind of ['eta','compaction'] as const){const id=await budget.reserve(kind);await budget.settle(id,'completed');}
  expect(budget.snapshot()).toMatchObject({eta:6,compaction:6,inFlight:false});
  await expect(budget.reserve('eta')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  await expect(budget.reserve('compaction')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  const records=(await readFile(join(root,'native-trial-budget.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  expect(records.filter(x=>x.type==='reserved')).toHaveLength(12);
 }finally{await budget.close();}
});
it('caps the fixed localization experiment at three ETA and one explicit compression',async()=>{
 const root=await fixture(),binding={accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)};
 const budget=await openNativeTrialBudget(root,{approvedTrialId:'native-compression-20260915-r11',binding});
 try{
  const raw=await budget.reserve('eta');await budget.settle(raw,'completed');
  const compact=await budget.reserve('compaction');await budget.settle(compact,'completed');
  for(let i=0;i<2;i++){const id=await budget.reserve('eta');await budget.settle(id,'completed');}
  await expect(budget.reserve('eta')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  await expect(budget.reserve('compaction')).rejects.toThrow('TRIAL_BUDGET_EXHAUSTED');
  expect(budget.snapshot()).toMatchObject({eta:3,compaction:1,inFlight:false});
 }finally{await budget.close();}
 await expect(openNativeTrialBudget(root,{approvedTrialId:'native-compression-20260915-r11',binding})).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it('stops after failure or unconfirmed completion and never restarts an existing audit',async()=>{
 for(const status of ['failed','unconfirmed'] as const){
  const root=await fixture(),budget=await openNativeTrialBudget(root),id=await budget.reserve('eta');
  await budget.settle(id,status);await expect(budget.reserve('eta')).rejects.toThrow('TRIAL_STOPPED');
  await budget.close();await expect(openNativeTrialBudget(root)).rejects.toThrow('TRIAL_ALREADY_STARTED');
 }
});
it('rejects concurrent reservations and retains a crash-like unfinished reservation',async()=>{
 const root=await fixture(),budget=await openNativeTrialBudget(root);
 const results=await Promise.allSettled([budget.reserve('eta'),budget.reserve('eta')]);
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(budget.snapshot().eta).toBe(1);
 await budget.close();await expect(openNativeTrialBudget(root)).rejects.toThrow('TRIAL_ALREADY_STARTED');
});
it('records an automatic compaction nested in ETA and stops further admissions',async()=>{
 const root=await fixture(),budget=await openNativeTrialBudget(root);
 try{
  for(let i=0;i<5;i++){const id=await budget.reserve('compaction');await budget.settle(id,'completed');}
  const eta=await budget.reserve('eta');
  await budget.observeAutomaticCompaction();
  expect(budget.snapshot()).toMatchObject({eta:1,compaction:6,inFlight:true,stopped:true});
  await budget.settle(eta,'failed');
  await expect(budget.reserve('eta')).rejects.toThrow('TRIAL_STOPPED');
  const rows=(await readFile(join(root,'native-trial-budget.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));
  expect(rows.filter(row=>row.type==='automatic_compaction')).toHaveLength(1);
 }finally{await budget.close();}
});
it('reserves room for one automatic compaction before dispatching an ETA',async()=>{
 const root=await fixture(),budget=await openNativeTrialBudget(root);
 try{
  for(let i=0;i<6;i++){const id=await budget.reserve('compaction');await budget.settle(id,'completed');}
  await expect(budget.reserve('eta')).rejects.toThrow('TRIAL_COMPACTION_CONTINGENCY_EXHAUSTED');
  expect(budget.snapshot().eta).toBe(0);
 }finally{await budget.close();}
});
