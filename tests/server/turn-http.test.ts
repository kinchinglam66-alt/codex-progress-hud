import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgressServer, type ProgressServerOptions } from '../../src/server/http-server.js';
import { CompanionHttpClient } from '../../src/mcp/report-client.js';
import { normalizeHookInput } from '../../src/hooks/adapter.js';
import type { HookName } from '../../src/hooks/schema.js';
import type { HudSnapshot } from '../../src/server/task-store.js';
import { PassiveContextStore } from '../../src/server/passive-context-store.js';
import { PassiveGoals } from '../../src/server/passive-goals.js';
import type {ObserverObservation} from '../../src/estimation/observer-scheduler.js';
import type {ObserverSubscriptionResult} from '../../src/estimation/subscription-session.js';

const cleanups: Array<() => Promise<void>> = [];
const observerTime = () => Math.floor(performance.now());
it.each(['SessionEnd','shutdown'])('records an in-flight cancellation through real HTTP teardown: %s',async mode=>{
  let now=0,active=false,disabled=false,pending:Promise<ObserverSubscriptionResult>|undefined;
  const records:ObserverObservation[]=[];
  const {client,token,server}=await setup({now:()=>now,monotonicNow:()=>now,onObserverObservation:value=>records.push(value),observerWorkers:[{
    observe(_input,signal){active=true;pending=new Promise(resolve=>signal.addEventListener('abort',()=>{
      active=false;resolve({status:'aborted',interpretation:null,usage:{kind:'subscription-tokens',inputTokens:25,outputTokens:0,cachedInputTokens:0}});
    },{once:true}));return pending;},
    status:()=>({active,disabled,poisoned:false}),disable(){disabled=true;},async close(){await pending;}
  }]});
  for(const hook of ['UserPromptSubmit','PostToolUse'] as const){
    const envelope=normalizeHookInput(hook,{session_id:'record-teardown',turn_id:'one',tool_use_id:'tool'},now,token).envelope;
    envelope.content={kind:hook==='UserPromptSubmit'?'user':'tool',text:'private test data',truncated:false};
    await client.submitHook(envelope,{revision:(await client.status() as HudSnapshot).revision});
  }
  now=15000;await expect.poll(()=>active,{timeout:2500}).toBe(true);
  if(mode==='shutdown')await server.close();
  else{
    const end=normalizeHookInput('SessionEnd',{session_id:'record-teardown'},now,token).envelope;
    await client.submitHook(end,{revision:(await client.status() as HudSnapshot).revision});
  }
  await expect.poll(()=>records.filter(value=>value.kind==='result').length).toBe(1);
  expect(records.find(value=>value.kind==='result')).toMatchObject({status:'aborted',accepted:false,activeTimeKnown:false,usage:{inputTokens:25}});
});
it.each([false,true])('keeps current-turn rows correct for late first prompts (newer prompt: %s)',async newer=>{
  const {client,hook,token}=await setup();
  await hook('UserPromptSubmit','a');
  const delayed=normalizeHookInput('UserPromptSubmit',{session_id:'synthetic-session',turn_id:'b'},Date.now()-1000,token).envelope;
  const b=await hook('PostToolUse','b');
  const expected=newer ? await hook('UserPromptSubmit','c') : b;
  await client.submitHook(delayed,{revision:(await client.status() as HudSnapshot).revision});
  const snapshot=await client.status() as HudSnapshot;
  expect(snapshot.tasks.filter(task=>task.isCurrentTurn).map(task=>task.id)).toEqual([expected]);
  expect(snapshot.rows?.map(row=>row.task.id)).toEqual([expected]);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: Pick<ProgressServerOptions, 'observerWorkers'|'now'|'monotonicNow'|'onObserverObservation'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hud-turn-http-'));
  const tokenPath = join(directory, 'auth.token');
  const passiveContexts = new PassiveContextStore();
  const passiveGoals = new PassiveGoals(passiveContexts);
  const server = createProgressServer({ ...options, port: 0, tokenPath, passiveContexts, passiveGoals });
  cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  await server.listen();
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const client = new CompanionHttpClient(server.address().url, tokenPath);
  async function hook(name: HookName, turn?: string, session = 'synthetic-session') {
    const envelope = normalizeHookInput(name, { session_id: session, ...(turn === undefined ? {} : { turn_id: turn }) }, Date.now(), token).envelope;
    const revision = (await client.status() as HudSnapshot).revision;
    await client.submitHook(envelope, { revision });
    return envelope.taskHandle;
  }
  return { server, client, hook, token, passiveContexts, passiveGoals };
}

it('keeps active work and goal visibility stable across wall-clock corrections', async () => {
  let wall = 1000000000, active = 1000;
  const {client, token} = await setup({now: () => wall, monotonicNow: () => active});
  const prompt = normalizeHookInput('UserPromptSubmit', {session_id: 'clock', turn_id: 'clock'}, wall, token).envelope;
  await client.submitHook(prompt, {revision: (await client.status() as HudSnapshot).revision});
  active += 1000; wall += 3600000;
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal?.activeSeconds).toBe(1);
  const tool = normalizeHookInput('PostToolUse', {session_id: 'clock', turn_id: 'clock', tool_use_id: 'one'}, wall, token).envelope;
  await client.submitHook(tool, {revision: (await client.status() as HudSnapshot).revision});
  active += 1000; wall -= 7200000;
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal).toMatchObject({activeSeconds: 2, runtime: 'running'});
});

