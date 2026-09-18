import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';

it('locates the latest checkpoint without rereading superseded megabytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hud-checkpoint-tail-'));
 const id='11111111-1111-4111-8111-111111111111';
 const dir=join(root,'2026','09','18');await mkdir(dir,{recursive:true});
 const line=(type:string,payload:unknown)=>JSON.stringify({timestamp:'2026-09-18T00:00:00Z',type,payload})+'\n';
 const path=join(dir,`rollout-2026-09-18-${id}.jsonl`);
 const checkpoint=line('compacted',{replacement_history:[{type:'compaction',encrypted_content:'opaque-fixture'},
  {type:'message',role:'user',content:[{type:'input_text',text:'retained fact'}]}]});
 const old=line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(32000)}]});
 await writeFile(path,line('session_meta',{id})+old.repeat(280)+checkpoint+
  line('event_msg',{type:'task_started',turn_id:'current'})+
  line('response_item',{type:'message',role:'user',turn_id:'current',content:[{type:'input_text',text:'current request'}]}));
 const handle=await open(path,'r'),prototype=Object.getPrototypeOf(handle);
 const original=prototype.read;let bytes=0;
 const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:unknown,...args:unknown[]){
  const result=await original.apply(this,args);bytes+=result.bytesRead;return result;
 });
 const reader=createLocalSessionReader({root});let snapshot;
 try{
  snapshot=await reader.snapshot(id,new AbortController().signal);
  expect(snapshot.checkpoint?.items[1]).toMatchObject({content:[{text:'retained fact'}]});
  const records=[];for await(const item of snapshot.records(new AbortController().signal))records.push(item.record);
  expect(records.some(record=>record.text==='current request')).toBe(true);
  expect(snapshot.coverage).toEqual({complete:true,gaps:[]});
  expect(bytes).toBeLessThan(1024*1024);
 }finally{
  spy.mockRestore();await snapshot?.close();await reader.close();await handle.close();
  if(!root.startsWith(join(tmpdir(),'hud-checkpoint-tail-')))throw Error('UNSAFE_TEST_ROOT');
  await rm(root,{recursive:true,force:true});
 }
});
