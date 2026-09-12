import {it,expect} from 'vitest';
import {assembleContext} from '../../src/observer/context-assembler.js';
import {packObserverInput} from '../../src/estimation/observer-input.js';
import {observerInputSchema} from '../../src/estimation/observer-contract.js';

const base={summary:null,summaryThroughSequence:0,sequence:3,activeSeconds:20,
  activeTimeKnown:false,historyComplete:true,nowMs:30000,previousEstimate:null};
const user=(id:string,text:string,atMs=0)=>({id,turnId:'turn1',kind:'user' as const,text,atMs});

it('preserves factual event pairs without transmitting source identifiers',()=>{
  const records=[user('private-user','Build CSV'),
    {id:'private-start',turnId:'private-turn',kind:'tool_start' as const,actionId:'private-action',atMs:1000,text:'npm test'},
    {id:'private-result',turnId:'private-turn',kind:'tool_result' as const,actionId:'private-action',atMs:2000,text:'exit_code=1'},
    {id:'private-other',turnId:'other-turn',kind:'tool_result' as const,actionId:'private-action',atMs:3000,text:'exit_code=0'}];
  const before=structuredClone(records);
  const packed=packObserverInput(assembleContext(records,base));
  const packet=observerInputSchema.parse(JSON.parse(packed));
  expect(packet.messages[1]?.event).toMatchObject({ordinal:1,kind:'tool_start',atMs:1000,pairOrdinal:0,counterpartMissing:false});
  expect(packet.messages[2]?.event).toMatchObject({pairOrdinal:0,counterpartMissing:false});
  expect(packet.messages[3]?.event).toMatchObject({pairOrdinal:1,counterpartMissing:true});
  expect(packed).not.toContain('private-');
  expect(packet.packingLoss).toMatchObject({suppliedMessages:4,retainedMessages:4,clippedMessages:0});
  expect(packObserverInput(JSON.parse(packed))).toBe(packed);
  expect(records).toEqual(before);
});

it('preserves large source history through assembly and repeat packing with honest loss counts',()=>{
  const records=[user('u1','Original objective '+ '目标'.repeat(1500)),
    ...Array.from({length:140},(_,i)=>({id:`tool${i}`,turnId:'turn1',kind:'tool_result' as const,atMs:i,text:'日志'.repeat(2500)})),
    user('u2','Newest amendment '+ 'password=x '.repeat(300))];
  const packed=packObserverInput(assembleContext(records,base));
  const packet=observerInputSchema.parse(JSON.parse(packed));
  expect(packet.messages[0]?.text).toContain('Original objective');
  expect(packet.messages.at(-1)?.text).toContain('Newest amendment');
  expect(packet.packingLoss!.suppliedMessages).toBe(142);
  expect(packet.packingLoss!.retainedMessages).toBe(packet.messages.length);
  expect(Object.values(packet.packingLoss!.droppedByKind).reduce((a,b)=>a+b,0)).toBe(0);
  expect(packet.messages).toHaveLength(142);
  expect(Buffer.byteLength(packed)).toBeGreaterThan(256*1024);
  expect(packObserverInput(JSON.parse(packed))).toBe(packed);
});

it('does not pair anonymous actions or leak associations between conversations',()=>{
  const records=[user('u','Fix it'),
    {id:'s',turnId:null,kind:'tool_start' as const,actionId:'same',atMs:1,text:'npm test'},
    {id:'r',turnId:null,kind:'tool_result' as const,actionId:'same',atMs:2,text:'exit_code=0'}];
  const first=assembleContext(records,base);
  expect(first.messages.slice(1).every(m=>m.event?.counterpartMissing)).toBe(true);
  const other=assembleContext([user('other','Different task'),{...records[2]!,turnId:'turn1'}],{...base,historyComplete:false});
  expect(other.messages[1]?.event).toMatchObject({pairOrdinal:0,counterpartMissing:true});
  expect(other.observation.historyComplete).toBe(false);
  expect(other.packingLoss?.droppedByKind).toEqual({user:0,assistant:0,tool:0});
});

it('retains non-empty source messages without clipping them',()=>{
  const packet=assembleContext([user('u','Task'),user('blank','   '),user('long','长'.repeat(5000))],base);
  expect(packet.packingLoss).toEqual({suppliedMessages:3,retainedMessages:3,
    droppedByKind:{user:0,assistant:0,tool:0},clippedMessages:0});
  expect(packet.observation.omittedCategories).toEqual([]);
  expect(packObserverInput(JSON.parse(packObserverInput(packet)))).toBe(packObserverInput(packet));
});

it('assigns separate pairs to reused tool IDs within one turn',()=>{
  const records=[user('u','Task'),
    {id:'s1',turnId:'turn1',kind:'tool_start' as const,actionId:'same',atMs:1,text:'first'},
    {id:'r1',turnId:'turn1',kind:'tool_result' as const,actionId:'same',atMs:2,text:'first result'},
    {id:'s2',turnId:'turn1',kind:'tool_start' as const,actionId:'same',atMs:3,text:'second'},
    {id:'r2',turnId:'turn1',kind:'tool_result' as const,actionId:'same',atMs:4,text:'second result'}];
  const packet=assembleContext(records,base);
  expect(packet.messages.slice(1).map(m=>m.event?.pairOrdinal)).toEqual([0,0,1,1]);
  // Removing one member of each invocation must not produce a false complete pair.
  const input={...packet,messages:[packet.messages[0]!,packet.messages[1]!,packet.messages[4]!],packingLoss:undefined};
  expect(JSON.parse(packObserverInput(input)).messages.slice(1).every((m:any)=>m.event.counterpartMissing)).toBe(true);
});

