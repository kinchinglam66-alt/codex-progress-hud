import {access, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';
import {createOwnedProcessRunner} from '../../src/estimation/owned-process.js';
import {createObserverSubscriptionSession} from '../../src/estimation/subscription-session.js';

const observerInput = {
  goalSummary: null,
  activeSeconds: 20,
  runtime: 'running',
  messages: [{kind: 'user', text: 'Build a report password=private', truncated: false}],
  truncated: false,
};
const interpretation = {
  relation: 'replace',
  status: 'running',
  summary: 'Build a report',
  estimate: {remainingSeconds: 7200, errorPercent: 40},
};
const knownStream = (includeUsage = true) => [
  {type: 'turn.started'},
  {type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: JSON.stringify(interpretation)}},
  {type: 'turn.completed', ...(includeUsage ? {usage: {input_tokens: 20, output_tokens: 3, cached_input_tokens: 5}} : {})},
].map(event => JSON.stringify(event)).join('\n') + '\n';

interface Gate {ready: string; release: string; launched: string}
interface SessionHandle {session: ReturnType<typeof createObserverSubscriptionSession>; runner: ReturnType<typeof createOwnedProcessRunner>}

const paths: string[] = [];
const closers: Array<() => Promise<void>> = [];

async function makeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-release-session-'));
  paths.push(path);
  return path;
}

function gateScript(gate: Gate, output: string): string {
  return [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(gate.launched)}, 'launched');`,
    `fs.writeFileSync(${JSON.stringify(gate.ready)}, 'ready');`,
    "process.stdin.resume();process.stdin.on('data',()=>{});",
    `process.stdin.on('end',()=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate.release)})){clearInterval(timer);process.stdout.write(${JSON.stringify(output)});}},5);});`,
  ].join('');
}

function newGate(path: string, name: string): Gate {
  return {ready: join(path, `${name}.ready`), release: join(path, `${name}.release`), launched: join(path, `${name}.launched`)};
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    try { await access(path); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw new Error(`TEST_CHILD_NOT_READY:${path}`);
}

async function release(gate: Gate): Promise<void> {
  await writeFile(gate.release, 'release');
}

async function openOwner(path: string): Promise<ReleaseAccountingOwner> {
  const owner = await openReleaseAccounting(path, () => 0);
  closers.push(() => owner.close());
  return owner;
}

function makeSession(owner: ReleaseAccountingOwner, path: string, key: string, gates: Gate[], output = knownStream(), runnerOptions = {timeoutMs: 5_000, cleanupMs: 1_000}, authorize = () => true,
  scriptFor: (gate: Gate, output: string) => string = gateScript): SessionHandle {
  const view = owner.forConversation(key);
  const runner = createOwnedProcessRunner(runnerOptions);
  const session = createObserverSubscriptionSession({
    ledger: view,
    runner,
    authorize,
    prepare: input => {
      const gate = gates.shift();
      if (!gate) throw new Error('TEST_GATE_EXHAUSTED');
      return {executable: process.execPath, cwd: path, args: ['-e', scriptFor(gate, output)], env: process.env, input: JSON.stringify(input)};
    },
  });
  closers.push(() => session.close());
  return {session, runner};
}

function framedUnknownScript(gate: Gate, output: string, mode: 'nonzero' | 'hold'): string {
  return [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(gate.ready)}, 'ready');`,
    `process.stdout.write(${JSON.stringify(output)});`,
    mode === 'nonzero' ? 'process.exit(7);' : "process.stdin.resume();process.stdin.on('data',()=>{});setInterval(()=>{},1000);",
  ].join('');
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