it.each([
  {hook: 'Stop' as const, status: 'quiescent', runtime: 'waiting'},
  {hook: 'Interrupt' as const, status: 'interrupted', runtime: 'interrupted'}
])('applies $hook through HTTP after the turn activity fence fills', async ({hook, status, runtime}) => {
  let now = 0;
  const {client, token, passiveContexts} = await setup({now: () => now, monotonicNow: () => now});
  let revision = (await client.status() as HudSnapshot).revision;
  const input = {session_id: 'synthetic-capacity-session', turn_id: 'long-turn'};
  const first = normalizeHookInput('UserPromptSubmit', input, now, token).envelope;
  first.content = {kind: 'user', text: 'Synthetic long goal', truncated: false};
  await client.submitHook(first, {revision});
  for (let index = 1; index < 256; index++) {
    now = index;
    revision = (await client.status() as HudSnapshot).revision;
    const tool = normalizeHookInput('PostToolUse', {...input, tool_use_id: `tool-${index}`}, now, token).envelope;
    await client.submitHook(tool, {revision});
  }
  expect((await client.status() as HudSnapshot).tasks.find(task => task.id === first.taskHandle)?.status).toBe('running');
  now = 300;
  const terminal = normalizeHookInput(hook, input, now, token).envelope;
  if (hook === 'Stop') terminal.content = {kind: 'assistant', text: 'Synthetic final response', truncated: false};
  revision = (await client.status() as HudSnapshot).revision;
  await client.submitHook(terminal, {revision});
  const snapshot = await client.status() as HudSnapshot;
  expect(snapshot.tasks.find(task => task.id === first.taskHandle)?.status).toBe(status);
  expect(snapshot.rows?.find(row => row.task.id === first.taskHandle)?.goal?.runtime).toBe(runtime);
  if (hook === 'Stop') expect(passiveContexts.read(first.sessionKey)?.entries.at(-1)?.content.text).toBe('Synthetic final response');
});

it('does not reuse an injected wall clock as the default active-work clock', async () => {
  let wall = 1000000000;
  const {client, token} = await setup({now: () => wall});
  const prompt = normalizeHookInput('UserPromptSubmit', {session_id: 'wall-only', turn_id: 'one'}, wall, token).envelope;
  await client.submitHook(prompt, {revision: (await client.status() as HudSnapshot).revision});
  wall += 3600000;
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal?.activeSeconds).toBeLessThan(5);
  wall -= 7200000;
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal?.runtime).toBe('running');
});

