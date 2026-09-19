import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPersistentReceiptJournal,preparationErrorCode} from '../../src/estimation/observer-persistent-receipt.js';
import {LocalSessionSourceError} from '../../src/observer/local-session-reader.js';

it.each(['source_identity_mismatch','source_closed','source_cancelled'] as const)('preserves the actual local reader error %s',code=>{
 expect(preparationErrorCode(new LocalSessionSourceError(code))).toBe(code);
});
it.each(['SOURCE_SNAPSHOT_INCOMPLETE','SOURCE_HISTORY_BINDING_CHANGED','GOAL_TICKET_STALE','INVALID_OBSERVER_INPUT','SOURCE_ACK_INVALID'])('persists bounded import failure %s',async code=>{
 const root=await mkdtemp(join(tmpdir(),'hud-import-code-'));
 try{
  const journal=createPersistentReceiptJournal(root);
  await journal.preparationFailed!({ownerUuid:randomUUID(),sourceKey:'synthetic',generation:0,stage:'source_revalidation',
   code:preparationErrorCode(Object.assign(Error('PRIVATE_SOURCE_TEXT'),{code}))});
  const raw=await readFile(join(root,'persistent-session-receipts.jsonl'),'utf8');
  expect(JSON.parse(raw)).toMatchObject({kind:'preparation_failure',stage:'source_revalidation',code});
  expect(raw).not.toContain('PRIVATE_SOURCE_TEXT');
 }finally{await rm(root,{recursive:true,force:true});}
});

it.each(['NATIVE_SNAPSHOT_CUSTODY_PATH','NATIVE_SNAPSHOT_CUSTODY_REPLACED','NATIVE_BASE_BINDING_CHANGED','NATIVE_RESOURCE_FORK_LOG_UNKNOWN'])('preserves the bounded native preparation code %s',code=>{
 expect(preparationErrorCode(Object.assign(Error('private path and account details'),{code}))).toBe(code);
 expect(preparationErrorCode(Error(code))).toBe(code);
});
it('ignores arbitrary, suffixed and accessor error codes without exposing private text',()=>{
 for(const code of ['private credential','NATIVE_SNAPSHOT_CUSTODY_PATH secret','NATIVE_NEW_PRIVATE_VALUE']){
  expect(preparationErrorCode(Object.assign(Error('private text'),{code}))).toBe('PREPARATION_UNKNOWN');
 }
 const error=Error('private text');Object.defineProperty(error,'code',{get(){throw Error('must not execute diagnostic getter');}});
 expect(preparationErrorCode(error)).toBe('PREPARATION_UNKNOWN');
});
it('persists a structured custody failure without its private message',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hud-preparation-code-'));
 try{
  const journal=createPersistentReceiptJournal(root);
  await journal.preparationFailed!({ownerUuid:randomUUID(),sourceKey:'synthetic',generation:0,stage:'session_setup',
   code:preparationErrorCode(Object.assign(Error('PRIVATE_PATH'),{code:'NATIVE_SNAPSHOT_CUSTODY_PATH'}))});
  const raw=await readFile(join(root,'persistent-session-receipts.jsonl'),'utf8');
  expect(JSON.parse(raw)).toMatchObject({kind:'preparation_failure',code:'NATIVE_SNAPSHOT_CUSTODY_PATH'});
  expect(raw).not.toContain('PRIVATE_PATH');
 }finally{await rm(root,{recursive:true,force:true});}
});