it('shares two durable worker slots, denies a third until capacity frees, and keeps the other view usable after one session closes', async () => {
  const path = await makeDirectory();
  const owner = await openOwner(path);
  const aGate = newGate(path, 'a-1');
  const bGate1 = newGate(path, 'b-1');
  const bGate2 = newGate(path, 'b-2');
  const cDeniedGate = newGate(path, 'c-denied');
  const cGate = newGate(path, 'c-1');
  const a = makeSession(owner, path, 'conversation-a', [aGate]);
  const b = makeSession(owner, path, 'conversation-b', [bGate1, bGate2]);
  const c = makeSession(owner, path, 'conversation-c', [cDeniedGate, cGate]);

  const aPending = a.session.observe(observerInput, new AbortController().signal);
  const bPending = b.session.observe(observerInput, new AbortController().signal);
  await Promise.all([waitForFile(aGate.ready), waitForFile(bGate1.ready)]);
  await expect(c.session.observe(observerInput, new AbortController().signal)).resolves.toMatchObject({status: 'admission_denied', usage: null});
  await expect(access(cDeniedGate.launched)).rejects.toThrow();

  await release(aGate);
  await expect(aPending).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});
  const cPending = c.session.observe(observerInput, new AbortController().signal);
  await waitForFile(cGate.ready);
  await release(cGate);
  await expect(cPending).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});
  await release(bGate1);
  await expect(bPending).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});

  await a.session.close();
  const bSecond = b.session.observe(observerInput, new AbortController().signal);
  await waitForFile(bGate2.ready);
  await release(bGate2);
  await expect(bSecond).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 4, knownTokens: 92, unresolved: 0, unknown: 0}));
});

it('poisons on a commit failure before admission and never launches the child', async () => {
  const path = await makeDirectory();
  const owner = await openOwner(path);
  const gate = newGate(path, 'commit-failed');
  const session = makeSession(owner, path, 'conversation-commit-failed', [gate]);
  const {DatabaseSync} = await import('node:sqlite');
  const prototype = DatabaseSync.prototype as unknown as {exec: (sql: string) => void};
  const originalExec = prototype.exec;
  let failCommit = true;
  prototype.exec = function(this: typeof prototype, sql: string): void {
    if (failCommit && sql.trim().toUpperCase() === 'COMMIT') {
      failCommit = false;
      throw new Error('TEST_COMMIT_FAILURE');
    }
    originalExec.call(this, sql);
  };
  try {
    await expect(session.session.observe(observerInput, new AbortController().signal)).resolves.toMatchObject({status: 'accounting_error', usage: null});
    await expect(access(gate.launched)).rejects.toThrow();
    expect(owner.snapshot().poisoned).toBe(true);
  } finally {
    prototype.exec = originalExec;
  }
  expect(owner.snapshot()).toMatchObject({starts: 0, knownTokens: 0, unresolved: 0, poisoned: true});
  await expect(owner.forConversation('queued-after-failure').reserve()).rejects.toThrow('RELEASE_DATABASE_UNAVAILABLE');
  const laterGate = newGate(path, 'after-commit-failed');
  const later = makeSession(owner, path, 'different-conversation', [laterGate]);
  await expect(later.session.observe(observerInput, new AbortController().signal)).resolves.toMatchObject({status: 'accounting_error', usage: null});
  await expect(access(laterGate.launched)).rejects.toThrow();
  expect(owner.snapshot()).toMatchObject({starts: 0, knownTokens: 0, unresolved: 0, poisoned: true});
});

