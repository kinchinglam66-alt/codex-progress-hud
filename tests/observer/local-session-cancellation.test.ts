import {expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:vi.fn(actual.open)};
});
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';

it('lets an aborted stuck read release its conversation lane without accepting its late cursor',async()=>{
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const root=await fs.mkdtemp(join(tmpdir(),'hud-cancel-lane-'));
  const thread='11111111-1111-4111-8111-111111111111';
  const directory=join(root,'2026','09','10');await fs.mkdir(directory,{recursive:true});
  const filename=join(directory,`rollout-2026-09-10T00-00-00-${thread}.jsonl`);
  const line=(type:string,payload:unknown)=>JSON.stringify({type,payload,timestamp:'2026-09-10T00:00:00Z'})+'\n';
  await fs.writeFile(filename,line('session_meta',{id:thread})+line('response_item',{
    type:'message',role:'user',turn_id:'current',content:[{type:'input_text',text:'Build a report'}]}));
  let enter!:()=>void,release!:()=>Promise<void>;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  vi.mocked(fs.open).mockImplementationOnce((...args)=>new Promise((resolve,reject)=>{
    release=()=>actual.open(...args).then(resolve,reject);enter();
  }));
  const reader=createLocalSessionReader({root});const controller=new AbortController();
  const first=reader.read(thread,controller.signal);void first.catch(()=>{});
  await entered;controller.abort();
  const second=reader.read(thread,new AbortController().signal);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    const outcome=await Promise.race([second,new Promise<'blocked'>(resolve=>{timeout=setTimeout(()=>resolve('blocked'),1000);})]);
    expect(outcome).toMatchObject({caughtUp:true,records:[{kind:'user',turnId:'current',text:'Build a report'}]});
  }finally{
    if(timeout!==undefined)clearTimeout(timeout);
    await release();await Promise.allSettled([first,second]);
    // The obsolete first read must not overwrite the successful retry cursor.
    const next=await reader.read(thread,new AbortController().signal);
    expect(next.records).toEqual([]);
    await reader.close();vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});
  }
});
