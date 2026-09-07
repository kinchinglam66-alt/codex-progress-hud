import {expect, it} from 'vitest';
import {packObserverInput} from '../../src/estimation/observer-input.js';

const small = {goalSummary: 'Finish the report', activeSeconds: 90, runtime: 'running',
  messages: [{kind: 'user', text: 'Continue the analysis', truncated: false}], truncated: false};

it('preserves useful small inputs and leaves the caller data unchanged', () => {
  expect(JSON.parse(packObserverInput(small))).toEqual(small);
  expect(small.messages[0]?.text).toBe('Continue the analysis');
});
it('filters obvious credentials before transmission, including generated summaries', () => {
  const packed = packObserverInput({...small, goalSummary: 'password=summary-secret',
    messages: [{kind: 'user', text: 'Build it api_key=message-secret', truncated: false}]});
  expect(packed).not.toMatch(/summary-secret|message-secret/);
  expect(packed).toContain('REDACTED');
});
it('fits UTF-8 bytes while retaining the latest user and final answer with truncation flags', () => {
  const input = {...small, goalSummary: '目标'.repeat(1024), messages: [
    {kind: 'tool', text: 'old tool'.repeat(400), truncated: false},
    {kind: 'user', text: '问'.repeat(4096), truncated: false},
    {kind: 'tool', text: '中'.repeat(4096), truncated: false},
    {kind: 'assistant', text: '答'.repeat(4096), truncated: false}
  ]};
  const packed = packObserverInput(input), decoded = JSON.parse(packed);
  expect(Buffer.byteLength(packed)).toBeLessThanOrEqual(16384);
  expect(decoded.truncated).toBe(true);
  expect(decoded.messages.map((message: {kind: string}) => message.kind)).toEqual(['user', 'assistant']);
  expect(decoded.messages.some((message: {truncated: boolean}) => message.truncated)).toBe(true);
  expect(decoded.goalSummary).toBe(input.goalSummary);
});
it('does not split emoji surrogate pairs when clipping a packet', () => {
  const packed = packObserverInput({...small, goalSummary: '概'.repeat(2048), messages: [
    {kind: 'user', text: '😀'.repeat(2048), truncated: false},
    {kind: 'assistant', text: '😀'.repeat(2048), truncated: false}
  ]});
  expect(Buffer.byteLength(packed)).toBeLessThanOrEqual(16384);
  expect(packed).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
  expect(JSON.parse(packed).truncated).toBe(true);
});
it('rejects unexpected identity, unbounded content and invalid clocks without echoing input', () => {
  for (const input of [{...small, sessionKey: 'PRIVATE'}, {...small, activeSeconds: Infinity},
    {...small, messages: [{kind: 'user', text: 'x'.repeat(4097), truncated: false}]}]) {
    expect(() => packObserverInput(input)).toThrow('INVALID_OBSERVER_INPUT');
  }
});

it('marks clipping caused by redaction expansion and still respects field bounds', () => {
  const decoded = JSON.parse(packObserverInput({...small, goalSummary: 'password=x '.repeat(180),
    messages: [{kind: 'user', text: 'password=x '.repeat(360), truncated: false}]}));
  expect(decoded.goalSummary.length).toBeLessThanOrEqual(2048);
  expect(decoded.messages[0].text.length).toBeLessThanOrEqual(4096);
  expect(decoded.messages[0].truncated).toBe(true);
  expect(decoded.truncated).toBe(true);
});

it('retains the initial requirement and intermediate amendments before old tool logs',()=>{
  const messages=[{kind:'user',text:'INITIAL '+ '目'.repeat(2000),truncated:false},
    {kind:'user',text:'AMENDMENT reject duplicates',truncated:false},
    ...Array.from({length:8},()=>({kind:'tool',text:'日志'.repeat(1800),truncated:false})),
    {kind:'user',text:'LATEST '+ '新'.repeat(2000),truncated:false},
    {kind:'assistant',text:'Working',truncated:false}];
  const packed=packObserverInput({...small,messages});
  expect(packed).toContain('INITIAL');expect(packed).toContain('LATEST');
  expect(packed).toContain('AMENDMENT');
  expect(Buffer.byteLength(packed)).toBeLessThanOrEqual(16384);
});

it('rejects contradictory event types and tool pairing on user messages',()=>{
  for(const event of [{ordinal:0,atMs:0,kind:'tool_result',pairOrdinal:0},
    {ordinal:0,atMs:0,kind:'user',pairOrdinal:0},
    {ordinal:0,atMs:0,kind:'user',counterpartMissing:false}]){
    expect(()=>packObserverInput({...small,messages:[{...small.messages[0],event}]})).toThrow('INVALID_OBSERVER_INPUT');
  }
});

it('marks equal-length filtering and remains stable on repacking',()=>{
  const packed=packObserverInput({...small,messages:[{kind:'user',text:'password=abcdefghij',truncated:false}]});
  const decoded=JSON.parse(packed);
  expect(decoded.messages[0]).toMatchObject({text:'password=[REDACTED]',truncated:true});
  expect(decoded.truncated).toBe(true);
  expect(packObserverInput(decoded)).toBe(packed);
});
