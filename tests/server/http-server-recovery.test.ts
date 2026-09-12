import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProgressServer} from '../../src/server/http-server.js';
import {CompanionHttpClient} from '../../src/mcp/report-client.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {HudSnapshot} from '../../src/server/task-store.js';

it('restores the persisted native turn through two real servers without another inference',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hud-checkpoint-http-'));
  const root=join(directory,'sessions'),day=join(root,'2026','09','12'),tokenPath=join(directory,'auth.token');
  const id='01a0766f-e48a-70e0-b8a8-4abb83140175',turn='current';
  let mono=0,wall=1_800_000_000_000,calls=0;
  const make=()=>createProgressServer({port:0,tokenPath,observerSessionsRoot:root,now:()=>wall,monotonicNow:()=>mono,
    isGoalCheckpointOwner:async()=>true,
    observerWorkers:[{status:()=>({active:false,disabled:false,poisoned:false}),disable(){},async close(){},
      async observe(){calls++;return {status:'interpreted',interpretation:{relation:'continue',status:'running',summary:'PRIVATE summary',estimate:{remainingSeconds:3600,errorPercent:30}},usage:null};}}]});
  let server=make();
  try{
    await mkdir(day,{recursive:true});
    const frame=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date(wall).toISOString(),type,payload});
    await writeFile(join(day,`rollout-2026-09-12T00-00-00-${id}.jsonl`),[
      frame('session_meta',{id}),frame('event_msg',{type:'task_started',turn_id:turn}),
      frame('response_item',{type:'message',id:'user1',role:'user',content:[{type:'input_text',text:'PRIVATE work request'}]})].join('\n')+'\n');
    const attach=async()=>{
      await server.listen();
      const token=(await readFile(tokenPath,'utf8')).trim(),client=new CompanionHttpClient(server.address().url,tokenPath);
      const event=normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:turn},wall,token).envelope;
      await client.submitHook({...event,hostThreadId:id},{revision:(await client.status() as HudSnapshot).revision});
      return client;
    };
    let client=await attach();
    await expect.poll(async()=>((await client.status()) as HudSnapshot).rows?.[0]?.goal?.runtime,{timeout:3000}).toBe('running');
    await new Promise(resolve=>setTimeout(resolve,500));mono=15000;
    await expect.poll(()=>calls,{timeout:3000}).toBe(1);
    mono=120000;await server.close();
    const persisted=await readFile(join(directory,'goal-checkpoint.json'),'utf8');
    expect(persisted).not.toContain('PRIVATE');expect(persisted).not.toContain(id);
    mono=50;wall+=600000;server=make();client=await attach();
    mono=550; // The native reader coalesces its first disk read by 500 ms.
    await expect.poll(async()=>((await client.status()) as HudSnapshot).rows?.[0],{timeout:3000}).toMatchObject({goal:{recoveryState:'restored'}});
    const view=((await client.status()) as HudSnapshot).rows![0]!.goal!;
    expect(view.activeSeconds).toBe(120);expect(view.prediction?.errorPercent).toBe(30);
    expect(view.timingUncertain).toBe(true);expect(calls).toBe(1);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
},15000);

it('contains persistence errors and still serves the HUD',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hud-checkpoint-error-'));
  let saves=0;
  const server=createProgressServer({port:0,tokenPath:join(directory,'auth.token'),
    goalCheckpointRepository:{load:async()=>{throw Error('PRIVATE corrupt payload');},save:async()=>{saves++;throw Error('PRIVATE disk error');}}});
  try{
    await server.listen();const client=new CompanionHttpClient(server.address().url,join(directory,'auth.token'));
    expect((await client.status() as HudSnapshot).checkpoint).toEqual({state:'degraded',error:'read_failed'});
    server.store.apply({taskId:'synthetic',event:{type:'tracking_started'}});
    await expect.poll(()=>saves,{timeout:2500}).toBeGreaterThan(0);
    const snapshot=await client.status() as HudSnapshot;
    expect(snapshot.checkpoint).toEqual({state:'degraded',error:'write_failed'});
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(snapshot.tasks).toHaveLength(1);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

it('never replaces recovery data with an empty snapshot after a clock fault',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hud-checkpoint-clock-'));
  let saves=0;
  const server=createProgressServer({port:0,tokenPath:join(directory,'auth.token'),monotonicNow:()=>Number.NaN,
    goalCheckpointRepository:{load:async()=>[],save:async()=>{saves++;}}});
  try{await server.listen();await server.close();expect(saves).toBe(0);}
  finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
