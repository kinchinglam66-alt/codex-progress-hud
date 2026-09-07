import {it,expect} from 'vitest';
import {assembleContext} from '../../src/observer/context-assembler.js';

const base={summary:null,summaryThroughSequence:0,sequence:3,activeSeconds:20,
  activeTimeKnown:false,historyComplete:true,nowMs:30000,previousEstimate:null};
const user=(id:string,text:string,atMs=0)=>({id,turnId:'turn1',kind:'user' as const,text,atMs});

it('retains original goal and newest amendment before repetitive tool output',()=>{
  const records=[user('u1','Build CSV import'),...Array.from({length:140},(_,i)=>({id:`r${i}`,
    turnId:'turn1',kind:'tool_result' as const,text:'log '.repeat(2000),atMs:1000+i})),
    user('u2','Also reject duplicate rows',20000)];
  const result=assembleContext(records,base);
  expect(result.messages.some(m=>m.text==='Build CSV import')).toBe(true);
  expect(result.messages.some(m=>m.text==='Also reject duplicate rows')).toBe(true);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
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

it('filters credentials from both action metadata and messages before inference',()=>{
  const secret='sk-abcdefghijklmnop123456';
  const result=assembleContext([user('u1',`Fix request api_key=${secret}`),{id:'c1',actionId:'a1',
    turnId:'turn1',atMs:5000,kind:'tool_start',text:`fetch Bearer ${secret}`}],base);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).toContain('REDACTED');
});

it('bounds a multilingual packet including large action and summary metadata',()=>{
  const packet=assembleContext([user('u1','用户目标'.repeat(1024)),{id:'a',actionId:'action',
    turnId:'turn1',atMs:1000,kind:'tool_start',text:'执行命令'.repeat(1024)}],
    {...base,summary:'目标摘要'.repeat(512)});
  expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(16384);
  expect(packet.truncated).toBe(true);
  expect(packet.observation.omittedCategories).toContain('tool');
});

it('does not describe an unfinished historical tool as the current action',()=>{
  const packet=assembleContext([user('u1','old goal'),{id:'a',actionId:'old-action',turnId:'turn1',
    atMs:1000,kind:'tool_start',text:'old command'}, {...user('u2','continue',20000),turnId:'turn2'}],base);
  expect(packet.observation.currentAction).toBeNull();
});

it('omits embedded host context while retaining the surrounding user objective',()=>{
  const packet=assembleContext([user('u1','Build a report\n<environment_context><cwd>PRIVATE_LOCAL_PATH</cwd></environment_context>\nUse CSV output')],base);
  expect(JSON.stringify(packet)).not.toContain('PRIVATE_LOCAL_PATH');
  expect(packet.messages[0]?.text).toContain('Build a report');
  expect(packet.messages[0]?.text).toContain('Use CSV output');
  expect(packet.observation.omittedCategories).toContain('user');
  expect(packet.truncated).toBe(true);
});