it('automatically pumps accepted private Hook context to an explicitly supplied offline observer', async () => {
  let now = 0, calls = 0, disabled = false;
  const observations:unknown[]=[];
  const {client, token, passiveGoals} = await setup({onObserverObservation:record=>observations.push(record),now: () => now, monotonicNow: () => now, observerWorkers: [{
    async observe(input) {
      expect(input.messages.map(message => message.text)).toEqual(['PRIVATE goal', 'tool result']);
      calls++;
      return {status: 'interpreted', interpretation: {relation: 'replace', status: 'running', summary: 'PRIVATE summary',
        estimate: {remainingSeconds: 600, errorPercent: 30}},
        usage: {kind: 'subscription-tokens', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0}};
    }, status: () => ({active: false, disabled, poisoned: false}), disable() {disabled = true;}, async close() {disabled = true;}
  }]});
  const prompt = normalizeHookInput('UserPromptSubmit', {session_id: 'synthetic-session', turn_id: 'auto'}, now, token).envelope;
  prompt.content = {kind: 'user', text: 'PRIVATE goal', truncated: false};
  await client.submitHook(prompt, {revision: (await client.status() as HudSnapshot).revision});
  now = 1000;
  const tool = normalizeHookInput('PostToolUse', {session_id: 'synthetic-session', turn_id: 'auto', tool_use_id: 'tool'}, now, token).envelope;
  tool.content = {kind: 'tool', text: 'tool result', truncated: false};
  await client.submitHook(tool, {revision: (await client.status() as HudSnapshot).revision});
  expect(calls).toBe(0);
  now = 15000;
  await expect.poll(() => calls, {timeout: 2500}).toBe(1);
  expect(passiveGoals.view(prompt.sessionKey, now)?.prediction).toMatchObject({remainingSeconds: 600, errorPercent: 30});
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal).toMatchObject({
    runtime: 'running', estimateRevision: 1, sampledAtMs: 15000,
    prediction: {remainingSeconds: 600, errorPercent: 30}
  });
  expect(JSON.stringify(await client.status())).not.toContain('PRIVATE');
  expect(observations).toContainEqual(expect.objectContaining({kind:'result',accepted:true,estimate:{remainingSeconds:600,errorPercent:30}}));
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');
});

it('routes accepted Hook context to the independent goal owner without publishing private input', async () => {
  const {client, token, passiveGoals, hook} = await setup();
  const envelope = normalizeHookInput('UserPromptSubmit', {
    session_id: 'synthetic-session', turn_id: 'independent'
  }, Date.now(), token).envelope;
  envelope.content = {kind: 'user', text: 'PRIVATE independent goal', truncated: false};
  await client.submitHook(envelope, {revision: (await client.status() as HudSnapshot).revision});
  const request = passiveGoals.request(envelope.sessionKey, observerTime());
  expect(request?.input.messages[0]?.text).toBe('PRIVATE independent goal');
  expect(passiveGoals.settle(request!.ticket, {relation: 'replace', status: 'running',
    summary: 'PRIVATE summary', estimate: {remainingSeconds: 3600, errorPercent: 50}}, observerTime())).toBe(true);
  expect(JSON.stringify(await client.status())).not.toContain('PRIVATE');
  await client.submit({taskId: envelope.taskHandle, event: {type: 'tracking_paused'}});
  expect(passiveGoals.view(envelope.sessionKey, observerTime())?.status).toBe('paused');
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal?.runtime).toBe('paused');
  await client.submit({taskId: envelope.taskHandle, event: {type: 'tracking_resumed'}});
  expect(passiveGoals.view(envelope.sessionKey, observerTime())?.status).toBe('running');
  await hook('SessionEnd');
  expect(passiveGoals.view(envelope.sessionKey, observerTime())).toBeNull();
  expect((await client.status() as HudSnapshot).rows).toEqual([]);
});

