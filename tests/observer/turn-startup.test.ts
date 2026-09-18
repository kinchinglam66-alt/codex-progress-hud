import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,open,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';
import {createContextOwner} from '../../src/observer/context-owner.js';

const id='11111111-1111-4111-8111-111111111111';
const line=(type:string,payload:unknown)=>JSON.stringify({timestamp:'2026-09-18T00:00:00Z',type,payload})+'\n';
const start=(turn:string)=>line('event_msg',{type:'task_started',turn_id:turn});
const user=(turn:string,text:string)=>line('response_item',{type:'message',role:'user',turn_id:turn,content:[{type:'input_text',text}]});
const checkpoint=line('compacted',{replacement_history:[{type:'compaction',encrypted_content:'opaque-fixture'},
 {type:'message',role:'user',content:[{type:'input_text',text:'retained history'}]}]});

it.each(['truncate','replace'] as const)('resets a bootstrapped projection after source %s',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'hud-turn-startup-'));
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 await writeFile(path,line('session_meta',{id})+user('old','x'.repeat(32000)).repeat(280)+checkpoint+
  start('target')+user('target','initial instruction'));
 const reader=createLocalSessionReader({root}),signal=new AbortController().signal;
 try{
  expect((await reader.read(id,signal,turn=>turn==='target')).caughtUp).toBe(true);
  if(mode==='replace')await rename(path,join(root,'retired.jsonl'));
  await writeFile(path,line('session_meta',{id})+start('new')+user('new','replacement instruction'));
  const batch=await reader.read(id,signal,turn=>turn==='new');
  expect(batch.reset).toBe(true);
  expect(batch.records.some(r=>r.turnId==='target')).toBe(false);
  expect(batch.records.some(r=>r.turnId==='new'&&r.text==='replacement instruction')).toBe(true);
 }finally{
  await reader.close();
  if(!root.startsWith(join(tmpdir(),'hud-turn-startup-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});

it('does not retain a partially bootstrapped cursor after cancellation during I/O',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hud-turn-startup-'));
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 const prefix=line('session_meta',{id})+user('old','x'.repeat(32000)).repeat(280)+checkpoint;
 await writeFile(path,prefix+start('target')+user('target','instruction'));
 const handle=await open(path,'r'),prototype=Object.getPrototypeOf(handle),original=prototype.read;
 const controller=new AbortController();
 const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:unknown,...args:unknown[]){
  const result=await original.apply(this,args);
  if(args[3]===Buffer.byteLength(prefix))controller.abort();
  return result;
 });
 const reader=createLocalSessionReader({root});
 try{
  await expect(reader.read(id,controller.signal,turn=>turn==='target')).rejects.toMatchObject({code:'source_cancelled'});
  spy.mockRestore();
  const result=await reader.read(id,new AbortController().signal,turn=>turn==='target');
  expect(result.caughtUp).toBe(true);
  expect(result.records.some(r=>r.turnId==='target'&&r.runtime==='running')).toBe(true);
 }finally{
  spy.mockRestore();await reader.close();await handle.close();
  if(!root.startsWith(join(tmpdir(),'hud-turn-startup-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});

it('preserves full native acquisition for a history within its existing byte limit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hud-turn-startup-'));
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 await writeFile(path,line('session_meta',{id})+start('old')+user('old','x'.repeat(32000)).repeat(150)+
  line('event_msg',{type:'task_complete',turn_id:'old'})+start('target')+user('target','instruction'));
 const reader=createLocalSessionReader({root}),signal=new AbortController().signal;
 let native;
 try{
  for(let i=0;i<4;i++){if((await reader.read(id,signal,turn=>turn==='target')).caughtUp)break;}
  native=await reader.openNativeTurn(id,signal);
  expect(native.currentTurnId).toBe('target');
 }finally{
  await native?.close();await reader.close();
  if(!root.startsWith(join(tmpdir(),'hud-turn-startup-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});

it.each(['missing','malformed','partial','cancelled'] as const)('does not infer a complete bound turn from %s input',async kind=>{
 const root=await mkdtemp(join(tmpdir(),'hud-turn-startup-'));
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 await writeFile(path,line('session_meta',{id})+user('old','x'.repeat(32000)).repeat(280)+checkpoint+
  start(kind==='missing'?'other':'target')+user(kind==='missing'?'other':'target','instruction')+
  (kind==='malformed'?'invalid json\n':kind==='partial'?'{"type":':'') );
 const reader=createLocalSessionReader({root}),controller=new AbortController();
 if(kind==='cancelled')controller.abort();
 try{
  const reading=reader.read(id,controller.signal,turn=>turn==='target');
  if(kind==='partial'){
   const batch=await reading;
   expect(batch).toMatchObject({caughtUp:false,partialLine:true,historyTruncated:true});
   expect(batch.records.some(r=>r.turnId==='target'&&r.kind==='user')).toBe(true);
  }else await expect(reading).rejects.toMatchObject({code:kind==='missing'?'source_unobserved':kind==='malformed'?'source_malformed':'source_cancelled'});
 }finally{
  await reader.close();
  if(!root.startsWith(join(tmpdir(),'hud-turn-startup-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});

it('revalidates the start boundary after a same-size rewrite during bootstrap',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hud-turn-startup-'));
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 const prefix=line('session_meta',{id})+user('old','x'.repeat(32000)).repeat(280)+checkpoint;
 const beginning=start('target');
 await writeFile(path,prefix+beginning+user('target','instruction'));
 const writer=await open(path,'r+'),prototype=Object.getPrototypeOf(writer),original=prototype.read;
 let readsAtStart=0;
 const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:unknown,...args:unknown[]){
  const result=await original.apply(this,args);
  if(args[3]===Buffer.byteLength(prefix)&&++readsAtStart===2){
   const replacement=Buffer.from(beginning.replace('task_started','task_ignored'));
   await writer.write(replacement,0,replacement.length,Buffer.byteLength(prefix));
  }
  return result;
 });
 const reader=createLocalSessionReader({root}),signal=new AbortController().signal;
 try{
  await expect(reader.read(id,signal,turn=>turn==='target')).rejects.toMatchObject({code:'source_identity_mismatch'});
  spy.mockRestore();
  await expect(reader.read(id,signal,turn=>turn==='target')).rejects.toMatchObject({code:'source_unobserved'});
 }finally{
  spy.mockRestore();await reader.close();await writer.close();
  if(!root.startsWith(join(tmpdir(),'hud-turn-startup-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});

it.each([false,true])('bootstraps the bound turn without scanning superseded history (mid-turn checkpoint=%s)',async midTurn=>{
 const root=await mkdtemp(join(tmpdir(),'hud-turn-startup-'));
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 const old=user('old','x'.repeat(32000));
 await writeFile(path,line('session_meta',{id})+start('old')+old.repeat(280)+
  (midTurn?'':checkpoint)+start('target')+user('target','target instruction')+
  (midTurn?checkpoint:'')+line('event_msg',{type:'task_complete',turn_id:'target'})+
  start('newer')+user('newer','do not confuse with target'));
 const handle=await open(path,'r'),prototype=Object.getPrototypeOf(handle),original=prototype.read;
 let bytes=0;
 const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:unknown,...args:unknown[]){
  const result=await original.apply(this,args);bytes+=result.bytesRead;return result;
 });
 const reader=createLocalSessionReader({root});let now=0;
 const owner=createContextOwner({source:reader,now:()=>now,turnKeyFor:(_host,turn)=>`bound:${turn}`});
 try{
  owner.attach('key',id,'bound:target');now=500;owner.tick();
  await vi.waitFor(()=>expect(owner.snapshot('key')?.health).toBe('ready'),{timeout:1500});
  const snapshot=owner.snapshot('key')!;
  expect(snapshot.records.some(r=>r.kind==='user'&&r.turnId==='target'&&r.text==='target instruction')).toBe(true);
  expect(snapshot.records.some(r=>r.kind==='runtime'&&r.turnId==='target'&&r.runtime==='waiting')).toBe(true);
  expect(snapshot.records.some(r=>r.turnId==='old')).toBe(false);
  expect(snapshot.historyComplete).toBe(false);
  expect(bytes).toBeLessThan(1024*1024);
  await expect(reader.openNativeTurn(id,new AbortController().signal)).rejects.toMatchObject({code:'source_unobserved'});
  const full=await reader.snapshot(id,new AbortController().signal);
  try{
   expect(full.checkpoint?.items[1]).toMatchObject({content:[{text:'retained history'}]});
   for await(const _record of full.records(new AbortController().signal)){/* validate complete suffix */}
   expect(full.coverage).toEqual({complete:true,gaps:[]});
  }finally{await full.close();}
 }finally{
  spy.mockRestore();await owner.close();await handle.close();
  if(!root.startsWith(join(tmpdir(),'hud-turn-startup-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});
