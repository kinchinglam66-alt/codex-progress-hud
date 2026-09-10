import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProgressServer} from '../../src/server/http-server.js';
import {CompanionHttpClient} from '../../src/mcp/report-client.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import type {HudSnapshot} from '../../src/server/task-store.js';
import type {ObserverObservation} from '../../src/estimation/observer-scheduler.js';

it('dispatches from a persisted source user message before the long tool finishes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hud-source-http-'));
  const root=join(directory,'sessions'),day=join(root,'2026','09','06'),tokenPath=join(directory,'auth.token');
  const id='01a0766f-e48a-70e0-b8a8-4abb83140175',turn='current';
  let now=0;const calls:ObserverInput[]=[];
  const observations:ObserverObservation[]=[];
  const server=createProgressServer({port:0,tokenPath,observerSessionsRoot:root,now:()=>now,monotonicNow:()=>now,
    onObserverObservation:record=>observations.push(record),
    observerWorkers:[{status:()=>({active:false,disabled:false,poisoned:false}),disable(){},async close(){},
      async observe(input){calls.push(input);return {status:'interpreted',interpretation:{relation:'replace',status:'running',
        summary:'Wait for the requested command',estimate:{remainingSeconds:85,errorPercent:20}},
        usage:{kind:'subscription-tokens',inputTokens:100,outputTokens:10,cachedInputTokens:0}};}}]});
  try{
    await mkdir(day,{recursive:true});
    const frame=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date(0).toISOString(),type,payload});
    await writeFile(join(day,`rollout-2026-09-06T00-00-00-${id}.jsonl`),[
      frame('session_meta',{id}),frame('event_msg',{type:'task_started',turn_id:turn}),
      frame('response_item',{type:'message',id:'user1',role:'user',content:[{type:'input_text',text:'sleep 100 seconds'}]}),
      frame('response_item',{type:'custom_tool_call',call_id:'call1',name:'exec',input:'sleep 100'})].join('\n')+'\n');
    await server.listen();const token=(await readFile(tokenPath,'utf8')).trim();
    const client=new CompanionHttpClient(server.address().url,tokenPath);
    const envelope=normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:turn},0,token).envelope;
    // Production hooks/main.ts attaches this private routing metadata separately.
    envelope.hostThreadId=id;
    expect(envelope.content).toBeUndefined();
    await client.submitHook(envelope,{revision:(await client.status() as HudSnapshot).revision});
    now=500;await new Promise(resolve=>setTimeout(resolve,1200));now=15000;
    await expect.poll(()=>calls.length,{timeout:3000}).toBe(1);
    expect(calls[0]?.messages.some(message=>message.text==='sleep 100 seconds')).toBe(true);
    expect(calls[0]?.observation?.currentAction?.text).toBe('sleep 100');
    expect(observations.find(record=>record.kind==='request')?.activeTimeKnown).toBe(false);
    expect(calls[0]?.messages.some(message=>message.text.includes('hook body'))).toBe(false);
    // No Stop hook is delivered: the source callback must still correct the HUD
    // even when model dispatch is not involved in determining execution state.
    now=20000;
    await appendFile(join(day,`rollout-2026-09-06T00-00-00-${id}.jsonl`),
      JSON.stringify({timestamp:new Date(18000).toISOString(),type:'event_msg',
        payload:{type:'task_complete',turn_id:turn}})+'\n');
    await expect.poll(async()=>((await client.status()) as HudSnapshot).rows?.[0]?.goal?.runtime,{timeout:3000}).toBe('waiting');
    const frozen=((await client.status()) as HudSnapshot).rows?.[0]?.goal?.activeSeconds;
    now=25000;
    expect(((await client.status()) as HudSnapshot).rows?.[0]?.goal?.activeSeconds).toBe(frozen);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
},10000);
