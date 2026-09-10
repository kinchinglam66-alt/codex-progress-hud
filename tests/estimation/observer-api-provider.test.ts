import { expect, it, vi } from 'vitest';
import { createObserverApiProvider } from '../../src/estimation/observer-api-provider.js';
import type { ApiConfig } from '../../src/desktop/observer-provider-config.js';
import type { ObserverInput } from '../../src/estimation/observer-contract.js';

const config: ApiConfig = {
  profileId: 'api-profile', name: 'Fixture API', baseUrl: 'https://api.example.test/v1',
  protocol: 'responses', model: 'observer-model', reasoningEffort: 'medium', keyRef: 'key-ref',
  maxOutputTokens: 321, dailyCallLimit: 20,
};
const input: ObserverInput = {
  goalSummary: 'Finish the report', activeSeconds: 42, runtime: 'running', truncated: false,
  messages: [{kind: 'user', text: 'Please finish the report', truncated: false}],
};
const interpretation = {
  relation: 'continue', status: 'running', summary: 'Finish the report',
  estimate: {remainingSeconds: 600, errorPercent: 30},
};

function responseFixture(usage: unknown = {
  input_tokens: 12, output_tokens: 8,
  input_tokens_details: {cached_tokens: 2},
}) {
  return new Response(JSON.stringify({
    id: 'resp_fixture', status: 'completed', output: [{
      type: 'message', status: 'completed', role: 'assistant', content: [{
        type: 'output_text', text: JSON.stringify(interpretation), annotations: [],
      }],
    }], usage,
  }), {status: 200, headers: {'content-type': 'application/json'}});
}

it('packs the shared observer request and decodes a valid Responses interpretation', async () => {
  let sentUrl = '';
  let sentInit: RequestInit | undefined;
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    sentUrl = url; sentInit = init; return responseFixture();
  });
  const accounting = {
    reserve: vi.fn(async () => ({id: 'reservation-1', profileId: config.profileId, generation: 3})),
    markDispatch: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    cancelBeforeDispatch: vi.fn(async () => undefined),
  };
  const provider = createObserverApiProvider({
    config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'},
  });

  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  const sentBody = JSON.parse(String(sentInit?.body)) as Record<string, unknown>;

  expect(sentUrl).toBe('https://api.example.test/v1/responses');
  expect(sentBody.model).toBe(config.model);
  expect(sentBody.instructions).toBe('shared observer instructions');
  expect(sentBody.tools).toBeUndefined();
  expect(sentBody.store).toBe(false);
  expect(sentBody.max_output_tokens).toBe(config.maxOutputTokens);
  expect(sentBody.text).toEqual({format: {type: 'json_schema', name: 'observer_response', strict: true, schema: {type: 'object'}}});
  expect(JSON.parse(String(sentBody.input))).toEqual(input);
  expect(sentInit?.redirect).toBe('error');
  expect(new Headers(sentInit?.headers).get('authorization')).toBe('Bearer synthetic-secret');
  expect(result.status).toBe('interpreted');
  expect(result.interpretation).toEqual(interpretation);
  expect(result.usage).toEqual({kind: 'api-tokens', inputTokens: 12, outputTokens: 8, cachedInputTokens: 2});
  expect(accounting.markDispatch).toHaveBeenCalledWith('reservation-1');
  expect(accounting.settle).toHaveBeenCalledWith('reservation-1', {kind: 'api-tokens', inputTokens: 12, outputTokens: 8, cachedInputTokens: 2});
});