it('settles known usage from the surviving session while an unknown exit permits bounded later admission', async () => {
  const path = await makeDirectory();
  const owner = await openOwner(path);
  const unknownGate = newGate(path, 'unknown-1');
  const knownGate = newGate(path, 'known-1');
  const unknown = makeSession(owner, path, 'conversation-unknown', [unknownGate], knownStream(false));
  const known = makeSession(owner, path, 'conversation-known', [knownGate]);
  const unknownPending = unknown.session.observe(observerInput, new AbortController().signal);
  const knownPending = known.session.observe(observerInput, new AbortController().signal);
  await Promise.all([waitForFile(unknownGate.ready), waitForFile(knownGate.ready)]);

  await release(unknownGate);
  await expect(unknownPending).resolves.toMatchObject({status: 'interpreted', usage: null,
    outcomes:{prediction:'numeric',call:'success',usage:'unknown',framingValid:true,closureConfirmed:true}});
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 2, unresolved: 1, unknown: 1}));
  await release(knownGate);
  await expect(knownPending).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});

  const laterGate = newGate(path, 'later-warning');
  const later = makeSession(owner, path, 'conversation-later', [laterGate]);
  const laterPending = later.session.observe(observerInput, new AbortController().signal);
  await waitForFile(laterGate.ready);
  await release(laterGate);
  await expect(laterPending).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 3, knownTokens: 46, unresolved: 0, unknown: 1}));
});

it('closing a running session cancels only its child and durably blocks after unsafe settlement', async () => {
  const path = await makeDirectory();
  const owner = await openOwner(path);
  const closingGate = newGate(path, 'closing-1');
  const survivorGate = newGate(path, 'survivor-1');
  const laterBlockedGate = newGate(path, 'survivor-later-blocked');
  const closing = makeSession(owner, path, 'conversation-closing', [closingGate]);
  const survivor = makeSession(owner, path, 'conversation-survivor', [survivorGate, laterBlockedGate]);
  const closingPending = closing.session.observe(observerInput, new AbortController().signal);
  const survivorPending = survivor.session.observe(observerInput, new AbortController().signal);
  await Promise.all([waitForFile(closingGate.ready), waitForFile(survivorGate.ready)]);

  const closePromise = closing.session.close();
  await expect(closingPending).resolves.toMatchObject({status: 'disabled', usage: null});
  await closePromise;
  expect(survivor.runner.status().active).toBe(true);
  await release(survivorGate);
  await expect(survivorPending).resolves.toMatchObject({status: 'interpreted', usage: {inputTokens: 20, outputTokens: 3}});
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 2, knownTokens: 23, unresolved: 0, unknown: 1}));
  const laterPending = survivor.session.observe(observerInput, new AbortController().signal);
  await expect(laterPending).resolves.toMatchObject({status: 'admission_denied', usage: null});
  await expect(access(laterBlockedGate.launched)).rejects.toThrow();
  expect(owner.recoveryStatus?.()).toMatchObject({state: 'blocked', recoveryAllowed: true});
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 2, knownTokens: 23, unresolved: 0, unknown: 1}));
});

it.each(['nonzero', 'timeout', 'cancel', 'revoke'] as const)('does not relax a valid frame after %s and persists unsafe blocking across restart', async mode => {
  const path = await makeDirectory();
  let authorized = true;
  const owner = await openOwner(path);
  const gate = newGate(path, `unsafe-${mode}`);
  const session = makeSession(owner, path, `conversation-${mode}`, [gate], knownStream(false),
    {timeoutMs: mode === 'timeout' ? 100 : 5_000, cleanupMs: 1_000}, () => authorized,
    (value, output) => framedUnknownScript(value, output, mode === 'nonzero' ? 'nonzero' : 'hold'));
  const controller = new AbortController();
  const pending = session.session.observe(observerInput, controller.signal);
  await waitForFile(gate.ready);
  if (mode === 'cancel') controller.abort();
  if (mode === 'revoke') { authorized = false; session.session.disable(); }
  const result = await pending;
  expect(result.usage).toBeNull();
  expect(result.outcomes?.usage).toBe('unknown');
  expect(owner.recoveryStatus?.()).toMatchObject({state: 'blocked'});
  await session.session.close();
  await owner.close();

  const reopened = await openReleaseAccounting(path, () => 0);
  closers.push(() => reopened.close());
  expect(reopened.recoveryStatus()).toMatchObject({state: 'blocked'});
  expect(await reopened.recoveryAdmission(0, true, `conversation-${mode}`)).toMatchObject({allowed: false, reason: 'unsafe_unknown'});
});
