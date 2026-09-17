import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalSessionReader} from '../../src/observer/local-session-reader.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import {createContextOwner} from '../../src/observer/context-owner.js';
import {createConversationSource} from '../../src/observer/conversation-source.js';

const id='11111111-1111-4111-8111-111111111111',signal=new AbortController().signal;
const roots:string[]=[];
const line=(type:string,payload:unknown)=>JSON.stringify({timestamp:'2026-09-15T00:00:00Z',type,payload})+'\n';
const start=(turn:string)=>line('event_msg',{type:'task_started',turn_id:turn});
const end=(turn:string)=>line('event_msg',{type:'task_complete',turn_id:turn});
const user=(text:string)=>line('response_item',{type:'message',role:'user',content:[{type:'input_text',text}]});
const meta=line('session_meta',{id,cli_version:'0.153.4'});
afterEach(async()=>{for(const root of roots.splice(0)){
  if(!root.startsWith(join(tmpdir(),'hud-turn-source-')))throw Error('UNSAFE_FIXTURE_CLEANUP');
  await rm(root,{recursive:true,force:true});
}});
async function fixture(first=false){
  const root=await mkdtemp(join(tmpdir(),'hud-turn-source-'));roots.push(root);
  const sourceRoot=join(root,'sessions'),directory=join(sourceRoot,'2026','09','15'),destination=join(root,'protected');
  await mkdir(directory,{recursive:true});await mkdir(destination);
  const path=join(directory,`rollout-2026-09-15-${id}.jsonl`);
  const base=meta+(first?'':start('six')+user('old fact '+'.'.repeat(6000))+end('six'));
  const prelude=line('event_msg',{type:'thread_settings_applied',thread_id:id,thread_settings:{model:'synthetic-model'}});
  const data=base+prelude+start('seven')+user('current task');
  await writeFile(path,data);
  const reader=createLocalSessionReader({root:sourceRoot});await reader.read(id,signal);
  const target={destinationDirectory:destination,maxSourceBytes:8*1024*1024,verifyDestination:async()=>{}};
  return {reader,path,sourceRoot,base,data,target};
}
async function records(snapshot:HistorySnapshot){
  const result=[];for await(const item of snapshot.records(signal))result.push(item.record);return result;
}

it.each([2,5])('preserves native context when the UI skips a %i MiB tool event',async mib=>{
 const f=await fixture();let view,base;
 const output='tool evidence '+'.'.repeat(mib*1024*1024);
 try{
  await appendFile(f.path,line('event_msg',{type:'item_completed',thread_id:id,turn_id:'seven',
   item:{type:'FunctionCallOutput',id:'large-result',name:'read',namespace:'tools',output}}));
  let truncated=false,caughtUp=false;
  for(let pass=0;pass<4&&!caughtUp;pass++){
   const batch=await f.reader.read(id,signal);truncated ||= batch.historyTruncated===true;caughtUp=batch.caughtUp;
   expect(batch.records.some(row=>row.actionId==='large-result')).toBe(false);
  }
  expect(caughtUp).toBe(true);expect(truncated).toBe(true);
  view=await f.reader.openNativeTurn(id,signal);
  base=await view.openBase(f.target,signal);
  expect(await readFile(base!.path,'utf8')).toBe(f.base);
  const rows=await records(view.supplement);
  expect(view.supplement.coverage).toEqual({complete:true,gaps:[]});
  expect(rows.find(row=>row.actionId==='large-result')).toMatchObject({output,outputComplete:true,sourceTurnId:'seven'});
  await appendFile(f.path,user('after large output'));await f.reader.read(id,signal);
  await view.validate(signal);
 }finally{await base?.close();await view?.close();await f.reader.close();}
});

it('retains native attestation when UI dedupe history is evicted',async()=>{
 const f=await fixture();let view;
 try{
  await appendFile(f.path,Array.from({length:4200},(_,n)=>user('unique requirement '+n)).join(''));
  const batch=await f.reader.read(id,signal);expect(batch.historyTruncated).toBe(true);
  view=await f.reader.openNativeTurn(id,signal);await view.validate(signal);
  expect(view.boundary.completed?.turnId).toBe('six');
 }finally{await view?.close();await f.reader.close();}
});