it('accepts one bounded reasoning item before the single assistant message', async () => {
  const transport = async () => new Response(JSON.stringify({status: 'completed', output: [
    {type: 'reasoning', id: 'reasoning-1', summary: []},
    {type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify(interpretation)}]},
  ], usage: {input_tokens: 10, output_tokens: 5, input_tokens_details: {cached_tokens: 1}}}), {status: 200});
  const accounting = {reserve: async () => ({id: 'reasoning', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: async () => undefined, cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  await expect(provider.observe(input, new AbortController().signal, 'conversation-key')).resolves.toMatchObject({
    status: 'interpreted', interpretation,
  });
});

it('rejects a valid-looking output message from a non-assistant role', async () => {
  const transport = async () => new Response(JSON.stringify({status: 'completed', output: [
    {type: 'message', role: 'user', content: [{type: 'output_text', text: JSON.stringify(interpretation)}]},
  ], usage: {input_tokens: 10, output_tokens: 5, input_tokens_details: {cached_tokens: 1}}}), {status: 200});
  const accounting = {reserve: async () => ({id: 'wrong-role', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.outcomes?.failureCode).toBe('invalid_output');
  expect(result.usage).toEqual({kind: 'api-tokens', inputTokens: 10, outputTokens: 5, cachedInputTokens: 1});
});

it('retains valid usage when the response is incomplete', async () => {
  const transport = async () => new Response(JSON.stringify({status: 'incomplete', output: [],
    usage: {input_tokens: 10, output_tokens: 5, input_tokens_details: {cached_tokens: 1}}}), {status: 200});
  const accounting = {reserve: async () => ({id: 'incomplete', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.status).toBe('process_error');
  expect(result.usage).toEqual({kind: 'api-tokens', inputTokens: 10, outputTokens: 5, cachedInputTokens: 1});
  expect(accounting.settle).toHaveBeenCalledWith('incomplete', {kind: 'api-tokens', inputTokens: 10, outputTokens: 5, cachedInputTokens: 1});
});

it('settles valid usage even when the Responses output is semantically invalid', async () => {
  const transport = async () => new Response(JSON.stringify({
    status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: '{"status":"bad"}'}]}],
    usage: {input_tokens: 3, output_tokens: 2, input_tokens_details: {cached_tokens: 0}},
  }), {status: 200});
  const accounting = {
    reserve: async () => ({id: 'reservation-invalid', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined),
    cancelBeforeDispatch: async () => undefined,
  };
  const provider = createObserverApiProvider({
    config, generation: 3, readKey: async () => 'synthetic-secret', transport, accounting,
    instructions: 'shared observer instructions', schema: {type: 'object'},
  });

  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');

  expect(result.status).toBe('process_error');
  expect(result.interpretation).toBeNull();
  expect(result.usage).toEqual({kind: 'api-tokens', inputTokens: 3, outputTokens: 2, cachedInputTokens: 0});
  expect(accounting.settle).toHaveBeenCalledWith('reservation-invalid', {kind: 'api-tokens', inputTokens: 3, outputTokens: 2, cachedInputTokens: 0});
});

it('returns a trusted durable-settlement disposition for an unknown network outcome', async () => {
  const transport = vi.fn(async () => { throw new Error('synthetic network failure'); });
  const accounting = {
    reserve: vi.fn(async () => ({id: 'reservation-network', profileId: config.profileId, generation: 3})),
    markDispatch: vi.fn(async () => undefined), settle: vi.fn(async () => undefined),
    cancelBeforeDispatch: vi.fn(async () => undefined),
  };
  const provider = createObserverApiProvider({
    config, generation: 3, readKey: async () => 'synthetic-secret', transport, accounting,
    instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false,
  });

  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');

  expect(result).toMatchObject({status: 'process_error', interpretation: null, usage: null,
    outcomes: {dispatch: 'unknown', framingValid: false, closureConfirmed: true, usage: 'unknown',
      accounting: 'durably_settled'}});
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});

it('uses one separately admitted retry with the identical packed request snapshot', async () => {
  const bodies: string[] = [];
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return bodies.length === 1 ? new Response('temporary', {status: 503}) : responseFixture();
  });
  let nextId = 0;
  const accounting = {
    reserve: vi.fn(async () => ({id: `retry-${++nextId}`, profileId: config.profileId, generation: 3})),
    markDispatch: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), cancelBeforeDispatch: vi.fn(async () => undefined),
  };
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, sleep: async () => undefined});
  await expect(provider.observe(input, new AbortController().signal, 'conversation-key')).resolves.toMatchObject({status: 'interpreted'});
  expect(transport).toHaveBeenCalledTimes(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(accounting.reserve).toHaveBeenCalledTimes(2);
  expect(accounting.settle).toHaveBeenCalledTimes(2);
});

