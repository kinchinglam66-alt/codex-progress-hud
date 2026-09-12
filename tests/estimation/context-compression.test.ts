import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompressionAdapter, serializeCompressionTransport, serializeObserverTransport, serializeSubscriptionTransport, type CompressionRequest, type CompressionSummary} from '../../src/estimation/context-compression.js';
import {createCompressionOutputParser} from '../../src/estimation/codex-output.js';
import {openSubscriptionLedger} from '../../src/estimation/subscription-ledger.js';
import {createOwnedProcessRunner} from '../../src/estimation/owned-process.js';
import {createSubscriptionCompressionSession} from '../../src/estimation/subscription-session.js';
import {createObserverApiCompressionAdapter} from '../../src/estimation/observer-api-provider.js';

const request: CompressionRequest = {text: 'older user and tool records', firstOrdinal: 0, lastOrdinal: 4};
const summary: CompressionSummary = {text: 'Older work remains unresolved.', firstOrdinal: 0, lastOrdinal: 4};
const usage = {kind: 'subscription-tokens' as const, inputTokens: 12, outputTokens: 5, cachedInputTokens: null};
const directories: string[] = [];
const sessions: Array<{close(): Promise<void>}> = [];

afterEach(async () => {
  for (const session of sessions.splice(0).reverse()) await session.close().catch(() => undefined);
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

function compressionStream(value: unknown, includeUsage = true): string {
  const events = [
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'answer', type: 'agent_message', text: JSON.stringify(value)}},
    {type: 'turn.completed', ...(includeUsage ? {usage: {input_tokens: 4, output_tokens: 2, cached_input_tokens: 0}} : {})},
  ];
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

async function compressionSession(code: string) {
  const directory = await mkdtemp(join(tmpdir(), 'hud-compression-'));
  directories.push(directory);
  const ledger = await openSubscriptionLedger(directory, {maxStarts: 6, maxKnownTokens: 50_000});
  const runner = createOwnedProcessRunner({timeoutMs: 1_000});
  const session = createSubscriptionCompressionSession({
    ledger, runner, authorize: () => true,
    prepare: () => ({executable: process.execPath, cwd: directory, args: ['-e', code], env: process.env, input: ''}),
  });
  sessions.push(session);
  sessions.push({close: () => ledger.close()});
  return {session, ledger};
}

it('binds identity and reports accounted usage separately from the summary', async () => {
  const settled: unknown[] = [];
  const dispatch = vi.fn(async (_value: CompressionRequest, _signal: AbortSignal, identity: {conversationKey: string; turnGeneration: number}) => {
    expect(identity).toEqual({conversationKey: 'conversation-a', turnGeneration: 7});
    return {summary, usage};
  });
  const adapter = createCompressionAdapter({
    conversationKey: 'conversation-a', turnGeneration: 7, authorize: () => true, dispatch,
    onSettled: value => settled.push(value),
  });

  await expect(adapter.summarize(request, new AbortController().signal)).resolves.toEqual(summary);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(settled).toEqual([usage]);
});

it('rejects mismatched coverage while retaining the provider usage callback', async () => {
  const settled: unknown[] = [];
  const dispatch = vi.fn(async () => ({summary: {...summary, lastOrdinal: 3}, usage}));
  const adapter = createCompressionAdapter({
    conversationKey: 'conversation-a', turnGeneration: 7, authorize: () => true, dispatch,
    onSettled: value => settled.push(value),
  });

  await expect(adapter.summarize(request, new AbortController().signal)).rejects.toThrow('COMPRESSION_COVERAGE_INVALID');
  expect(settled).toEqual([usage]);
});

it('does not dispatch when cancelled before preparation and single-flights an exact prefix', async () => {
  const dispatch = vi.fn(async () => ({summary, usage}));
  const adapter = createCompressionAdapter({conversationKey: 'conversation-a', turnGeneration: 7, authorize: () => true, dispatch});
  const cancelled = new AbortController();
  cancelled.abort();

  await expect(adapter.summarize(request, cancelled.signal)).rejects.toThrow('COMPRESSION_ABORTED');
  await expect(Promise.all([
    adapter.summarize(request, new AbortController().signal),
    adapter.summarize(request, new AbortController().signal),
  ])).resolves.toEqual([summary, summary]);
  await expect(adapter.summarize(request, new AbortController().signal)).resolves.toEqual(summary);
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('rejects an unauthorized or malformed request without invoking the provider', async () => {
  const dispatch = vi.fn(async () => ({summary, usage}));
  const adapter = createCompressionAdapter({conversationKey: 'conversation-a', turnGeneration: 7, authorize: () => false, dispatch});

  await expect(adapter.summarize({...request, firstOrdinal: -1}, new AbortController().signal)).rejects.toThrow('COMPRESSION_REQUEST_INVALID');
  await expect(adapter.summarize(request, new AbortController().signal)).rejects.toThrow('COMPRESSION_UNAUTHORIZED');
  expect(dispatch).not.toHaveBeenCalled();
});

it('keeps late usage when summary JSON is malformed and rejects tool output', () => {
  const parser = createCompressionOutputParser();
  const lines = [
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'answer', type: 'agent_message', text: '{not-json'}},
    {type: 'turn.completed', usage: {input_tokens: 9, output_tokens: 2, cached_input_tokens: 0}},
  ].map(value => `${JSON.stringify(value)}\n`).join('');
  parser.push(new TextEncoder().encode(lines));
  expect(parser.end()).toMatchObject({summary: null, usage: {inputTokens: 9, outputTokens: 2}, framingValid: true});

  const malicious = createCompressionOutputParser();
  malicious.push(new TextEncoder().encode(JSON.stringify({type: 'item.completed', item: {id: 'tool', type: 'function_call', name: 'delete'}}) + '\n'));
  expect(malicious.end().error).toBe('unexpected_tool');
});

it('accounts a successful subscription summary through the owned session', async () => {
  const {session, ledger} = await compressionSession(`process.stdout.write(${JSON.stringify(compressionStream(summary))})`);
  await expect(session.summarize(request, new AbortController().signal)).resolves.toMatchObject({summary, usage: {inputTokens: 4, outputTokens: 2}});
  expect(ledger.snapshot()).toMatchObject({starts: 1, knownTokens: 6, unknown: 0, unresolved: 0});
});

it('settles usage for an invalid subscription summary and rejects malicious tool output', async () => {
  const invalid = await compressionSession(`process.stdout.write(${JSON.stringify(compressionStream({text: 'wrong', firstOrdinal: 0, lastOrdinal: 3}))})`);
  await expect(invalid.session.summarize(request, new AbortController().signal)).rejects.toThrow('COMPRESSION_COVERAGE_INVALID');
  expect(invalid.ledger.snapshot()).toMatchObject({starts: 1, knownTokens: 6, unknown: 0});

  const tool = await compressionSession(`process.stdout.write(${JSON.stringify(JSON.stringify({type: 'item.completed', item: {id: 'tool', type: 'function_call', name: 'delete'}}) + '\n')})`);
  await expect(tool.session.summarize(request, new AbortController().signal)).rejects.toThrow('COMPRESSION_PROVIDER_FAILED');
  expect(tool.ledger.snapshot()).toMatchObject({starts: 1, unknown: 1, unresolved: 0});
});

it('preserves accounted usage and distinguishes a summary-session accounting failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hud-compression-accounting-'));
  directories.push(directory);
  const ledger = await openSubscriptionLedger(directory, {maxStarts: 6, maxKnownTokens: 50_000});
  const failingLedger = {...ledger, settle: async () => { throw new Error('journal unavailable'); }};
  const session = createSubscriptionCompressionSession({
    ledger: failingLedger, runner: createOwnedProcessRunner({timeoutMs: 1_000}), authorize: () => true,
    prepare: () => ({executable: process.execPath, cwd: directory, args: ['-e', `process.stdout.write(${JSON.stringify(compressionStream(summary))})`], env: process.env, input: ''}),
  });
  sessions.push(session);
  sessions.push({close: () => ledger.close()});
  await expect(session.summarize(request, new AbortController().signal)).rejects.toMatchObject({
    name: 'CompressionDispatchError', message: 'COMPRESSION_ACCOUNTING_FAILED', usage: {inputTokens: 4, outputTokens: 2},
  });
  expect(ledger.snapshot()).toMatchObject({starts: 1, knownTokens: 0, unknown: 0});
});