it('keeps an unfinished goal after Stop but hides independent completion on the HTTP snapshot', async () => {
  const {client, token, passiveGoals, hook} = await setup();
  const prompt = normalizeHookInput('UserPromptSubmit', {session_id: 'synthetic-session', turn_id: 'whole'}, Date.now(), token).envelope;
  prompt.content = {kind: 'user', text: 'PRIVATE whole goal', truncated: false};
  await client.submitHook(prompt, {revision: (await client.status() as HudSnapshot).revision});
  await hook('Stop', 'whole');
  expect((await client.status() as HudSnapshot).rows?.[0]?.goal).toMatchObject({runtime: 'waiting', status: 'unknown'});
  const request = passiveGoals.request(prompt.sessionKey, observerTime())!;
  expect(passiveGoals.settle(request.ticket, {relation: 'replace', status: 'completed',
    summary: 'PRIVATE done', estimate: null}, observerTime())).toBe(true);
  expect((await client.status() as HudSnapshot).rows).toEqual([]);
});

it('publishes only the final paused goal state to the live event stream', async () => {
  const {client, token, server, hook} = await setup();
  const taskId = await hook('UserPromptSubmit', 'stream-pause');
  const before = await client.status() as HudSnapshot;
  const controller = new AbortController();
  const stream = await fetch(`${server.address().url}/api/events?afterRevision=${before.revision}`, {
    headers: {authorization: `Bearer ${token}`}, signal: controller.signal
  });
  const reader = stream.body!.getReader();
  try {
    const pending = reader.read();
    await client.submit({taskId, event: {type: 'tracking_paused'}});
    const frame = await pending;
    const events = new TextDecoder().decode(frame.value).split('\n\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as HudSnapshot);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.rows?.[0]?.goal?.runtime).toBe('paused');
  } finally {controller.abort(); await reader.cancel().catch(() => undefined);}
});

it.each(['tracking_resumed', 'tracking_stopped'] as const)('does not apply a rejected %s to a waiting passive goal', async type => {
  const {client, hook, token, passiveGoals} = await setup();
  const taskId = await hook('UserPromptSubmit', 'waiting');
  const sessionKey = normalizeHookInput('Stop', {session_id: 'synthetic-session', turn_id: 'waiting'}, Date.now(), token).envelope.sessionKey;
  await hook('Stop', 'waiting');
  const before = passiveGoals.view(sessionKey, observerTime());
  expect(before?.runtime).toBe('waiting');
  await client.submit({taskId, event: {type}});
  expect(passiveGoals.view(sessionKey, observerTime())).toEqual(before);
});

it('allows fresh tracking in the same conversation after an accepted manual stop', async () => {
  const {client, hook, token, passiveGoals} = await setup();
  const taskId = await hook('UserPromptSubmit', 'before-stop');
  const sessionKey = normalizeHookInput('Stop', {session_id: 'synthetic-session'}, Date.now(), token).envelope.sessionKey;
  await client.submit({taskId, event: {type: 'tracking_stopped'}});
  expect(passiveGoals.view(sessionKey, observerTime())?.status).toBe('stopped');
  await hook('UserPromptSubmit', 'after-stop');
  expect(passiveGoals.view(sessionKey, observerTime())).toMatchObject({runtime: 'running', prediction: null});
});

it('admits a fresh passive goal after 32 conversations have been manually stopped', async () => {
  const {client, hook, token, passiveGoals} = await setup();
  for (let index = 0; index < 32; index++) {
    const envelope = normalizeHookInput('UserPromptSubmit', {session_id: `stopped-${index}`, turn_id: 'one'}, Date.now(), token).envelope;
    envelope.content = {kind: 'user', text: 'old private goal', truncated: false};
    await client.submitHook(envelope, {revision: (await client.status() as HudSnapshot).revision});
    await client.submit({taskId: envelope.taskHandle, event: {type: 'tracking_stopped'}});
  }
  const fresh = normalizeHookInput('UserPromptSubmit', {session_id: 'fresh-33rd', turn_id: 'one'}, Date.now(), token).envelope;
  fresh.content = {kind: 'user', text: 'new private goal', truncated: false};
  await client.submitHook(fresh, {revision: (await client.status() as HudSnapshot).revision});
  expect(passiveGoals.view(fresh.sessionKey, observerTime())?.runtime).toBe('running');
  expect(passiveGoals.request(fresh.sessionKey, observerTime())?.input.messages[0]?.text).toBe('new private goal');
});

it('retains accepted content privately, fences duplicate delivery and clears on session end', async () => {
  const {client, token, passiveContexts, hook} = await setup();
  const envelope = normalizeHookInput('UserPromptSubmit', {
    session_id: 'synthetic-session', turn_id: 'private-turn'
  }, Date.now(), token).envelope;
  envelope.content = {kind: 'user', text: 'PRIVATE-CONTEXT-SENTINEL', truncated: false};
  await client.submitHook(envelope, {revision: (await client.status() as HudSnapshot).revision});
  expect(passiveContexts.read(envelope.sessionKey)?.entries[0]?.content.text).toBe('PRIVATE-CONTEXT-SENTINEL');
  await client.submitHook(envelope, {revision: (await client.status() as HudSnapshot).revision});
  expect(passiveContexts.read(envelope.sessionKey)?.entries).toHaveLength(1);
  expect(JSON.stringify(await client.status())).not.toContain('PRIVATE-CONTEXT-SENTINEL');
  await hook('SessionEnd');
  expect(passiveContexts.read(envelope.sessionKey)).toBeNull();
});

it('rejects stale content before ingestion and clears private content on close', async () => {
  const {client, token, passiveContexts, server} = await setup();
  const envelope = normalizeHookInput('UserPromptSubmit', {
    session_id: 'private-session', turn_id: 'private-turn'
  }, Date.now(), token).envelope;
  envelope.content = {kind: 'user', text: 'private goal', truncated: false};
  await expect(client.submitHook(envelope, {revision: 99999})).rejects.toMatchObject({code: 'STALE_REVISION'});
  expect(passiveContexts.read(envelope.sessionKey)).toBeNull();
  await client.submitHook(envelope, {revision: (await client.status() as HudSnapshot).revision});
  expect(passiveContexts.read(envelope.sessionKey)).not.toBeNull();
  await server.close();
  expect(passiveContexts.stats().chars).toBe(0);
});

it('clears session content even when private ingestion has reached its event limit', async () => {
  const {client, token, passiveContexts, hook} = await setup();
  const envelope = normalizeHookInput('UserPromptSubmit', {
    session_id: 'synthetic-session', turn_id: 'private-turn'
  }, Date.now(), token).envelope;
  envelope.content = {kind: 'user', text: 'must be cleared', truncated: false};
  await client.submitHook(envelope, {revision: (await client.status() as HudSnapshot).revision});
  const {content: _content, ...identity} = envelope;
  for (let index = 0; index < 4095; index++) {
    expect(passiveContexts.ingest({...identity, hook: 'Interrupt', eventId: `evt_cap_${index}`}, Date.now())).toBe(true);
  }
  await hook('SessionEnd');
  expect(passiveContexts.read(envelope.sessionKey)).toBeNull();
});

it('rejects capacity overflow before consuming Hook identity and accepts a later retry', async () => {
  const { client, hook } = await setup();
  const handles: string[] = [];
  for (let i = 0; i < 32; i++) handles.push(await hook('UserPromptSubmit', 'first', `synthetic-${i}`));
  await expect(hook('UserPromptSubmit', 'overflow', 'synthetic-overflow'))
    .rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' });
  let snapshot = await client.status() as HudSnapshot;
  expect(snapshot.tasks).toHaveLength(32);
  expect(snapshot.tasks.every(task => task.isCurrentTurn)).toBe(true);
  expect(snapshot.turnTracking?.capacityReached).toBe(true);
  await client.submit({ taskId: handles[0]!, event: { type: 'tracking_stopped' } });
  const admitted = await hook('UserPromptSubmit', 'overflow', 'synthetic-overflow');
  snapshot = await client.status() as HudSnapshot;
  expect(snapshot.tasks.find(task => task.id === admitted)).toMatchObject({ isCurrentTurn: true, status: 'running' });
});

it('creates fresh identified turns, groups history, and reports terminal no-ops honestly', async () => {
  const { client, hook } = await setup();
  const a = await hook('UserPromptSubmit', 'a');
  await hook('Interrupt', 'a');
  const b = await hook('UserPromptSubmit', 'b');
  expect(a).not.toBe(b);
  let snapshot = await client.status() as HudSnapshot;
  expect(snapshot.selectedTaskId).toBe(b);
  expect(snapshot.selected?.task.verificationEvidence).toBeUndefined();
  expect(snapshot.tasks.find(task => task.id === a)).toMatchObject({ status: 'interrupted', isCurrentTurn: false });
  expect(snapshot.tasks.find(task => task.id === b)?.conversationKey).toBe(snapshot.tasks.find(task => task.id === a)?.conversationKey);
  await expect(hook('PostToolUse', 'a')).rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' });
  await expect(hook('Interrupt', 'a')).rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' });
  snapshot = await client.status() as HudSnapshot;
  expect(snapshot.selectedTaskId).toBe(b);
  expect(snapshot.selected?.task.status).toBe('running');
});

it('does not create turns from attachment or unkeyed terminal activity', async () => {
  const { client, hook } = await setup();
  await hook('SessionStart');
  expect((await client.status() as HudSnapshot).tasks).toHaveLength(0);
  const b = await hook('UserPromptSubmit', 'b');
  await hook('Stop');
  const snapshot = await client.status() as HudSnapshot;
  expect(snapshot.selectedTaskId).toBe(b);
  expect(snapshot.selected?.task.status).toBe('running');
  expect(snapshot.turnTracking?.identityUnavailable).toBe(true);
});

it('does not let older unfinished-turn activity steal follow selection', async () => {
  const { client, hook } = await setup();
  await hook('UserPromptSubmit', 'a');
  const b = await hook('UserPromptSubmit', 'b');
  await hook('PostToolUse', 'a');
  expect((await client.status() as HudSnapshot).selectedTaskId).toBe(b);
});

it('does not recreate an evicted turn through either a control or a late Hook', async () => {
  const { client, hook } = await setup();
  const a = await hook('UserPromptSubmit', 'evicted');
  await hook('Interrupt', 'evicted');
  for (let index = 0; index < 32; index++) await hook('UserPromptSubmit', `next-${index}`);
  expect((await client.status() as HudSnapshot).tasks.some(task => task.id === a)).toBe(false);
  await expect(client.submit({ taskId: a, event: { type: 'tracking_resumed' } })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  await expect(hook('PostToolUse', 'evicted')).rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' });
  expect((await client.status() as HudSnapshot).tasks.some(task => task.id === a)).toBe(false);
});

it('reports terminal Hook updates as not applied', async () => {
  const { client, hook } = await setup();
  const a = await hook('UserPromptSubmit', 'a');
  await hook('Interrupt', 'a');
  await expect(hook('PostToolUse', 'a')).rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' });
  await expect(hook('PostToolUse', 'a')).rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' });
});

it('rejects legacy conversation-scoped protocol writes before changing state', async () => {
  const { server, token, client } = await setup();
  const response = await fetch(`${server.address().url}/api/events`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-codex-progress-hud-protocol': '1' },
    body: JSON.stringify({ taskId: 'legacy', event: { type: 'tracking_started' } })
  });
  expect(response.status).toBe(426);
  expect(await response.json()).toMatchObject({ code: 'VERSION_MISMATCH' });
  expect((await client.status() as HudSnapshot).tasks).toHaveLength(0);
});

it('reports a protocol mismatch for legacy Hook payloads before parsing their schema', async () => {
  const { server, token, client } = await setup();
  const response = await fetch(`${server.address().url}/api/hooks/events`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-codex-progress-hud-protocol': '1' },
    body: JSON.stringify({ schemaVersion: 1, hook: 'SessionStart' })
  });
  expect(response.status).toBe(426);
  expect(await response.json()).toMatchObject({ code: 'VERSION_MISMATCH' });
  expect((await client.status() as HudSnapshot).tasks).toHaveLength(0);
});
