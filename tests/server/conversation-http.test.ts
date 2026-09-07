import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgressServer } from '../../src/server/http-server.js';
import { CompanionHttpClient } from '../../src/mcp/report-client.js';
import { normalizeHookInput } from '../../src/hooks/adapter.js';
import type { HudSnapshot } from '../../src/server/task-store.js';
import { RELEASE_CAPABILITIES } from '../../src/generated/capabilities.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for(const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(),'hud-names-test-'));
  const tokenPath = join(dir,'auth.token');
  const readIds: string[] = [];
  const server = createProgressServer({port:0,tokenPath,readConversationName:async id => {
    readIds.push(id); return id === 'host-a' ? 'Chat A' : 'Chat B';
  }});
  cleanups.push(async () => {await server.close(); await rm(dir,{recursive:true,force:true});});
  await server.listen();
  const client = new CompanionHttpClient(server.address().url,tokenPath);
  const token = (await readFile(tokenPath,'utf8')).trim();
  async function hook(id: string, hostThreadId = id) {
    const envelope = normalizeHookInput('UserPromptSubmit',{session_id:id,turn_id:'turn'},Date.now(),token).envelope;
    await client.submitHook({...envelope,hostThreadId}, {revision:(await client.status() as HudSnapshot).revision});
    return envelope.taskHandle;
  }
  return {server,client,hook,readIds,tokenPath,token};
}

it('publishes names on desktop rows but isolates all rows to bound MCP handles', async () => {
  const {server,client,hook,tokenPath} = await setup();
  const a=await hook('host-a'), b=await hook('host-b');
  await vi.waitFor(async () => {
    const snapshot=await client.status() as HudSnapshot;
    expect(snapshot.rows?.map(row=>row.name.value)).toEqual(['Chat A','Chat B']);
  });
  await client.submit({taskId:a,title:'Invented control title',event:{type:'tracking_started'}});
  expect((await client.status() as HudSnapshot).rows?.[0]?.name.value).toBe('Chat A');
  const scoped=new CompanionHttpClient(server.address().url,tokenPath);
  scoped.setLeaseOwnerNonce('synthetic-owner');
  const lease=await scoped.acquireLease('synthetic-owner');
  scoped.setLease(lease);
  await scoped.bindLease(a,lease);
  const snapshot=await scoped.status() as HudSnapshot;
  expect(snapshot.rows?.map(row=>row.task.id)).toEqual([a]);
  expect(JSON.stringify(snapshot)).not.toContain('Chat B');
  expect(JSON.stringify(snapshot)).not.toContain(b);
  expect(JSON.stringify(snapshot)).not.toContain('host-a');
  expect(snapshot.hooks).toBeUndefined();
});

it('refuses the aggregate event stream to MCP clients', async () => {
  const {server,token}=await setup();
  const response=await fetch(server.address().url+'/api/events',{
    headers:{authorization:'Bearer '+token,'x-codex-progress-hud-client':'mcp'},
    signal:AbortSignal.timeout(2000)
  });
  await response.body?.cancel();
  expect(response.status).toBe(403);
});

it('isolates MCP revisions and selection while preserving own-scope stale-write guards', async () => {
  const {server, client, hook, tokenPath} = await setup();
  const a = await hook('host-a');
  await vi.waitFor(async () => expect((await client.status() as HudSnapshot).rows?.[0]?.name.value).toBe('Chat A'));
  const scoped = new CompanionHttpClient(server.address().url, tokenPath);
  scoped.setLeaseOwnerNonce('revision-owner');
  const lease = await scoped.acquireLease('revision-owner'); scoped.setLease(lease);
  await scoped.bindLease(a, lease);
  const before = await scoped.status() as HudSnapshot;
  const b = await hook('host-b');
  for (let i = 0; i < 3; i++) {
    await client.submit({taskId: b, event: {type: i % 2 === 0 ? 'tracking_paused' : 'tracking_resumed'}});
  }
  const unchanged = await scoped.status() as HudSnapshot;
  expect(unchanged.revision).toBe(before.revision);
  expect(unchanged.selectedTaskId).toBe(a);
  expect(unchanged.turnTracking).toBeUndefined();
  expect(await scoped.status({afterRevision: before.revision})).toBeNull();
  await scoped.selectTask(a, 'pinned', {revision: before.revision});
  expect((await scoped.status() as HudSnapshot).selectionMode).toBe('pinned');
  await scoped.submit({taskId: a, event: {type: 'tracking_paused'}});
  await expect(scoped.selectTask(a, 'pinned', {revision: before.revision})).rejects.toMatchObject({code: 'STALE_REVISION'});
  const current = await scoped.status() as HudSnapshot;
  expect(current.revision).toBeGreaterThan(before.revision);
  expect(current.selected?.task.status).toBe('paused');
  expect(current.hooks).toBeUndefined();
});

