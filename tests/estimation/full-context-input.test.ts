import {afterEach,expect,it,vi} from 'vitest';
import {packObserverInput} from '../../src/estimation/observer-input.js';
import {observerInputSchema} from '../../src/estimation/observer-contract.js';
import {assembleContext} from '../../src/observer/context-assembler.js';
import type {ContextRepresentation,PreparedContext} from '../../src/estimation/prepared-context.js';

const base={goalSummary:null,activeSeconds:90,runtime:'running' as const,truncated:false};

afterEach(()=>vi.unstubAllEnvs());

it('round-trips every large readable message without clipping or filtering',()=>{
  const credentialLike='sk-test-not-a-real-key';
  const messages=Array.from({length:201},(_,index)=>({
    kind:index%3===0?'user' as const:index%3===1?'assistant' as const:'tool' as const,
    text:`record-${index} ${credentialLike} <environment_context>keep this prose</environment_context> `+'x'.repeat(1600),
    truncated:false,
  }));
  const input={...base,messages};

  const packed=JSON.parse(packObserverInput(input));

  expect(packed.messages.map((message:{text:string})=>message.text)).toEqual(messages.map(message=>message.text));
  expect(packed.messages).toHaveLength(201);
  expect(packed.messages[0].text).toContain(credentialLike);
  expect(packed.messages[0].text).toContain('<environment_context>keep this prose</environment_context>');
  expect(packed.messages.at(-1).text).toBe(messages.at(-1)?.text);
});

it('preserves earlier background records and current-turn metadata without filtering task text',()=>{
  const credentialLike='sk-test-not-a-real-key';
  const records=[
    {id:'prior-user',turnId:'prior',kind:'user' as const,atMs:1,text:`Earlier requirement ${credentialLike}`},
    {id:'prior-assistant',turnId:'prior',kind:'assistant' as const,atMs:2,text:'Earlier answer <permissions>plain prose</permissions>'},
    {id:'current-user',turnId:'current',kind:'user' as const,atMs:3,text:'Current request'},
    {id:'current-start',turnId:'current',kind:'tool_start' as const,actionId:'action',atMs:4,text:'tool '.repeat(3000)},
  ];

  const result=assembleContext(records,{summary:null,summaryThroughSequence:0,sequence:4,activeSeconds:90,
    activeTimeKnown:true,historyComplete:false,nowMs:5000,previousEstimate:null,currentTurnId:'current'});

  expect(result.messages.map(message=>message.text)).toEqual(records.map(record=>record.text));
  expect(result.messages.map(message=>message.scope)).toEqual(['background','background','current','current']);
  expect(result.observation.historyComplete).toBe(false);
  expect(result.observation.currentAction?.text).toBe(records.at(-1)?.text);
  expect(result.messages[0]?.text).toContain(credentialLike);
});

it('accepts strict representation and history-summary metadata on legacy-shaped inputs',()=>{
  const input={...base,messages:[{kind:'user' as const,text:'task',truncated:false}],representation:{
    mode:'compressed' as const,sourceComplete:true,originalRecords:12,compressedThroughOrdinal:4,sizing:'conservative' as const,
  },historySummary:{text:'earlier work',firstOrdinal:0,lastOrdinal:4}};

  expect(observerInputSchema.parse(input)).toMatchObject(input);
  expect(JSON.parse(packObserverInput(input))).toMatchObject(input);
});

it('keeps prepared-context types separate from the legacy observer input shape',()=>{
  const representation:ContextRepresentation={mode:'full',sourceComplete:true,originalRecords:1,
    compressedThroughOrdinal:null,sizing:'tokenizer'};
  const prepared:PreparedContext={input:observerInputSchema.parse({...base,
    messages:[{kind:'user' as const,text:'task',truncated:false}]}),representation};

  expect(prepared.representation).toEqual(representation);
});

it('rejects empty text, NaN clocks, invalid pair roles and inconsistent metadata',()=>{
  const valid={...base,messages:[{kind:'user' as const,text:'task',truncated:false}]};
  const invalid=[
    {...valid,messages:[{kind:'user' as const,text:'',truncated:false}]},
    {...valid,activeSeconds:Number.NaN},
    {...valid,messages:[{kind:'user' as const,text:'task',truncated:false,event:{ordinal:0,kind:'tool_result' as const,atMs:0}}]},
    {...valid,representation:{mode:'compressed' as const,sourceComplete:true,originalRecords:1,compressedThroughOrdinal:null,sizing:'conservative' as const}},
    {...valid,historySummary:{text:'earlier',firstOrdinal:4,lastOrdinal:2}},
  ];

  for(const input of invalid)expect(()=>packObserverInput(input)).toThrow('INVALID_OBSERVER_INPUT');
});

it('refreshes pair metadata without changing messages, measurements or text',()=>{
  const input={...base,messages:[
    {kind:'user' as const,text:'task',truncated:false},
    {kind:'tool' as const,text:'start',truncated:false,event:{ordinal:1,kind:'tool_start' as const,atMs:1,pairOrdinal:7}},
    {kind:'tool' as const,text:'result',truncated:false,event:{ordinal:2,kind:'tool_result' as const,atMs:2,pairOrdinal:7}},
  ],paceMeasurements:[{measurementRef:'pm_0123456789abcdef0123456789abcdef',workClass:'file_processing' as const,
    unit:'file' as const,sampleCount:3,medianSecondsPerUnit:2,clock:'tool_execution' as const}],
    packingLoss:{suppliedMessages:3,retainedMessages:3,droppedByKind:{user:0,assistant:0,tool:0},clippedMessages:0}};

  const packed=JSON.parse(packObserverInput(input));

  expect(packed.messages.map((message:{text:string})=>message.text)).toEqual(['task','start','result']);
  expect(packed.messages[1].event).toMatchObject({pairOrdinal:7,counterpartMissing:false});
  expect(packed.messages[2].event).toMatchObject({pairOrdinal:7,counterpartMissing:false});
  expect(packed.paceMeasurements).toHaveLength(1);
  expect(packed.packingLoss).toMatchObject({retainedMessages:3,clippedMessages:0});
});

it('does not serialize capacity configuration or other environment values',()=>{
  vi.stubEnv('CODEX_PROGRESS_HUD_CONTEXT_KIB','64');
  const packed=packObserverInput({...base,messages:[{kind:'user' as const,text:'task',truncated:false}]});

  expect(packed).not.toContain('CODEX_PROGRESS_HUD_CONTEXT_KIB');
});
