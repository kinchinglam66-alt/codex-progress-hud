import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { createObserverApiTransport } from '../../src/desktop/observer-api-transport.js';

const agents: MockAgent[] = [];
afterEach(async () => { for (const agent of agents.splice(0)) await agent.close(); });

it('uses an injected dispatcher, rejects redirects, and keeps the caller signal', async () => {
  const agent = new MockAgent(); agents.push(agent); agent.disableNetConnect();
  agent.get('https://api.example.test').intercept({path: '/v1/responses', method: 'POST'})
    .reply(200, {ok: true});
  const transport = createObserverApiTransport({dispatcher: agent});
  const controller = new AbortController();
  const response = await transport('https://api.example.test/v1/responses', {
    method: 'POST', redirect: 'error', signal: controller.signal,
  });
  expect(response.status).toBe(200);
  controller.abort();
  expect(controller.signal.aborted).toBe(true);
});

it('forwards through an explicit local proxy without changing ambient dispatcher state', async () => {
  let seenUrl = '';
  const proxy = createServer((request, response) => {
    seenUrl = request.url ?? '';
    response.writeHead(200, {'content-type': 'application/json'}); response.end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => {proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);});
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('proxy address unavailable');
  const transport = createObserverApiTransport({proxyUrl: `http://127.0.0.1:${address.port}`});
  try {
    const response = await transport('http://target.example.test/v1/responses', {method: 'POST', body: '{}'});
    expect(response.status).toBe(200);
    expect(seenUrl).toBe('http://target.example.test/v1/responses');
  } finally {
    await transport.close();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

it('rejects a redirect response even when the caller omits redirect policy', async () => {
  const agent = new MockAgent(); agents.push(agent); agent.disableNetConnect();
  agent.get('https://api.example.test').intercept({path: '/redirect', method: 'GET'})
    .reply(302, '', {headers: {location: 'https://other.example.test/final'}});
  const transport = createObserverApiTransport({dispatcher: agent});
  await expect(transport('https://api.example.test/redirect', {method: 'GET'})).rejects.toThrow();
});

it('shares one close promise and does not report drain before the dispatcher closes', async () => {
  const transport = createObserverApiTransport();
  const first = transport.close();
  expect(transport.close()).toBe(first);
  await first;
  await expect(transport('https://api.example.test/closed', {method: 'GET'})).rejects.toThrow('OBSERVER_API_TRANSPORT_CLOSED');
});