it.each(['foreign-thread','invalid-shape','invalid-timestamp'] as const)('rejects invalid oversized tool data in the inherited base: %s',async mode=>{
 const f=await fixture();
 try{
  const event=line('event_msg',{type:'item_completed',turn_id:'six',thread_id:mode==='foreign-thread'?'foreign':id,
   item:{type:'FunctionCallOutput',id:'bad-base',name:'read',namespace:'tools',output:'.'.repeat(2*1024*1024),
    ...(mode==='invalid-shape'?{unexpected:true}:{})}});
  const inherited=mode==='invalid-timestamp'?event.replace('"timestamp":"2026-09-15T00:00:00Z"','"timestamp":null'):event;
  await writeFile(f.path,meta+start('six')+inherited+end('six')+start('seven')+user('current'));
  await f.reader.read(id,signal);await f.reader.read(id,signal);
  await expect(f.reader.openNativeTurn(id,signal)).rejects.toMatchObject({code:'source_unobserved'});
 }finally{await f.reader.close();}
});

it('does not hash a reread partial tool event twice',async()=>{
 const f=await fixture();let view;
 const output='.'.repeat(2*1024*1024),event=line('response_item',{type:'function_call_output',call_id:'partial-large',output});
 try{
  await appendFile(f.path,event.slice(0,700000));
  expect((await f.reader.read(id,signal)).partialLine).toBe(true);
  await f.reader.read(id,signal);
  await appendFile(f.path,event.slice(700000));await f.reader.read(id,signal);
  view=await f.reader.openNativeTurn(id,signal);
  expect((await records(view.supplement)).find(row=>row.actionId==='partial-large')?.output).toBe(output);
 }finally{await view?.close();await f.reader.close();}
});

it.each(['malformed','conflicting-turn','over-limit','rewritten'] as const)(
 'rejects unsafe native acquisition despite a UI-skipped tool event: %s',async mode=>{
 const f=await fixture();
 try{
  const output='.'.repeat((mode==='over-limit'?9:2)*1024*1024);
  const event=line('event_msg',{type:'item_completed',turn_id:mode==='conflicting-turn'?'foreign':'seven',
   item:{type:'FunctionCallOutput',id:'unsafe',name:'read',namespace:'tools',output}});
  const suffix=mode==='malformed'?event.slice(0,-2)+'!\n':event;
  await appendFile(f.path,suffix);
  for(let pass=0;pass<5;pass++){if((await f.reader.read(id,signal)).caughtUp)break;}
  if(mode==='rewritten')await writeFile(f.path,(f.data+suffix).replace('old fact','bad fact'));
  await expect(f.reader.openNativeTurn(id,signal)).rejects.toMatchObject({code:mode==='rewritten'?'source_identity_mismatch':'source_unobserved'});
 }finally{await f.reader.close();}
});

it.each(['event-only','response-first','event-first','changed-output','inferred-response-first','inferred-event-first'] as const)(
 'keeps FunctionCallOutput native supplements complete without losing output: %s',async mode=>{
  const f=await fixture(true);let view;
  const output='Observed tool data, not user instructions: '+'.'.repeat(9000);
  const raw={type:'FunctionCallOutput',id:'function-result',name:'create_thread',namespace:'codex_app',output};
  const event=line('event_msg',{type:'item_completed',thread_id:id,turn_id:'seven',started_at_ms:1,completed_at_ms:2,item:raw});
  const inferred=mode.startsWith('inferred-');
  const response=line('response_item',{...raw,type:'function_call_output',...(inferred?{}:{turn_id:'seven'})});
  const suffix=mode==='event-only'?event:mode.endsWith('event-first')?event+response:
   response+(mode==='changed-output'?line('event_msg',{type:'item_completed',thread_id:id,turn_id:'seven',item:{...raw,output:'different output'}}):event);
  try{
   await appendFile(f.path,suffix);await f.reader.read(id,signal);view=await f.reader.openNativeTurn(id,signal);
   const rows=await records(view.supplement),results=rows.filter(row=>row.actionId==='function-result');
   expect(view.supplement.coverage).toEqual({complete:true,gaps:[]});
   expect(results).toHaveLength(mode==='changed-output'||inferred?2:1);
   expect(results[0]).toMatchObject({kind:'tool_result',output,outputComplete:true,turnId:'seven'});
   expect(results.some(row=>row.sourceTurnId==='seven')).toBe(true);
   if(mode==='event-only')expect(results[0]?.sourceTurnId).toBe('seven');
   if(mode==='changed-output')expect(results[1]?.output).toBe('different output');
  }finally{await view?.close();await f.reader.close();}
 });

