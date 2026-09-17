import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';
const id='11111111-1111-4111-8111-111111111111';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-reader-'));roots.push(root);
 const sourceRoot=join(root,'sessions'),destinationDirectory=join(root,'protected');
 await mkdir(join(sourceRoot,'2026','09','14'),{recursive:true});await mkdir(destinationDirectory);
 const sourcePath=join(sourceRoot,'2026','09','14',`rollout-2026-09-14-${id}.jsonl`);
 const data=[{type:'session_meta',payload:{id}},
  {type:'event_msg',payload:{type:'task_started',turn_id:'current'}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'current task'}]}}
 ].map(row=>JSON.stringify({timestamp:'2026-09-14T00:00:00Z',...row})).join('\n')+'\n';
 await writeFile(sourcePath,data);
 return {sourceRoot,destinationDirectory,sourcePath,data};
}
it('resolves native history by trusted discovered thread identity without parsed-history scanning',async()=>{
 const f=await fixture(),reader=createLocalSessionReader({root:f.sourceRoot});let verified=0;
 reader.snapshot=async()=>{throw Error('PARSED_HISTORY_MUST_NOT_BE_USED');};
 let snapshot;
 try{
  await reader.read(id,new AbortController().signal);
  snapshot=await reader.nativeSnapshot(id,new AbortController().signal,{destinationDirectory:f.destinationDirectory,maxSourceBytes:10000,verifyDestination:async()=>{verified++;}});
  expect(await readFile(snapshot.path,'utf8')).toBe(f.data);
  expect(snapshot.sourceThreadId).toBe(id);expect(verified).toBeGreaterThan(0);
 }finally{await snapshot?.close();await reader.close();}
});
it('does not copy a later turn persisted after the last authenticated local read',async()=>{
 const f=await fixture(),reader=createLocalSessionReader({root:f.sourceRoot}),signal=new AbortController().signal;
 let snapshot;
 try{
  const observed=await reader.read(id,signal);
  await appendFile(f.sourcePath,JSON.stringify({timestamp:'2026-09-14T00:01:00Z',type:'event_msg',payload:{type:'task_started',turn_id:'future'}})+'\n');
  snapshot=await reader.nativeSnapshot(id,signal,{destinationDirectory:f.destinationDirectory,maxSourceBytes:10000,verifyDestination:async()=>{}});
  expect(await readFile(snapshot.path,'utf8')).toBe(f.data);
  expect(snapshot.sourceTurnId).toBe(observed.records.find(row=>row.kind==='runtime')!.turnId);
 }finally{await snapshot?.close();await reader.close();}
});
it('requires a locally observed turn boundary before exposing a native snapshot',async()=>{
 const f=await fixture(),reader=createLocalSessionReader({root:f.sourceRoot});
 try{await expect(reader.nativeSnapshot(id,new AbortController().signal,{destinationDirectory:f.destinationDirectory,maxSourceBytes:10000,verifyDestination:async()=>{}})).rejects.toMatchObject({code:'source_unobserved'});}
 finally{await reader.close();}
});
it('cannot use a filename to bypass trusted thread discovery',async()=>{
 const f=await fixture(),reader=createLocalSessionReader({root:f.sourceRoot});
 try{await expect(reader.nativeSnapshot(f.sourcePath,new AbortController().signal,{destinationDirectory:f.destinationDirectory,maxSourceBytes:10000,verifyDestination:async()=>{}})).rejects.toMatchObject({code:'source_invalid_thread'});}
 finally{await reader.close();}
});
