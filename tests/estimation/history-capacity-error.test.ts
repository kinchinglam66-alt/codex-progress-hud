import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {historyCapacityError,historyCapacityDetail} from '../../src/estimation/history-capacity-error.js';
import {createPersistentReceiptJournal,preparationErrorCode} from '../../src/estimation/observer-persistent-receipt.js';

it.each(['checkpoint_window','attachment_manifest','source_budget_exhausted'] as const)('records bounded %s details while retaining the old code',async kind=>{
 const error=historyCapacityError(kind,2001,2000),capacity=historyCapacityDetail(error);
 expect(preparationErrorCode(error)).toBe('context_too_large');
 expect(capacity).toEqual({kind,observedBytes:2001,limitBytes:2000});
 expect(Object.isFrozen(capacity)).toBe(true);
 const root=await mkdtemp(join(tmpdir(),'hud-capacity-detail-'));
 try{
  const journal=createPersistentReceiptJournal(root);
  await journal.preparationFailed!({ownerUuid:randomUUID(),sourceKey:'synthetic',generation:0,stage:'history_import',code:preparationErrorCode(error),capacity});
  const row=JSON.parse(await readFile(join(root,'persistent-session-receipts.jsonl'),'utf8'));
  expect(row.capacity).toEqual(capacity);expect(row.code).toBe('context_too_large');
 }finally{await rm(root,{recursive:true,force:true});}
});
it.each([NaN,Infinity,-1,0,2.5,Number.MAX_SAFE_INTEGER+1,100])('does not persist invalid or non-exceeded byte count %s',bytes=>{
 expect(historyCapacityDetail(historyCapacityError('source_budget_exhausted',bytes,100))).toBeUndefined();
});
it('does not read arbitrary exception properties, proxies, or private messages',()=>{
 const untrusted=new Proxy(Error('context_too_large:PRIVATE_TEXT'),{get(){throw Error('getter executed');}});
 expect(historyCapacityDetail(untrusted)).toBeUndefined();
 expect(historyCapacityDetail({capacity:{kind:'source_budget_exhausted',observedBytes:2001,limitBytes:2000}})).toBeUndefined();
 expect(historyCapacityDetail(null)).toBeUndefined();
});
it('keeps legacy records without fabricated details and rejects extraneous fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hud-capacity-legacy-'));
 try{
  const journal=createPersistentReceiptJournal(root);
  const base={ownerUuid:randomUUID(),sourceKey:'synthetic',generation:0,stage:'history_import' as const,code:'context_too_large'};
  await journal.preparationFailed!(base);
  await expect(journal.preparationFailed!({...base,capacity:{kind:'source_budget_exhausted',observedBytes:2001,limitBytes:2000,privateText:'secret'} as any})).rejects.toThrow();
  const raw=await readFile(join(root,'persistent-session-receipts.jsonl'),'utf8');
  expect(JSON.parse(raw).capacity).toBeUndefined();expect(raw).not.toContain('secret');
 }finally{await rm(root,{recursive:true,force:true});}
});