it.each([
 {thread_id:'foreign'}, {turn_id:'seven',turnId:'other'}, {started_at_ms:-1},
 {item:{type:'FunctionCallOutput',id:'f',name:'read',namespace:'tools',output:123}},
 {item:{type:'FunctionCallOutput',id:'f',name:'read',namespace:'tools',output:'text',turn_id:'other'}},
 {type:'item_started'}
])('rejects malformed or conflicting FunctionCallOutput metadata: %j',async override=>{
 const f=await fixture(true);
 try{
  await appendFile(f.path,line('event_msg',{type:'item_completed',thread_id:id,turn_id:'seven',
   item:{type:'FunctionCallOutput',id:'f',name:'read',namespace:'tools',output:'text'},...override}));
  const snapshot=await f.reader.snapshot(id,signal);
  try{
   await records(snapshot);
   expect(snapshot.coverage.complete).toBe(false);
   expect(snapshot.coverage.gaps).toContain('unsupported_payload');
  }finally{await snapshot.close();}
 }finally{await f.reader.close();}
});

it('rejects a task_failed native prefix before allocating a base but leaves verified parsed history available',async()=>{
 const f=await fixture();
 const attributed=(turn:string,text:string)=>line('response_item',{type:'message',role:'user',turn_id:turn,content:[{type:'input_text',text}]});
 await writeFile(f.path,meta+start('six')+attributed('six','old fact')+line('event_msg',{type:'task_failed',turn_id:'six'})+start('seven')+attributed('seven','current task'));
 await f.reader.read(id,signal);await f.reader.read(id,signal);
 try{
  await expect(f.reader.openNativeTurn(id,signal)).rejects.toMatchObject({code:'source_terminal_unsupported'});
  const history=await f.reader.snapshot(id,signal);const rows=await records(history);
  expect(history.coverage).toEqual({complete:true,gaps:[]});expect(JSON.stringify(rows)).toContain('current task');await history.close();
 }finally{await f.reader.close();}
});

it('inherits an older failed turn when the selected latest cutoff completed normally',async()=>{
 const f=await fixture();let source,base;
 const history=meta+start('five')+user('FAILED-HISTORY')+line('event_msg',{type:'task_failed',turn_id:'five'})+start('six')+user('RECOVERED-HISTORY')+end('six');
 await writeFile(f.path,history+start('seven')+user('CURRENT'));
 await f.reader.read(id,signal);await f.reader.read(id,signal);
 try{
  source=await f.reader.openNativeTurn(id,signal);
  expect(source.boundary.completed?.turnId).toBe('six');
  base=await source.openBase(f.target,signal);
  expect(await readFile(base!.path,'utf8')).toBe(history);
  expect(JSON.stringify(await records(source.supplement))).toContain('CURRENT');
 }finally{await base?.close();await source?.close();await f.reader.close();}
});