it('uses the API transport and compression purpose without granting tool authority', async () => {
  const settled: Array<{id: string; usage: unknown}> = [];
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {instructions: string; input: string; text: {format: {schema: unknown}}};
    expect(body.instructions).toContain('read-only');
    expect(JSON.parse(body.input)).toMatchObject({text: request.text, firstOrdinal: 0, lastOrdinal: 4});
    return new Response(JSON.stringify({status: 'completed', output: [{type: 'message', role: 'assistant', content: [
      {type: 'output_text', text: JSON.stringify(summary)},
    ]}], usage: {input_tokens: 7, output_tokens: 3, input_tokens_details: {cached_tokens: 0}}}), {status: 200});
  });
  const accounting = {
    reserve: vi.fn(async () => ({id: 'api-compression', profileId: 'profile', generation: 3})),
    markDispatch: vi.fn(async () => undefined),
    settle: vi.fn(async (id: string, value: unknown) => {settled.push({id, usage: value});}),
    cancelBeforeDispatch: vi.fn(async () => undefined),
  };
  const adapter = createObserverApiCompressionAdapter({
    config: {profileId: 'profile', name: 'fixture', baseUrl: 'https://example.invalid', protocol: 'responses', model: 'model', keyRef: 'key', maxOutputTokens: 64, dailyCallLimit: 4},
    generation: 3, readKey: async () => 'fixture-key', transport, accounting,
    instructions: 'read-only summary instructions', schema: {type: 'object'},
    conversationKey: 'conversation-a', turnGeneration: 7, authorize: () => true,
  });

  await expect(adapter.summarize(request, new AbortController().signal)).resolves.toEqual(summary);
  expect(accounting.reserve).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'context_compression');
  expect(settled).toEqual([{id: 'api-compression', usage: {kind: 'api-tokens', inputTokens: 7, outputTokens: 3, cachedInputTokens: 0}}]);
});

