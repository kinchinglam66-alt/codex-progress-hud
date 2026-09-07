import {it,expect,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:vi.fn(actual.open)};
});

it('rejects foreign content swapped between discovery and opening the read handle',async()=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'hud-source-race-'));
  const root=join(directory,'sessions'),day=join(root,'2026','09','06');
  const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
  const path=join(day,`rollout-2026-09-06T00-00-00-${id}.jsonl`);
  const frame=(type:string,payload:unknown)=>JSON.stringify({timestamp:0,type,payload})+'\n';
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const reader=createLocalSessionReader({root});let opens=0;
  try{
    await fs.mkdir(day,{recursive:true});await fs.writeFile(path,frame('session_meta',{id}));
    vi.mocked(fs.open).mockImplementation(async(file,flags,mode)=>{
      if(file===path&&++opens===2)await actual.writeFile(path,frame('session_meta',{id:other})+
        frame('response_item',{type:'message',role:'user',id:'foreign',content:[{type:'input_text',text:'FOREIGN_PRIVATE'}]}));
      return actual.open(file,flags,mode);
    });
    await expect(reader.read(id,new AbortController().signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
  }finally{vi.mocked(fs.open).mockImplementation(actual.open);await reader.close();await fs.rm(directory,{recursive:true,force:true});}
});