it.each(['select', 'hook'] as const)('keeps missing-revision errors lease-local for %s writes', async (action) => {
  const {server, client, hook, tokenPath, token} = await setup();
  const a = await hook('host-a');
  await vi.waitFor(async () => expect((await client.status() as HudSnapshot).rows?.[0]?.name.value).toBe('Chat A'));
  const scoped = new CompanionHttpClient(server.address().url, tokenPath);
  scoped.setLeaseOwnerNonce('error-owner');
  const lease = await scoped.acquireLease('error-owner'); scoped.setLease(lease);
  await scoped.bindLease(a, lease);
  const before = await scoped.status() as HudSnapshot;
  await hook('host-b');
  const envelope = normalizeHookInput('UserPromptSubmit', {session_id: 'host-a', turn_id: 'next'}, Date.now(), token).envelope;
  const response = await fetch(server.address().url + (action === 'select'
    ? `/api/tasks/${encodeURIComponent(a)}/select` : '/api/hooks/events'), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json',
      'x-codex-progress-hud-client': 'mcp',
      'x-codex-progress-hud-protocol': String(RELEASE_CAPABILITIES.protocol.current),
      'x-codex-progress-hud-lease': lease.id, 'x-codex-progress-hud-owner': lease.ownerNonce
    },
    body: JSON.stringify(action === 'select' ? {mode: 'pinned'} : envelope),
    signal: AbortSignal.timeout(2000)
  });
  expect(response.status).toBe(428);
  expect(await response.json()).toMatchObject({code: 'REVISION_REQUIRED', revision: before.revision});
  expect(await scoped.status({afterRevision: before.revision})).toBeNull();
});

it.each([undefined, RELEASE_CAPABILITIES.protocol.minimumClient - 1, RELEASE_CAPABILITIES.protocol.maximumClient + 1])(
  'rejects incompatible MCP snapshot protocol %s before returning data or unchanged status', async (protocol) => {
    const {server, hook, tokenPath, token} = await setup();
    const a = await hook('host-a');
    const scoped = new CompanionHttpClient(server.address().url, tokenPath);
    scoped.setLeaseOwnerNonce('protocol-owner');
    const lease = await scoped.acquireLease('protocol-owner'); scoped.setLease(lease);
    await scoped.bindLease(a, lease);
    const before = await scoped.status() as HudSnapshot;
    for (const query of ['', `?afterRevision=${before.revision}`]) {
      const response = await fetch(server.address().url + '/api/snapshot' + query, {
        headers: {
          authorization: 'Bearer ' + token,
          'x-codex-progress-hud-client': 'mcp',
          'x-codex-progress-hud-lease': lease.id, 'x-codex-progress-hud-owner': lease.ownerNonce,
          ...(protocol === undefined ? {} : {'x-codex-progress-hud-protocol': String(protocol)})
        }, signal: AbortSignal.timeout(2000)
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({code: 'VERSION_MISMATCH'});
    }
  }
);

it('rejects an identity/name lookup mismatch without invoking the provider or starting a task', async () => {
  const {client,hook,readIds}=await setup();
  await expect(hook('host-a','host-b')).rejects.toBeDefined();
  expect(readIds).toEqual([]);
  expect((await client.status() as HudSnapshot).tasks).toEqual([]);
});

it.each([
  {type: 'model_progress', phase: 'work', remainingSeconds: 60},
  {type: 'model_outcome', outcome: 'completed', verified: true},
  {type: 'validation_observed', result: 'passed'},
  {type: 'plan_updated', steps: []},
  {type: 'runtime_failed', message: 'injected failure'},
  {type: 'waiting', reason: 'user'},
  {type: 'activity_seen', category: 'tool'},
  {type: 'tracking_paused', remainingSeconds: 60}
])('refuses non-control or extended HTTP event $type without changing state', async event => {
  const {server, token, client} = await setup();
  await client.submit({taskId: 'hud_external_write_abcdefghijklmnop', event: {type: 'tracking_started'}});
  const before = server.store.snapshot();
  const response = await fetch(server.address().url + '/api/events', {
    method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json',
      'x-codex-progress-hud-protocol': String(RELEASE_CAPABILITIES.protocol.current)},
    body: JSON.stringify({taskId: 'hud_external_write_abcdefghijklmnop', event}),
    signal: AbortSignal.timeout(2000)
  });
  expect(response.status).toBe(400);
  await response.body?.cancel();
  expect(server.store.snapshot()).toEqual(before);
});

it('rejects an obsolete event protocol before interpreting its removed report payload', async () => {
  const {server, token} = await setup();
  const response = await fetch(server.address().url + '/api/events', {
    method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json',
      'x-codex-progress-hud-protocol': String(RELEASE_CAPABILITIES.protocol.minimumClient - 1)},
    body: JSON.stringify({taskId: 'legacy', event: {type: 'model_progress', phase: 'old'}}),
    signal: AbortSignal.timeout(2000)
  });
  expect(response.status).toBe(426);
  expect(await response.json()).toMatchObject({code: 'VERSION_MISMATCH'});
  expect(server.store.snapshot().tasks).toEqual([]);
});

it.each(['/api/snapshot', '/api/leases/acquire', '/api/events'])(
  'rejects shipped protocol 2 at %s without admitting work or a lease', async path => {
    const {server, token} = await setup();
    const response = await fetch(server.address().url + path, {
      method: path === '/api/snapshot' ? 'GET' : 'POST',
      headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'x-codex-progress-hud-client': 'mcp', 'x-codex-progress-hud-protocol': '2'},
      ...(path === '/api/snapshot' ? {} : {body: JSON.stringify(path === '/api/leases/acquire'
        ? {ownerNonce: 'old-owner'} : {taskId: 'old-task', event: {type: 'tracking_started'}})}),
      signal: AbortSignal.timeout(2000)
    });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({code: 'VERSION_MISMATCH'});
    expect(server.store.snapshot().tasks).toEqual([]);
    expect(server.leaseStore.active()).toEqual([]);
  }
);