it('settles API usage when summary coverage is invalid and does not dispatch pre-cancel', async () => {
  const accounting = {
    reserve: vi.fn(async () => ({id: 'api-invalid', profileId: 'profile', generation: 3})),
    markDispatch: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), cancelBeforeDispatch: vi.fn(async () => undefined),
  };
  const transport = vi.fn(async () => new Response(JSON.stringify({status: 'completed', output: [{type: 'message', role: 'assistant', content: [
    {type: 'output_text', text: JSON.stringify({...summary, lastOrdinal: 3})},
  ]}], usage: {input_tokens: 7, output_tokens: 3, input_tokens_details: {cached_tokens: 0}}}), {status: 200}));
  const adapter = createObserverApiCompressionAdapter({
    config: {profileId: 'profile', name: 'fixture', baseUrl: 'https://example.invalid', protocol: 'responses', model: 'model', keyRef: 'key', maxOutputTokens: 64, dailyCallLimit: 4},
    generation: 3, readKey: async () => 'fixture-key', transport, accounting,
    instructions: 'read-only summary instructions', schema: {type: 'object'}, conversationKey: 'conversation-a', turnGeneration: 7, authorize: () => true,
  });
  await expect(adapter.summarize(request, new AbortController().signal)).rejects.toThrow('COMPRESSION_PROVIDER_FAILED');
  expect(accounting.settle).toHaveBeenCalledWith('api-invalid', {kind: 'api-tokens', inputTokens: 7, outputTokens: 3, cachedInputTokens: 0});

  const cancelled = new AbortController(); cancelled.abort();
  await expect(adapter.summarize(request, cancelled.signal)).rejects.toThrow('COMPRESSION_ABORTED');
  expect(transport).toHaveBeenCalledTimes(1);
});

it('exposes exact ETA and compression transport serialization for capacity sizing', () => {
  const settings = {model: 'model', instructions: 'pinned instructions', schema: {type: 'object'}, maxOutputTokens: 64, reasoningEffort: 'medium' as const};
  const compressionBody = serializeCompressionTransport(request, settings);
  const etaBody = serializeObserverTransport({goalSummary: null, activeSeconds: 1, runtime: 'running', messages: [{kind: 'user', text: 'task', truncated: false}], truncated: false}, settings);
  expect(JSON.parse(compressionBody)).toMatchObject({model: 'model', instructions: 'pinned instructions', max_output_tokens: 64,
    text: {format: {name: 'context_summary', strict: true, schema: settings.schema}}});
  expect(JSON.parse(JSON.parse(compressionBody).input)).toEqual(request);
  expect(JSON.parse(etaBody).text.format.name).toBe('observer_response');
  expect(compressionBody.length).toBeGreaterThan(JSON.stringify(request).length);
  expect(etaBody).toContain('pinned instructions');
});

it('separates subscription stdin, pinned assets, and trusted command overhead', () => {
  const value = serializeSubscriptionTransport({goalSummary: null, activeSeconds: 1, runtime: 'running', messages: [{kind: 'user', text: 'task', truncated: false}], truncated: false}, {
    instructions: 'instructions', schema: {type: 'object'}, commandEnvelope: 'exec --json --output-schema pinned.schema -',
  });
  expect(value.stdin).toContain('task');
  expect(value.byteCounts.instructions).toBe(Buffer.byteLength('instructions'));
  expect(value.byteCounts.schema).toBe(Buffer.byteLength(JSON.stringify({type: 'object'})));
  expect(value.byteCounts.commandEnvelope).toBe(Buffer.byteLength('exec --json --output-schema pinned.schema -'));
  expect(value.byteCounts.total).toBe(value.byteCounts.stdin + value.byteCounts.instructions + value.byteCounts.schema + value.byteCounts.commandEnvelope);
});