it.each([
  [401, 'unauthorized', false], [403, 'forbidden', false], [429, 'rate_limited', true], [503, 'server_error', true],
] as const)('bounds HTTP failure %s and retry policy', async (status, failureCode, retryable) => {
  let calls = 0;
  const transport = vi.fn(async () => {
    calls += 1;
    return new Response('not-json', {status});
  });
  const accounting = {
    reserve: vi.fn(async ({generation}: {generation: number}) => ({id: `reservation-${generation}-${calls + 1}`, profileId: config.profileId, generation})),
    markDispatch: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), cancelBeforeDispatch: vi.fn(async () => undefined),
  };
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, sleep: async () => undefined});

  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');

  expect(result.outcomes?.failureCode).toBe(failureCode);
  expect(calls).toBe(retryable ? 2 : 1);
  expect(accounting.reserve).toHaveBeenCalledTimes(calls);
  expect(accounting.settle).toHaveBeenCalledTimes(calls);
});

it('honors a valid Retry-After delay using the injected clock and sleep', async () => {
  let calls = 0;
  const transport = vi.fn(async () => ++calls === 1
    ? new Response('busy', {status: 429, headers: {'retry-after': '2'}})
    : responseFixture());
  const sleep = vi.fn(async () => undefined);
  const accounting = {reserve: vi.fn(async () => ({id: `retry-after-${calls}`, profileId: config.profileId, generation: 3})),
    markDispatch: async () => undefined, settle: async () => undefined, cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, now: () => 50_000,
    sleep});
  await expect(provider.observe(input, new AbortController().signal, 'conversation-key')).resolves.toMatchObject({status: 'interpreted'});
  expect(sleep).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
});

it('skips retry when Retry-After exceeds the configured cap instead of shortening it', async () => {
  const transport = vi.fn(async () => new Response('busy', {status: 429, headers: {'retry-after': '10'}}));
  const sleep = vi.fn(async () => undefined);
  const accounting = {reserve: vi.fn(async () => ({id: 'retry-cap', profileId: config.profileId, generation: 3})),
    markDispatch: async () => undefined, settle: async () => undefined, cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, maxRetryDelayMs: 5_000, sleep});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.outcomes?.failureCode).toBe('rate_limited');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it('returns the first durably settled outcome when cancellation aborts the retry delay', async () => {
  let calls = 0;
  const transport = vi.fn(async () => {
    calls += 1;
    return new Response('busy', {status: 503});
  });
  let delayStarted!: () => void;
  const started = new Promise<void>(resolve => {delayStarted = resolve;});
  const sleep = vi.fn(async (_delayMs: number, signal: AbortSignal) => await new Promise<void>((_resolve, reject) => {
    delayStarted();
    signal.addEventListener('abort', () => reject(new Error('delay_aborted')), {once: true});
  }));
  const accounting = {reserve: vi.fn(async () => ({id: `delay-cancel-${calls}`, profileId: config.profileId, generation: 3})),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, sleep});
  const controller = new AbortController();
  const pending = provider.observe(input, controller.signal, 'conversation-key');
  await started;
  controller.abort();
  const result = await pending;
  expect(result.outcomes?.failureCode).toBe('server_error');
  expect(result.outcomes?.accounting).toBe('durably_settled');
  expect(calls).toBe(1);
  expect(accounting.settle).toHaveBeenCalledTimes(1);
});

