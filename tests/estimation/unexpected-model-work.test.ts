import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUnexpectedModelWorkStore} from '../../src/estimation/unexpected-model-work.js';

const incident={ownerUuid:'11111111-1111-4111-8111-111111111111',conversationKey:'source',generation:2,at:1000,pid:123,creationIdentity:'birth-123',reason:'turn/started' as const};
it('retains compacted totals and pending custody across a real database reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hud-unexpected-work-'));
 let db=new DatabaseSync(join(dir,'ledger.sqlite'));
 try{
  const store=createUnexpectedModelWorkStore(db);store.record(incident);
  for(let i=0;i<140;i++){
   const item={...incident,ownerUuid:randomUUID(),at:2000+i};
   store.record(item);store.confirmExit(item);
  }
  db.close();db=new DatabaseSync(join(dir,'ledger.sqlite'));
  const reopened=createUnexpectedModelWorkStore(db);
  expect(reopened.count()).toBe(141);expect(reopened.pending()).toEqual([incident]);
  reopened.confirmExit(incident);
  expect(reopened.count()).toBe(141);expect(reopened.pending()).toEqual([]);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
it('rolls back the archived count when deleting compacted detail fails',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const store=createUnexpectedModelWorkStore(db);
  for(let i=0;i<128;i++){
   const item={...incident,ownerUuid:randomUUID(),at:2000+i};
   store.record(item);store.confirmExit(item);
  }
  db.exec("CREATE TRIGGER prevent_delete BEFORE DELETE ON unexpected_model_work BEGIN SELECT RAISE(ABORT,'injected delete failure'); END");
  const item={...incident,ownerUuid:randomUUID(),at:3000};store.record(item);
  expect(()=>store.confirmExit(item)).toThrow('injected delete failure');
  expect(store.count()).toBe(129);
  expect(db.prepare('SELECT archived_count FROM unexpected_model_work_totals').get()!.archived_count).toBe(0);
  db.exec('DROP TRIGGER prevent_delete');
  expect(createUnexpectedModelWorkStore(db).count()).toBe(129);
  expect(db.prepare('SELECT COUNT(*) AS n FROM unexpected_model_work').get()!.n).toBe(128);
 }finally{db.close();}
});
it('compacts closed detail without losing cumulative unknown history or unresolved owners',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const store=createUnexpectedModelWorkStore(db);store.record(incident);
  let oldest;
  for(let i=0;i<140;i++){
   const closed={...incident,ownerUuid:randomUUID(),at:2000+i};oldest??=closed;
   store.record(closed);store.confirmExit(closed);
  }
  expect(store.count()).toBe(141);expect(store.pending()).toEqual([incident]);
  expect(Number(db.prepare('SELECT COUNT(*) AS n FROM unexpected_model_work').get()!.n)).toBeLessThanOrEqual(129);
  const reopened=createUnexpectedModelWorkStore(db);
  expect(reopened.count()).toBe(141);expect(reopened.pending()).toEqual([incident]);
  expect(()=>reopened.record(oldest!)).toThrow();expect(reopened.count()).toBe(141);
 }finally{db.close();}
});
it('retains unknown history after confirmed matching owner exit and rejects PID reuse',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const store=createUnexpectedModelWorkStore(db);store.record(incident);
  expect(store.pending()).toHaveLength(1);
  expect(()=>store.confirmExit({...incident,creationIdentity:'reused'})).toThrow();
  expect(store.pending()).toHaveLength(1);
  store.confirmExit(incident);
  expect(store.pending()).toHaveLength(0);expect(store.count()).toBe(1);
  expect(createUnexpectedModelWorkStore(db).pending()).toEqual([]);
 }finally{db.close();}
});
it('persists one unknown incident per process owner without creating an admission',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const store=createUnexpectedModelWorkStore(db);
  store.record(incident);store.record({...incident,reason:'thread/tokenUsage/updated'});
  expect(store.count()).toBe(1);
  expect(createUnexpectedModelWorkStore(db).count()).toBe(1);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admissions'").all()).toEqual([]);
  expect(db.prepare('SELECT reason FROM unexpected_model_work').get()).toMatchObject({reason:'turn/started'});
 }finally{db.close();}
});
it('rejects changed owner binding and unbounded notification details without losing prior evidence',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const store=createUnexpectedModelWorkStore(db);store.record(incident);
  expect(()=>store.record({...incident,conversationKey:'other'})).toThrow();
  expect(()=>store.record({...incident,reason:'PRIVATE RESPONSE' as any})).toThrow();
  expect(store.count()).toBe(1);
 }finally{db.close();}
});