it('preserves native user/agent message events, including images and extra fields, in the first current turn',async()=>{
 const f=await fixture(true),picture='data:image/png;base64,iVBORw0KGgo=';
 const data=meta+start('seven')+line('event_msg',{type:'user_message',message:'FIRST-EVENT-REQUEST',images:[picture],local_images:[],text_elements:[],extra:{fact:'keep me'}})+
  line('event_msg',{type:'agent_message',message:'FIRST-EVENT-PROGRESS',phase:'commentary'});
 await writeFile(f.path,data);await f.reader.read(id,signal);await f.reader.read(id,signal);
 try{
  const source=await f.reader.openNativeTurn(id,signal),rows=await records(source.supplement);
  expect(source.supplement.coverage).toEqual({complete:true,gaps:[]});
  expect(JSON.stringify(rows)).toContain('FIRST-EVENT-REQUEST');expect(JSON.stringify(rows)).toContain('keep me');
  expect(rows.find(x=>x.kind==='user')?.contentParts).toContainEqual({type:'input_image',imageUrl:picture});
  expect(rows.find(x=>x.kind==='assistant')?.assistantPhase).toBe('commentary');await source.close();
 }finally{await f.reader.close();}
});

it('pairs the previous terminal base with all current content and intervening configuration',async()=>{
  const f=await fixture();let view,base;
  try{
    view=await f.reader.openNativeTurn(id,signal);
    await appendFile(f.path,line('response_item',{type:'function_call_output',call_id:'future',output:'FUTURE_RESULT'}));
    base=await view.openBase(f.target,signal);
    expect(base).not.toBeNull();expect(await readFile(base!.path,'utf8')).toBe(f.base);
    expect(view.boundary.completed?.turnId).toBe('six');
    expect(view.boundary.watermark).toBe(Buffer.byteLength(f.data));
    const items=await records(view.supplement);
    expect(items.map(item=>item.kind)).toEqual(['tool_result','runtime','user']);
    expect(items[0]?.sourceScope).toBe('conversation');
    expect(items[0]?.text).toContain('synthetic-model');
    expect(items[2]?.text).toBe('current task');
    expect(items[2]?.turnId).toBe('seven');
    expect(view.supplement.coverage).toEqual({complete:true,gaps:[]});
  }finally{await base?.close();await view?.close();await f.reader.close();}
});
it('reuses base identity while each acquisition includes the whole growing current turn',async()=>{
  const f=await fixture();let first,second;
  try{
    first=await f.reader.openNativeTurn(id,signal);
    await appendFile(f.path,user('another requirement'));await f.reader.read(id,signal);
    second=await f.reader.openNativeTurn(id,signal);
    expect(second.baseKey).toBe(first.baseKey);expect(second.sourceEpoch).toBe(first.sourceEpoch);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect((await records(first.supplement)).filter(r=>r.kind==='user').map(r=>r.text)).toEqual(['current task']);
    expect((await records(second.supplement)).filter(r=>r.kind==='user').map(r=>r.text)).toEqual(['current task','another requirement']);
  }finally{await first?.close();await second?.close();await f.reader.close();}
});
it('first turn has no native base but preserves its prelude and full user input',async()=>{
  const f=await fixture(true);let view;
  try{
    view=await f.reader.openNativeTurn(id,signal);
    expect(view.boundary.completed).toBeNull();expect(await view.openBase(f.target,signal)).toBeNull();
    expect((await records(view.supplement)).filter(r=>r.kind==='user').map(r=>r.text)).toEqual(['current task']);
    expect(view.supplement.coverage.complete).toBe(true);
  }finally{await view?.close();await f.reader.close();}
});
it('rejects earlier same-size overwrite outside the existing small cursor hash window',async()=>{
  const f=await fixture();let view;
  try{
    view=await f.reader.openNativeTurn(id,signal);
    await writeFile(f.path,f.data.replace('old fact','bad fact'));
    await expect(view.validate(signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
    await expect(records(view.supplement)).rejects.toMatchObject({code:'source_identity_mismatch'});
  }finally{await view?.close();await f.reader.close();}
});
it('does not attest source modified between observation and the first acquisition',async()=>{
  const f=await fixture();
  try{
    await writeFile(f.path,f.data.replace('old fact','bad fact'));
    await expect(f.reader.openNativeTurn(id,signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
  }finally{await f.reader.close();}
});
it('old turn capture becomes invalid when a new turn is observed',async()=>{
  const f=await fixture();let old,next;
  try{
    old=await f.reader.openNativeTurn(id,signal);
    await appendFile(f.path,end('seven')+start('eight')+user('new task'));await f.reader.read(id,signal);
    await expect(old.validate(signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
    next=await f.reader.openNativeTurn(id,signal);
    expect(next.baseKey).not.toBe(old.baseKey);expect(next.boundary.completed?.turnId).toBe('seven');
  }finally{await old?.close();await next?.close();await f.reader.close();}
});
it('never includes half of a newly written record',async()=>{
  const f=await fixture();let view;
  try{
    await appendFile(f.path,'{"type":"response_item"');await f.reader.read(id,signal);
    view=await f.reader.openNativeTurn(id,signal);
    expect(view.boundary.watermark).toBe(Buffer.byteLength(f.data));
    expect((await records(view.supplement)).filter(r=>r.kind==='user').map(r=>r.text)).toEqual(['current task']);
  }finally{await view?.close();await f.reader.close();}
});
it('preserves tool association and full text beyond the UI projection cap',async()=>{
  const f=await fixture();let view;
  try{
    const text='large-input-'+'.'.repeat(70000);
    await appendFile(f.path,user(text)+line('response_item',{type:'function_call',name:'exec',call_id:'call-7',arguments:'{"cmd":"test"}'})+
      line('response_item',{type:'function_call_output',call_id:'call-7',output:'result-7'}));
    await f.reader.read(id,signal);view=await f.reader.openNativeTurn(id,signal);
    const items=await records(view.supplement);
    expect(items.filter(r=>r.kind==='user').at(-1)?.text).toBe(text);
    expect(items.filter(r=>r.kind==='tool_start'||r.kind==='tool_result').filter(r=>r.sourceScope!=='conversation').map(r=>r.actionId)).toEqual(['call-7','call-7']);
  }finally{await view?.close();await f.reader.close();}
});
it('does not reopen a closed capture or source',async()=>{
  const f=await fixture();const view=await f.reader.openNativeTurn(id,signal);
  await view.close();await expect(view.validate(signal)).rejects.toMatchObject({code:'source_closed'});
  await f.reader.close();await expect(f.reader.openNativeTurn(id,signal)).rejects.toMatchObject({code:'source_closed'});
});
it('preserves repeated user requirements and image parts without text-based deduplication',async()=>{
  const f=await fixture();let view;
  try{
    const image='data:image/png;base64,iVBORw0KGgo=';
    await appendFile(f.path,user('current task')+line('response_item',{type:'message',role:'user',content:[{type:'input_image',image_url:image}]}));
    await f.reader.read(id,signal);view=await f.reader.openNativeTurn(id,signal);
    const items=await records(view.supplement);
    expect(items.filter(r=>r.kind==='user'&&r.text==='current task')).toHaveLength(2);
    expect(items.at(-1)?.contentParts).toEqual([{type:'input_image',imageUrl:image}]);
  }finally{await view?.close();await f.reader.close();}
});
it('rebuilds a stable new epoch after a detected early rewrite and a fresh source read',async()=>{
  const f=await fixture();let old,next;
  try{
    old=await f.reader.openNativeTurn(id,signal);await writeFile(f.path,f.data.replace('old fact','bad fact'));
    await expect(old.validate(signal)).rejects.toMatchObject({code:'source_identity_mismatch'});
    expect((await f.reader.read(id,signal)).reset).toBe(true);
    next=await f.reader.openNativeTurn(id,signal);
    expect(next.sourceEpoch).toBeGreaterThan(old.sourceEpoch);expect(next.baseKey).not.toBe(old.baseKey);
    await next.validate(signal);
  }finally{await old?.close();await next?.close();await f.reader.close();}
});
it('closes an unhanded base when cancellation arrives during its protected copy',async()=>{
  const f=await fixture(),controller=new AbortController();let view;
  try{
    view=await f.reader.openNativeTurn(id,signal);
    await expect(view.openBase({...f.target,beforeCopy:async()=>{controller.abort();}},controller.signal)).rejects.toMatchObject({code:'source_cancelled'});
    await expect(view.openBase(f.target,signal)).rejects.toMatchObject({code:'source_unobserved'});
  }finally{await view?.close();await f.reader.close();}
});
it('does not certify a current-turn compaction marker as a complete readable supplement',async()=>{
  const f=await fixture();let view;
  try{
    await appendFile(f.path,line('compacted',{message:'history compacted'}));await f.reader.read(id,signal);
    view=await f.reader.openNativeTurn(id,signal);await records(view.supplement);
    expect(view.supplement.coverage.complete).toBe(false);expect(view.supplement.coverage.gaps).toContain('upstream_truncated');
  }finally{await view?.close();await f.reader.close();}
});
it('context owner refuses a paired capture when task binding changes during acquisition',async()=>{
  const f=await fixture();let now=0,finish!:()=>void,entered!:()=>void;
  const hold=new Promise<void>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  // The owner needs its own initial read; the fixture reader has already consumed
  // the source, so use a fresh reader rather than manufacturing projected rows.
  const reader=createLocalSessionReader({root:f.sourceRoot});
  const owner=createContextOwner({source:{...reader,openNativeTurn:async(threadId,requestSignal)=>{
    const view=await reader.openNativeTurn(threadId,requestSignal);entered();await hold;return view;
  }},now:()=>now});
  try{
    owner.attach('task',id,'seven');now=500;owner.tick();
    for(let i=0;i<100&&owner.health('task')!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(owner.health('task')).toBe('ready');
    const pending=owner.openNativeTurn('task','seven',signal);await started;
    owner.attach('task',id,'eight');finish();
    await expect(pending).rejects.toMatchObject({code:'SOURCE_HISTORY_BINDING_CHANGED'});
  }finally{finish();await owner.close();await f.reader.close();}
});
it('context owner exposes complete paired content only for its matching live binding',async()=>{
  const f=await fixture();let now=0,view;
  const reader=createLocalSessionReader({root:f.sourceRoot}),owner=createContextOwner({source:reader,now:()=>now});
  try{
    owner.attach('task',id,'seven');now=500;owner.tick();
    for(let i=0;i<100&&owner.health('task')!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(owner.health('task')).toBe('ready');
    expect(await owner.openNativeTurn('task','different',signal)).toBeNull();
    view=await owner.openNativeTurn('task','seven',signal);
    expect(view?.currentTurnId).toBe('seven');expect((await records(view!.supplement)).at(-1)?.text).toBe('current task');
    owner.attach('task',id,'eight');await expect(view!.validate(signal)).rejects.toMatchObject({code:'SOURCE_HISTORY_BINDING_CHANGED'});
  }finally{await view?.close();await owner.close();await f.reader.close();}
});
it('conversation source forwards paired history for the selected conversation and fences replacement',async()=>{
  const f=await fixture();let now=0,view;
  const source=createConversationSource({source:createLocalSessionReader({root:f.sourceRoot}),now:()=>now,
    wallNow:()=>Date.parse('2026-09-15T00:00:01Z'),turnKeyFor:(_host,turn)=>turn});
  try{
    source.attach('selected',id,'seven');now=500;source.tick();
    for(let i=0;i<100&&source.snapshot('selected')?.health!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(source.snapshot('selected')?.health).toBe('ready');
    expect(await source.goals.openNativeTurn!('other','seven',signal)).toBeNull();
    view=await source.goals.openNativeTurn!('selected','seven',signal);
    expect(view?.boundary.completed?.turnId).toBe('six');
    expect((await records(view!.supplement)).at(-1)?.text).toBe('current task');
    source.attach('selected',id,'eight');
    await expect(view!.validate(signal)).rejects.toMatchObject({code:'SOURCE_HISTORY_BINDING_CHANGED'});
  }finally{await view?.close();await source.close();await f.reader.close();}
});
