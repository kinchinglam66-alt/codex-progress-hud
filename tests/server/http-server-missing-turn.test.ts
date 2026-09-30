import {expect,it,vi} from 'vitest';
import {PassiveGoals} from '../../src/server/passive-goals.js';

it.each(['goal','source'] as const)('does not partially publish recovered identity at %s capacity',async capacity=>{
 const directory=await mkdtemp(join(tmpdir(),'hud-recovery-capacity-'));
 const root=join(directory,'sessions'),day=join(root,'2026','09','12'),tokenPath=join(directory,'auth.token');
 const id='01a0766f-e48a-70e0-b8a8-4abb83140175',base=1_800_000_000_000;
 let mono=1000,wall=base,calls=0;
 let goals:PassiveGoals|undefined,filled=0;
 const original=PassiveGoals.prototype.observe;
 const spy=vi.spyOn(PassiveGoals.prototype,'observe').mockImplementation(function(this:PassiveGoals,envelope,follow,at){
  goals=this;original.call(this,envelope,follow,at);
  if(capacity==='source'&&filled++<32)this.end(envelope.sessionKey);
 });
 const retention=capacity==='source'?vi.spyOn(PassiveGoals.prototype,'retainSource').mockReturnValue(true):undefined;
 const server=createProgressServer({port:0,tokenPath,observerSessionsRoot:root,now:()=>wall,monotonicNow:()=>mono,
  observerWorkers:[{status:()=>({active:false,disabled:true,poisoned:false}),disable(){},async close(){},
   async observe(){calls++;throw Error('No model calls');}}]});
 try{
  await mkdir(day,{recursive:true});await server.listen();
  const token=(await readFile(tokenPath,'utf8')).trim(),client=new CompanionHttpClient(server.address().url,tokenPath);
  for(let n=0;n<32;n++){
   const host=`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
   const envelope=normalizeHookInput('UserPromptSubmit',{session_id:host,turn_id:'old'},wall,token).envelope;
   await submitFixtureHook(client,{...envelope,hostThreadId:host});
  }
  const frame=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date(wall).toISOString(),type,payload})+'\n';
  const file=join(day,`rollout-2026-09-12T00-00-00-${id}.jsonl`);
  await writeFile(file,frame('session_meta',{id}));
  const session=normalizeHookInput('SessionStart',{session_id:id,source:'startup'},wall,token).envelope;
  await submitFixtureHook(client,{...session,hostThreadId:id});
  mono=2000;wall=base+1000;
  await appendFile(file,frame('event_msg',{type:'task_started',turn_id:'native'}));
  const native=normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:'native'},wall,token).envelope;
  // Observe several actual source ticks, without forcing inference.
  await new Promise(done=>setTimeout(done,1000));
  expect(goals!.currentTurnKey(native.sessionKey)).toBeUndefined();
  expect((await client.status() as HudSnapshot).tasks.some(t=>t.id===native.taskHandle)).toBe(false);
  expect(calls).toBe(0);
 }finally{spy.mockRestore();retention?.mockRestore();await server.close();await rm(directory,{recursive:true,force:true});}
},15000);
import {appendFile,mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProgressServer} from '../../src/server/http-server.js';
import {CompanionHttpClient,HudClientError} from '../../src/mcp/report-client.js';
import {normalizeHookInput,type HookEnvelope} from '../../src/hooks/schema.js';
import type {HudSnapshot} from '../../src/server/task-store.js';

async function submitFixtureHook(client:CompanionHttpClient,envelope:HookEnvelope,generation?:number){
 // Source ticks may update presentation between status and the mutation.
 // Retry only a rejected stale revision, with the same event identity; never
 // swallow other errors or retry an accepted event/model operation.
 for(let attempt=0;attempt<5;attempt++){
  try{return await client.submitHook(envelope,{revision:(await client.status() as HudSnapshot).revision,
    ...(generation===undefined?{}:{generation})});}
  catch(error){if(!(error instanceof HudClientError)||error.code!=='STALE_REVISION'||attempt===4)throw error;}
 }
 throw Error('Unreachable fixture retry');
}

it.each(['running','revoked','turn_completed','turn_failed','turn_interrupted'] as const)('handles fresh SessionStart discovery: %s',async condition=>{
 const directory=await mkdtemp(join(tmpdir(),'hud-first-turn-http-'));
 const root=join(directory,'sessions'),day=join(root,'2026','09','12'),tokenPath=join(directory,'auth.token');
 const id='01a0766f-e48a-70e0-b8a8-4abb83140175',base=1_800_000_000_000;
 let mono=1000,wall=base,calls=0,enabled=true,guards=0;
 const server=createProgressServer({port:0,tokenPath,observerSessionsRoot:root,now:()=>wall,monotonicNow:()=>mono,
  async runIfGeneration(generation,_state,operation,signal){
   guards++;return enabled&&generation===7?{accepted:true,value:await operation(signal)}:{accepted:false};
  },
  observerWorkers:[{status:()=>({active:false,disabled:true,poisoned:false}),disable(){},async close(){},
   async observe(){calls++;throw Error('No model calls');}}]});
 try{
  await mkdir(day,{recursive:true});
  const frame=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date(wall).toISOString(),type,payload})+'\n';
  const file=join(day,`rollout-2026-09-12T00-00-00-${id}.jsonl`);
  await writeFile(file,frame('session_meta',{id}));await server.listen();
  const token=(await readFile(tokenPath,'utf8')).trim(),client=new CompanionHttpClient(server.address().url,tokenPath);
  const session=normalizeHookInput('SessionStart',{session_id:id,source:'startup'},wall,token).envelope;
  await submitFixtureHook(client,{...session,hostThreadId:id},7);
  expect((await client.status() as HudSnapshot).tasks).toHaveLength(0);
  mono=2000;wall=base+1000;
  if(condition==='revoked')enabled=false;
  await appendFile(file,frame('event_msg',{type:'task_started',turn_id:'native'})+
   frame('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'Native task'}]})+
   (condition.startsWith('turn_')?frame('event_msg',{type:condition,turn_id:'native'}):''));
  const native=normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:'native'},wall,token).envelope;
  if(condition==='running'){
   await expect.poll(async()=>{mono+=1000;wall=base+mono-1000;return ((await client.status()) as HudSnapshot).tasks.some(t=>t.id===native.taskHandle);},{timeout:5000}).toBe(true);
  }else{
   await new Promise(done=>setTimeout(done,1000));
   expect((await client.status() as HudSnapshot).tasks.some(t=>t.id===native.taskHandle)).toBe(false);
   if(condition==='revoked')expect(guards).toBeGreaterThan(1);
  }
  expect(calls).toBe(0);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
},15000);

it.each([false,true])('recovers a missing Hook binding in a large native file (preexisting native turn: %s)',async preexisting=>{
  const directory=await mkdtemp(join(tmpdir(),'hud-missing-turn-http-'));
  const root=join(directory,'sessions'),day=join(root,'2026','09','12'),tokenPath=join(directory,'auth.token');
  const id='01a0766f-e48a-70e0-b8a8-4abb83140175',base=1_800_000_000_000;
  let mono=1000,wall=base,calls=0;
  const server=createProgressServer({port:0,tokenPath,observerSessionsRoot:root,now:()=>wall,monotonicNow:()=>mono,
    observerWorkers:[{status:()=>({active:false,disabled:true,poisoned:false}),disable(){},async close(){},
      async observe(){calls++;throw Error('No model calls in this lifecycle test');}}]});
  try{
    await mkdir(day,{recursive:true});
    const frame=(type:string,payload:unknown,at=wall)=>JSON.stringify({timestamp:new Date(at).toISOString(),type,payload})+'\n';
    const file=join(day,`rollout-2026-09-12T00-00-00-${id}.jsonl`);
    await writeFile(file,frame('session_meta',{id})+frame('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'x'.repeat(9*1024*1024)}]})+
      frame('event_msg',{type:'task_started',turn_id:preexisting?'native':'older'},base-10000));
    await server.listen();
    const token=(await readFile(tokenPath,'utf8')).trim(),client=new CompanionHttpClient(server.address().url,tokenPath);
    const missing=normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:'missing'},wall,token).envelope;
    await submitFixtureHook(client,{...missing,hostThreadId:id});
    mono=2000;wall=base+1000;
    await appendFile(file,(preexisting?'':frame('event_msg',{type:'task_started',turn_id:'native'}))+
      frame('response_item',{type:'message',id:'u',role:'user',content:[{type:'input_text',text:'Native task'}]}));
    mono=8000;wall=base+7000;
    const native=normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:'native'},wall,token).envelope;
    const advance=()=>{mono+=1000;wall=base+mono-1000;};
    // Native appends may race the initial read/confirmation. Let the fake
    // clock advance through the bounded retry interval, like a real clock.
    await expect.poll(async()=>{advance();return ((await client.status()) as HudSnapshot).tasks.some(task=>task.id===native.taskHandle);},{timeout:5000}).toBe(true);
    await expect.poll(async()=>{advance();return ((await client.status()) as HudSnapshot).rows?.some(row=>row.task.id===native.taskHandle&&row.goal?.runtime==='running');},{timeout:5000}).toBe(true);
    const row=((await client.status()) as HudSnapshot).rows?.find(row=>row.task.id===native.taskHandle);
    expect(row?.goal?.activeSeconds).toBe((wall-(preexisting?base-10000:base+1000))/1000);
    expect(calls).toBe(0);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
},15000);
