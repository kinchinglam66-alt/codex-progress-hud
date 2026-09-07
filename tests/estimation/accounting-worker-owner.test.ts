import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, expect, it} from 'vitest';
import type {ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';

const paths: string[] = [];
const owners: ReleaseAccountingOwner[] = [];
const usage = {inputTokens: 10, outputTokens: 2, cachedInputTokens: 5};

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-accounting-worker-'));
  paths.push(path);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await access(path); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw new Error(`TEST_FILE_NOT_READY:${path}`);
}

type FixtureMode = 'none' | 'suppress' | 'exit' | 'shutdown-error' | 'malformed-response' | 'duplicate-ready' | 'regressing-snapshot' | 'busy-storage';

async function compileFixture(mode: FixtureMode = 'none'): Promise<string> {
  const output = await mkdtemp(join(process.cwd(), '.accounting-worker-child-'));
  paths.push(output);
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  const sources = [
    'accounting-worker-owner.ts',
    'accounting-worker-protocol.ts',
    'accounting-worker-entry.ts',
    'release-accounting.ts',
    'subscription-accounting.ts',
  ].map(file => join(process.cwd(), 'src', 'estimation', file));
  await new Promise<void>((resolve, reject) => {
    const compiler = spawn(process.execPath, [tsc, '--ignoreConfig', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--rootDir', join(process.cwd(), 'src'), '--outDir', output, ...sources], {cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    let stderr = '';
    compiler.stderr.on('data', chunk => { stderr += chunk.toString(); });
    compiler.once('error', reject);
    compiler.once('close', code => code === 0 ? resolve() : reject(new Error(`tsc:${code}:${stderr}`)));
  });
  if (mode !== 'none') {
    const entry = join(output, 'estimation', 'accounting-worker-entry.js');
    if (mode === 'exit') await writeFile(entry, 'process.exit(73);');
    else {
      const real = join(output, 'estimation', 'accounting-worker-entry-real.js');
      await writeFile(real, await readFile(entry));
      await writeFile(entry, mode === 'shutdown-error' ? `
        import {parentPort, workerData} from 'node:worker_threads';
        import {writeFileSync} from 'node:fs';
        const port = parentPort;
        if (!port) process.exit(71);
        const post = port.postMessage.bind(port);
        port.postMessage = (message, ...args) => {
          if (message?.kind === 'ready') post(message, ...args);
          else if (message?.kind === 'response') post({...message, ok: false, error: 'RELEASE_CLOSE_FAILED', result: null}, ...args);
        };
        const heartbeatPath = String(workerData.directory) + '/worker-heartbeat';
        let heartbeat = 0;
        setInterval(() => writeFileSync(heartbeatPath, String(++heartbeat)), 20);
        await import('./accounting-worker-entry-real.js');
        setTimeout(() => process.exit(74), 2_000);
      ` : mode === 'malformed-response' ? `
        import {parentPort, workerData} from 'node:worker_threads';
        import {writeFileSync} from 'node:fs';
        const port = parentPort;
        if (!port) process.exit(71);
        const post = port.postMessage.bind(port);
        port.postMessage = (message, ...args) => {
          if (message?.kind === 'ready') post(message, ...args);
          else if (message?.kind === 'response') {
            post({}, ...args);
            writeFileSync(String(workerData.directory) + '/fault-sent', 'malformed-response');
          }
        };
        await import('./accounting-worker-entry-real.js');
      ` : mode === 'duplicate-ready' ? `
        import {parentPort, workerData} from 'node:worker_threads';
        import {writeFileSync} from 'node:fs';
        const port = parentPort;
        if (!port) process.exit(71);
        const post = port.postMessage.bind(port);
        port.postMessage = (message, ...args) => {
          if (message?.kind === 'ready') {
            post(message, ...args);
            setImmediate(() => {
              post(message, ...args);
              writeFileSync(String(workerData.directory) + '/fault-sent', 'duplicate-ready');
            });
          } else post(message, ...args);
        };
        await import('./accounting-worker-entry-real.js');
      ` : mode === 'regressing-snapshot' ? `
        import {parentPort, workerData} from 'node:worker_threads';
        import {writeFileSync} from 'node:fs';
        const port = parentPort;
        if (!port) process.exit(71);
        const post = port.postMessage.bind(port);
        let responses = 0;
        port.postMessage = (message, ...args) => {
          if (message?.kind !== 'response' || responses++ === 0) post(message, ...args);
          else {
            post({...message, snapshot: {...message.snapshot, starts: Math.max(0, message.snapshot.starts - 1)}}, ...args);
            writeFileSync(String(workerData.directory) + '/fault-sent', 'regressing-snapshot');
          }
        };
        await import('./accounting-worker-entry-real.js');
      ` : mode === 'busy-storage' ? `
        import {parentPort, workerData} from 'node:worker_threads';
        import {existsSync, writeFileSync} from 'node:fs';
        import {DatabaseSync} from 'node:sqlite';
        const port = parentPort;
        if (!port) process.exit(71);
        const startPath = String(workerData.directory) + '/busy-started';
        const releasePath = String(workerData.directory) + '/busy-release';
        const donePath = String(workerData.directory) + '/busy-finished';
        let armed = false;
        let blocked = false;
        const originalPrepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function(...args) {
          if (armed && !blocked) {
            blocked = true;
            writeFileSync(startPath, 'busy');
            const waiter = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 10);
            writeFileSync(donePath, 'finished');
          }
          return originalPrepare.apply(this, args);
        };
        const post = port.postMessage.bind(port);
        port.postMessage = (message, ...args) => {
          if (message?.kind === 'ready') armed = true;
          post(message, ...args);
        };
        await import('./accounting-worker-entry-real.js');
      ` : `
        import {parentPort} from 'node:worker_threads';
        const port = parentPort;
        if (!port) process.exit(71);
        const post = port.postMessage.bind(port);
        port.postMessage = (message, ...args) => {
          if (message?.kind === 'ready') post(message, ...args);
        };
        await import('./accounting-worker-entry-real.js');
        setTimeout(() => process.exit(72), 250);
      `);
    }
  }
  return pathToFileURL(join(output, 'estimation', 'accounting-worker-owner.js')).href;
}

async function openCompiled(directoryPath: string, now: () => number, mode: FixtureMode = 'none'): Promise<ReleaseAccountingOwner> {
  const moduleUrl = await compileFixture(mode);
  const module = await import(moduleUrl) as typeof import('../../src/estimation/accounting-worker-owner.js');
  const owner = await module.openThreadedReleaseAccounting(directoryPath, now);
  owners.push(owner);
  return owner;
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

it('initializes an absent first-use accounting directory before opening SQLite', async () => {
  const path = join(await directory(), 'observer-accounting');
  const owner = await openCompiled(path, () => 0);
  const view = owner.forConversation('first-use');
  const id = await view.reserve();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await view.settle(id!, usage);
  expect(owner.snapshot()).toMatchObject({starts: 1, knownTokens: 12, unknown: 0});
  await expect(access(join(path, 'release-observer-accounting.sqlite'))).resolves.toBeUndefined();
});
it('uses the real worker protocol for not-dispatched cancellation without usage or refunds',async()=>{
  const path=await directory(),owner=await openCompiled(path,()=>0),view=owner.forConversation('one');
  const id=(await view.reserve())!;
  await expect(owner.forConversation('two').cancelBeforeDispatch(id)).rejects.toThrow('RELEASE_INVALID_SETTLEMENT');
  await view.cancelBeforeDispatch(id);
  expect(owner.snapshot()).toMatchObject({starts:1,activeStarts:1,inFlight:0,unknown:0,knownTokens:0});
  await owner.close();
  const restored=await openCompiled(path,()=>0);
  expect(restored.snapshot()).toMatchObject({starts:1,inFlight:0,unknown:0,knownTokens:0});
});

it('uses a real worker and SQLite for competing conversations and confirmed snapshots', async () => {
  let now = 0;
  const owner = await openCompiled(await directory(), () => now);
  const first = owner.forConversation('conversation-a');
  const second = owner.forConversation('conversation-b');
  const third = owner.forConversation('conversation-c');

  const [firstId, secondId, denied] = await Promise.all([first.reserve(), second.reserve(), third.reserve()]);
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  expect(secondId).toMatch(/^[0-9a-f-]{36}$/);
  expect(denied).toBeNull();
  await expect(first.reserve()).resolves.toBeNull();
  await first.settle(firstId!, usage);
  await second.settle(secondId!, usage);
  expect(owner.snapshot()).toEqual({starts: 2, activeStarts: 2, inFlight: 0, unresolved: 0, knownTokens: 24, unknown: 0, poisoned: false});

  now = 3_600_000;
  expect(await third.reserve()).toMatch(/^[0-9a-f-]{36}$/);
});

it('keeps unknown state blocking, drains view close, and allows reopen settlement', async () => {
  let now = 0;
  const path = await directory();
  const owner = await openCompiled(path, () => now);
  const unknown = owner.forConversation('unknown');
  const pending = owner.forConversation('pending');
  const unknownId = await unknown.reserve();
  const pendingId = await pending.reserve();
  await unknown.settle(unknownId!, null);
  await pending.close();
  await owner.close();
  owners.pop();

  const reopened = await openCompiled(path, () => now);
  expect(await reopened.forConversation('later').reserve()).toBeNull();
  await reopened.forConversation('pending').settle(pendingId!, usage);
  expect(reopened.snapshot()).toMatchObject({starts: 2, knownTokens: 12, unknown: 1, unresolved: 0});
  expect(await reopened.forConversation('later').reserve()).toBeNull();
});

it('drains queued admitted work before owner close and rejects malformed usage without file damage', async () => {
  let now = 0;
  const path = await directory();
  const owner = await openCompiled(path, () => now);
  const view = owner.forConversation('queued');
  const first = view.reserve();
  const second = view.reserve();
  const closing = owner.close();
  const firstId = await first;
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(second).resolves.toBeNull();
  await closing;
  owners.pop();

  const reopened = await openCompiled(path, () => now);
  const reopenedView = reopened.forConversation('queued');
  expect(await reopenedView.reserve()).toBeNull();
  await expect(reopenedView.settle(firstId!, {inputTokens: 11, outputTokens: 2, cachedInputTokens: 99})).rejects.toThrow('RELEASE_USAGE_INVALID');
  await reopenedView.settle(firstId!, usage);
  const id = await reopenedView.reserve();
  await expect(reopenedView.settle(id!, {inputTokens: 11, outputTokens: 2, cachedInputTokens: 99})).rejects.toThrow('RELEASE_USAGE_INVALID');
  expect(reopened.snapshot()).toMatchObject({starts: 2, knownTokens: 12, unresolved: 1, poisoned: false});
  await reopenedView.settle(id!, usage);
});

it('rejects an invalid parent clock without changing SQLite and clones usage before dispatch', async () => {
  let now = 0;
  const owner = await openCompiled(await directory(), () => now);
  const view = owner.forConversation('clocked');
  const id = await view.reserve();
  now = Number.NaN;
  await expect(view.settle(id!, usage)).rejects.toThrow('RELEASE_INVALID_CLOCK');
  expect(owner.snapshot()).toMatchObject({starts: 1, knownTokens: 0, unresolved: 1, poisoned: false});

  now = 1;
  const copiedUsage = {...usage};
  const settlement = view.settle(id!, copiedUsage);
  copiedUsage.inputTokens = 999;
  await settlement;
  expect(owner.snapshot()).toMatchObject({starts: 1, knownTokens: 12, unresolved: 0, poisoned: false});
});

it('memoizes a view close promise while admitted work is still draining', async () => {
  const owner = await openCompiled(await directory(), () => 0, 'suppress');
  const view = owner.forConversation('draining-view');
  const request = view.reserve();
  const firstClose = view.close();
  const secondClose = view.close();
  expect(secondClose).toBe(firstClose);
  await expect(request).rejects.toThrow();
  await firstClose;
});

it('terminates the owned worker when shutdown returns a sanitized error', async () => {
  const path = await directory();
  const owner = await openCompiled(path, () => 0, 'shutdown-error');
  await waitForFile(join(path, 'worker-heartbeat'));
  const started = Date.now();
  await expect(owner.close()).rejects.toThrow('RELEASE_CLOSE_FAILED');
  const heartbeatAtClose = await readFile(join(path, 'worker-heartbeat'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await readFile(join(path, 'worker-heartbeat'), 'utf8')).toBe(heartbeatAtClose);
  expect(Date.now() - started).toBeLessThan(1_500);
});

it('fails immediately and closed on startup storage failure and startup worker exit', async () => {
  const failedPath = await directory();
  await writeFile(join(failedPath, 'release-observer-accounting.jsonl'), 'legacy');
  const started = Date.now();
  await expect(openCompiled(failedPath, () => 0)).rejects.toThrow('RELEASE_LEGACY_STATE');
  expect(Date.now() - started).toBeLessThan(5_000);

  const exitedPath = await directory();
  const exitStarted = Date.now();
  await expect(openCompiled(exitedPath, () => 0, 'exit')).rejects.toThrow('RELEASE_WORKER_EXITED');
  expect(Date.now() - exitStarted).toBeLessThan(5_000);
});

it('fails closed on an unexpected actual worker exit and bounds pending submissions', async () => {
  const owner = await openCompiled(await directory(), () => 0, 'suppress');
  const view = owner.forConversation('bounded');
  const pending = Array.from({length: 129}, () => view.reserve());
  await expect(pending[128]).rejects.toThrow('RELEASE_PENDING_LIMIT');
  await expect(Promise.allSettled(pending.slice(0, 128))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({status: 'rejected'})]));
  expect(owner.snapshot().poisoned).toBe(true);
});

it('fails the second real worker owner closed while preserving the first SQLite owner', async () => {
  const path = await directory();
  const first = await openCompiled(path, () => 0);
  await expect(openCompiled(path, () => 0)).rejects.toThrow('RELEASE_DATABASE_UNAVAILABLE');
  const view = first.forConversation('owner-one');
  const id = await view.reserve();
  await view.settle(id!, usage);
  expect(first.snapshot()).toMatchObject({starts: 1, knownTokens: 12, unresolved: 0, poisoned: false});
});

it('keeps the parent event loop responsive while the real worker is synchronously busy at SQLite storage', async () => {
  const path = await directory();
  const owner = await openCompiled(path, () => 0, 'busy-storage');
  const request = owner.forConversation('busy').reserve();
  await waitForFile(join(path, 'busy-started'));
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
    void writeFile(join(path, 'busy-release'), 'release');
  }, 0);
  await request;
  await waitForFile(join(path, 'busy-finished'));
  expect(timerRan).toBe(true);
});

it.each([
  ['malformed-response', 'RELEASE_PROTOCOL_INVALID'],
  ['duplicate-ready', 'RELEASE_PROTOCOL_INVALID'],
] as const)('fails closed on a %s from the real worker fixture', async (mode, expected) => {
  const path = await directory();
  const owner = await openCompiled(path, () => 0, mode);
  const view = owner.forConversation('fault');
  const pending = view.reserve();
  await waitForFile(join(path, 'fault-sent'));
  await expect(pending).rejects.toThrow(expected);
  expect(owner.snapshot().poisoned).toBe(true);
});

it('fails closed when a real worker returns a regressing confirmed snapshot', async () => {
  const path = await directory();
  const owner = await openCompiled(path, () => 0, 'regressing-snapshot');
  const view = owner.forConversation('regressing');
  const id = await view.reserve();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const settlement = view.settle(id!, usage);
  await waitForFile(join(path, 'fault-sent'));
  await expect(settlement).rejects.toThrow('RELEASE_PROTOCOL_INVALID');
  expect(owner.snapshot().poisoned).toBe(true);
});