it('blocks 401/403 providers until the host replaces or reconfigures them', async () => {
  let calls = 0;
  const transport = vi.fn(async () => {calls += 1; return new Response('', {status: 401});});
  const accounting = {reserve: vi.fn(async () => ({id: `auth-${calls}`, profileId: config.profileId, generation: 3})),
    markDispatch: async () => undefined, settle: async () => undefined, cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const first = await provider.observe(input, new AbortController().signal, 'conversation-key');
  const second = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(first.outcomes?.failureCode).toBe('unauthorized');
  expect(second).toMatchObject({status: 'disabled', outcomes: {failureCode: 'unauthorized', dispatch: 'not_started'}});
  expect(calls).toBe(1);
});

it('keeps valid usage when output JSON is invalid and rejects tools without echoing them', async () => {
  const transport = async () => new Response(JSON.stringify({status: 'completed', output: [{type: 'message', content: [
    {type: 'output_text', text: '{"status":"running"}'},
  ]}], usage: {input_tokens: 4, output_tokens: 1, input_tokens_details: {cached_tokens: 0}}}), {status: 200});
  const accounting = {reserve: async () => ({id: 'invalid-output', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.status).toBe('process_error');
  expect(result.outcomes?.failureCode).toBe('invalid_output');
  expect(result.usage).toEqual({kind: 'api-tokens', inputTokens: 4, outputTokens: 1, cachedInputTokens: 0});
});

it('retains unknown usage for malformed usage instead of inventing zero', async () => {
  const transport = async () => responseFixture({input_tokens: 4, output_tokens: 'unknown'});
  const accounting = {reserve: async () => ({id: 'malformed-usage', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.status).toBe('process_error');
  expect(result.usage).toBeNull();
  expect(accounting.settle).toHaveBeenCalledWith('malformed-usage', null);
});

it('treats absent cached-token detail as unknown usage for safe cost accounting', async () => {
  const transport = async () => new Response(JSON.stringify({status: 'completed', output: [{type: 'message', content: [
    {type: 'output_text', text: JSON.stringify(interpretation)},
  ]}], usage: {input_tokens: 4, output_tokens: 1}}), {status: 200});
  const accounting = {reserve: async () => ({id: 'missing-cache-detail', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.usage).toBeNull();
  expect(result.outcomes?.failureCode).toBe('missing_usage');
  expect(accounting.settle).toHaveBeenCalledWith('missing-cache-detail', null);
});

it('bounds oversized responses and settles the dispatched reservation as unknown', async () => {
  const transport = async () => new Response('x'.repeat(256 * 1024 + 1), {status: 200});
  const accounting = {reserve: async () => ({id: 'oversized', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: async () => undefined};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const result = await provider.observe(input, new AbortController().signal, 'conversation-key');
  expect(result.outcomes?.failureCode).toBe('response_too_large');
  expect(result.usage).toBeNull();
  expect(accounting.settle).toHaveBeenCalledWith('oversized', null);
});

it('settles cancellation after dispatch without misclassifying it as pre-dispatch', async () => {
  let markTransportStarted!: () => void;
  const transportStarted = new Promise<void>(resolve => {markTransportStarted = resolve;});
  const transport = async (_url: string, init: RequestInit) => await new Promise<Response>((_resolve, reject) => {
    markTransportStarted();
    init.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
  });
  const accounting = {reserve: async () => ({id: 'cancelled', profileId: config.profileId, generation: 3}),
    markDispatch: async () => undefined, settle: vi.fn(async () => undefined), cancelBeforeDispatch: vi.fn(async () => undefined)};
  const provider = createObserverApiProvider({config, generation: 3, readKey: async () => 'synthetic-secret', transport,
    accounting, instructions: 'shared observer instructions', schema: {type: 'object'}, retry: false});
  const controller = new AbortController();
  const pending = provider.observe(input, controller.signal, 'conversation-key');
  await transportStarted;
  controller.abort();
  const result = await pending;
  expect(result.status).toBe('aborted');
  expect(result.outcomes).toMatchObject({dispatch: 'unknown', framingValid: false, accounting: 'durably_settled'});
  expect(accounting.cancelBeforeDispatch).not.toHaveBeenCalled();
  expect(accounting.settle).toHaveBeenCalledWith('cancelled', null);
});