it('preserves equal-length credential-like source text as task content',()=>{
  const packet=assembleContext([user('u','password=abcdefghij')],base);
  expect(packet.truncated).toBe(false);
  expect(packet.messages[0]?.text).toBe('password=abcdefghij');
  expect(packet.messages[0]?.truncated).toBe(false);
  expect(packet.packingLoss?.clippedMessages).toBe(0);
  expect(packet.observation.omittedCategories).toEqual([]);
});

it('does not guess a match for overlapping starts with the same action ID',()=>{
  const records=[user('u','Task'),...(['tool_start','tool_start','tool_result','tool_result'] as const).map((kind,i)=>({
    id:String(i),turnId:'turn1',kind,actionId:'same',atMs:i,text:`event ${i}`}))];
  const packet=assembleContext(records,base);
  expect(packet.messages.slice(1).map(m=>m.event?.pairOrdinal)).toEqual([0,1,2,3]);
  expect(packet.messages.slice(1).every(m=>m.event?.counterpartMissing)).toBe(true);
});

it('retains original goal and newest amendment before repetitive tool output',()=>{
  const records=[user('u1','Build CSV import'),...Array.from({length:140},(_,i)=>({id:`r${i}`,
    turnId:'turn1',kind:'tool_result' as const,text:'log '.repeat(2000),atMs:1000+i})),
    user('u2','Also reject duplicate rows',20000)];
  const result=assembleContext(records,base);
  expect(result.messages.some(m=>m.text==='Build CSV import')).toBe(true);
  expect(result.messages.some(m=>m.text==='Also reject duplicate rows')).toBe(true);
  expect(result.truncated).toBe(false);
  expect(result.messages).toHaveLength(142);
});

it('retains a promoted delegation requirement with the latest amendment under packing pressure',()=>{
  const records=[user('initial','actual task text: preserve the approved requirements'),
    ...Array.from({length:140},(_,i)=>({id:`tool-${i}`,turnId:'turn1',kind:'tool_result' as const,
      atMs:1000+i,text:'tool log '.repeat(2000)})),
    user('amendment','LATEST AMENDMENT: reject duplicates',20_000)];
  const packed=packObserverInput(assembleContext(records,base));
  const decoded=JSON.parse(packed) as {messages:Array<{text:string}>};
  expect(decoded.messages.some(message=>message.text.includes('actual task text'))).toBe(true);
  expect(decoded.messages.some(message=>message.text.includes('LATEST AMENDMENT'))).toBe(true);
  expect(JSON.parse(packed).messages).toHaveLength(142);
});

it('provides running action elapsed time and explicitly partial work clock',()=>{
  const result=assembleContext([user('u1','sleep 100'),{id:'c1',actionId:'a1',turnId:'turn1',
    atMs:5000,kind:'tool_start',text:'Start-Sleep -Seconds 100'}],base);
  expect(result.observation.currentAction).toMatchObject({text:'Start-Sleep -Seconds 100',elapsedSeconds:25});
  expect(result.observation.activeTimeKnown).toBe(false);
  expect(result.observation.historyComplete).toBe(true);
  expect(result.observation.sequence).toBe(3);
});

it('clears finished actions and excludes runtime events from message bodies',()=>{
  const result=assembleContext([user('u1','sleep 100'),{id:'c1',actionId:'a1',turnId:'turn1',
    atMs:5000,kind:'tool_start',text:'sleep 100'}, {id:'r1',actionId:'a1',turnId:'turn1',
    atMs:10000,kind:'tool_result',text:'exit_code=0'}, {id:'s1',turnId:'turn1',atMs:10000,
    kind:'runtime',runtime:'waiting'}],base);
  expect(result.observation.currentAction).toBeNull();
  expect(result.messages.every(m=>m.text.length>0)).toBe(true);
});

it('preserves credential-like text from action metadata and messages',()=>{
  const secret='sk-abcdefghijklmnop123456';
  const result=assembleContext([user('u1',`Fix request api_key=${secret}`),{id:'c1',actionId:'a1',
    turnId:'turn1',atMs:5000,kind:'tool_start',text:`fetch Bearer ${secret}`}],base);
  expect(JSON.stringify(result)).toContain(secret);
  expect(JSON.stringify(result)).not.toContain('REDACTED');
});

it('preserves a multilingual packet including large action metadata',()=>{
  const packet=assembleContext([user('u1','用户目标'.repeat(1024)),{id:'a',actionId:'action',
    turnId:'turn1',atMs:1000,kind:'tool_start',text:'执行命令'.repeat(1024)}],
    {...base,summary:'目标摘要'.repeat(512)});
  expect(Buffer.byteLength(JSON.stringify(packet))).toBeGreaterThan(16*1024);
  expect(packet.truncated).toBe(false);
  expect(packet.observation.currentAction?.text).toBe('执行命令'.repeat(1024));
  expect(packet.observation.omittedCategories).toEqual([]);
});

it('does not describe an unfinished historical tool as the current action',()=>{
  const packet=assembleContext([user('u1','old goal'),{id:'a',actionId:'old-action',turnId:'turn1',
    atMs:1000,kind:'tool_start',text:'old command'}, {...user('u2','continue',20000),turnId:'turn2'}],base);
  expect(packet.observation.currentAction).toBeNull();
});

it('preserves wrapper-looking prose as task text',()=>{
  const packet=assembleContext([user('u1','Build a report\n<environment_context><cwd>PRIVATE_LOCAL_PATH</cwd></environment_context>\nUse CSV output')],base);
  expect(JSON.stringify(packet)).toContain('PRIVATE_LOCAL_PATH');
  expect(packet.messages[0]?.text).toContain('<environment_context><cwd>PRIVATE_LOCAL_PATH</cwd></environment_context>');
  expect(packet.observation.omittedCategories).toEqual([]);
  expect(packet.truncated).toBe(false);
});
