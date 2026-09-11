import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';
import {createAccountedObserverWorker} from '../../src/estimation/observer-worker.js';
import {ObserverScheduler, type ObserverWorker} from '../../src/estimation/observer-scheduler.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';

const token = 'protected-observer-recovery-e2e-token-123456789';
const interpretation = {relation: 'replace', status: 'running', summary: 'Build a report', estimate: {remainingSeconds: 600, errorPercent: 30}};
const framedUnknown = [
  {type: 'turn.started'},
  {type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: JSON.stringify(interpretation)}},
  {type: 'turn.completed'},
].map(value => JSON.stringify(value)).join('\n') + '\n';
const unsafeOutput = JSON.stringify({type: 'turn.started'}) + '\n';
const observerInput: ObserverInput = {goalSummary: null, activeSeconds: 20, runtime: 'running',
  messages: [{kind: 'user', text: 'Build a report', truncated: false}], truncated: false};

const paths: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-observer-recovery-e2e-'));
  paths.push(path);
  return path;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('TEST_EVENTUALLY_TIMEOUT');
}

function goal(scheduler: ObserverScheduler, goals: PassiveGoals, contexts: PassiveContextStore, key: string, now: number): string {
  const envelope = normalizeHookInput('UserPromptSubmit', {session_id: key, turn_id: 'turn-1', tool_use_id: `tool-${key}`}, now, token).envelope;
  envelope.content = {kind: 'user', text: 'task data', truncated: false};
  goals.observe(envelope, true, now);
  contexts.ingest(envelope, now);
  scheduler.changed(envelope.sessionKey, 'prompt');
  return envelope.sessionKey;
}

function worker(owner: ReleaseAccountingOwner, output: string, now: () => number): ObserverWorker {
  return createAccountedObserverWorker({
    accounting: owner,
    now,
    authorize: () => true,
    prepare: input => ({executable: process.execPath, cwd: process.cwd(), args: ['-e', `process.stdout.write(${JSON.stringify(output)})`], env: process.env, input: JSON.stringify(input)}),
  });
}

function makeScheduler(owner: ReleaseAccountingOwner, outputs: string[], now: () => number): {scheduler: ObserverScheduler; goals: PassiveGoals; contexts: PassiveContextStore} {
  const contexts = new PassiveContextStore();
  const goals = new PassiveGoals(contexts);
  const workers = outputs.map(output => worker(owner, output, now));
  const scheduler = new ObserverScheduler({contexts, goals, workers, now});
  closers.push(() => scheduler.close());
  return {scheduler, goals, contexts};
}

async function seedCooldown(owner: ReleaseAccountingOwner): Promise<void> {
  for (const key of ['seed-a', 'seed-b', 'seed-c']) {
    const view = owner.forConversation(key);
    const id = await view.reserve();
    await view.settle(id!, null, 'safe_unknown');
  }
}

it('keeps a valid framed unknown result enabled and records durable warning through scheduler and worker', async () => {
  let now = 0;
  const owner = await openReleaseAccounting(await directory(), () => now);
  closers.push(() => owner.close());
  const {scheduler, goals, contexts} = makeScheduler(owner, [framedUnknown], () => now);
  goal(scheduler, goals, contexts, 'safe-unknown', now);
  now = 15_000;
  scheduler.tick();
  await eventually(() => owner.snapshot().unknown === 1);
  expect(scheduler.stats().disabled).toBe(false);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', recoveryAllowed: false});
});

it('serializes half-open admission across two real workers and carries cooldown through restart', async () => {
  let now = 0;
  const path = await directory();
  let owner = await openReleaseAccounting(path, () => now);
  for (const key of ['seed-a', 'seed-b', 'seed-c']) {
    const view = owner.forConversation(key);
    const id = await view.reserve();
    await view.settle(id!, null, 'safe_unknown');
  }
  expect(owner.recoveryStatus()).toMatchObject({state: 'cooldown', cooldownUntil: 300_000});
  await owner.close();
  owner = await openReleaseAccounting(path, () => now);
  const first = makeScheduler(owner, [framedUnknown, framedUnknown], () => now);
  goal(first.scheduler, first.goals, first.contexts, 'half-open-a', now);
  goal(first.scheduler, first.goals, first.contexts, 'half-open-b', now);
  now = 300_000;
  first.scheduler.tick();
  await eventually(() => owner.snapshot().starts === 4);
  await eventually(() => owner.snapshot().unknown === 4);
  expect(owner.recoveryStatus()).toMatchObject({state: 'cooldown', cooldownUntil: 1_200_000});
  expect(first.scheduler.stats().disabled).toBe(false);
  await first.scheduler.close();
  await owner.close();
  owner = await openReleaseAccounting(path, () => now);
  const second = makeScheduler(owner, [framedUnknown], () => now);
  goal(second.scheduler, second.goals, second.contexts, 'after-half-open-restart', now);
  second.scheduler.tick();
  expect(owner.snapshot().starts).toBe(4);
  now = 1_200_000;
  second.scheduler.tick();
  await eventually(() => owner.snapshot().starts === 5);
  await eventually(() => owner.snapshot().unknown === 5);
  expect(second.scheduler.stats().disabled).toBe(false);
  await second.scheduler.close();
  await owner.close();
});

it('persists invocation-local missing-usage backoff across scheduler and owner restart', async () => {
  let now = 0;
  const path = await directory();
  let owner = await openReleaseAccounting(path, () => now);
  closers.push(() => owner.close());
  const {scheduler, goals, contexts} = makeScheduler(owner, [unsafeOutput], () => now);
  const key=goal(scheduler, goals, contexts, 'unsafe-unknown', now);
  now = 15_000;
  scheduler.tick();
  await eventually(() => owner.snapshot().unknown === 1);
  expect(scheduler.stats().disabled).toBe(false);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning'});
  expect(await owner.recoveryAdmission(now, true, key)).toMatchObject({allowed:false,reason:'retry_backoff',nextEligibleAt:75000});
  await scheduler.close();
  await owner.close();
  owner = await openReleaseAccounting(path, () => now);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning'});
  expect(await owner.recoveryAdmission(now,true,key)).toMatchObject({allowed:false,reason:'retry_backoff'});
  expect(await owner.recoveryAdmission(now,true,'independent')).toMatchObject({allowed:true});
  expect(owner.snapshot()).toMatchObject({starts:1,unknown:1,knownTokens:0,inFlight:0});
  await owner.close();
});

it('releases a cancelled half-open claim and blocks an un-settled claim after restart', async () => {
  let now = 0;
  const path = await directory();
  let owner = await openReleaseAccounting(path, () => now);
  closers.push(() => owner.close());
  for (const key of ['cancel-seed-a', 'cancel-seed-b', 'cancel-seed-c']) {
    const view = owner.forConversation(key);
    const id = await view.reserve();
    await view.settle(id!, null, 'safe_unknown');
  }
  now = 300_000;
  const claimed = await owner.recoveryAdmission(now, true, 'cancelled-half-open');
  expect(claimed).toMatchObject({allowed: true, kind: 'half_open'});
  const view = owner.forConversation('cancelled-half-open');
  const id = await view.reserve('half_open');
  await view.cancelBeforeDispatch(id!);
  expect(await owner.recoveryAdmission(now, true, 'cancelled-half-open')).toMatchObject({allowed: true, kind: 'half_open'});
  const secondId = await view.reserve('half_open');
  await view.cancelBeforeDispatch(secondId!);
  await owner.close();

  owner = await openReleaseAccounting(path, () => now);
  const crashClaim = await owner.recoveryAdmission(now, true, 'crashed-half-open');
  expect(crashClaim).toMatchObject({allowed: true, kind: 'half_open'});
  const crashView = owner.forConversation('crashed-half-open');
  expect(await crashView.reserve('half_open')).not.toBeNull();
  await owner.close();
  owner = await openReleaseAccounting(path, () => now);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning'});
  expect(await owner.recoveryAdmission(now, true, 'crashed-half-open')).toMatchObject({allowed: false,reason:'unresolved_previous_call'});
  expect(await owner.recoveryAdmission(now, true, 'after-crash')).toMatchObject({allowed: true});
  expect(owner.snapshot()).toMatchObject({inFlight:1,unknown:3});
  await owner.close();
});

it.each(['abort', 'authorization', 'setup', 'invalid'] as const)('real worker releases an unreserved half-open claim after %s and permits the next eligible claim', async mode => {
  let now = 0;
  const owner = await openReleaseAccounting(await directory(), () => now);
  closers.push(() => owner.close());
  await seedCooldown(owner);
  now = 300_000;
  let authorized = true;
  const workerNow = () => { if (mode === 'authorization') authorized = false; return now; };
  const worker = createAccountedObserverWorker({
    accounting: owner,
    now: workerNow,
    authorize: () => authorized,
    prepare: () => {
      if (mode === 'setup') throw new Error('TEST_SETUP_FAILURE');
      return {executable: process.execPath, cwd: process.cwd(), args: ['-e', `process.stdout.write(${JSON.stringify(framedUnknown)})`], env: process.env, input: JSON.stringify(observerInput)};
    },
  });
  closers.push(() => worker.close());
  const signal = new AbortController();
  if (mode === 'abort') signal.abort();
  const value = mode === 'invalid'
    ? await worker.observe({invalid: true} as never, signal.signal, `pre-reservation-${mode}`)
    : await worker.observe(observerInput, signal.signal, `pre-reservation-${mode}`);
  expect(value.status).toBe(mode === 'abort' ? 'aborted' : mode === 'authorization' ? 'disabled' : mode === 'invalid' ? 'invalid_input' : 'process_error');
  expect(owner.recoveryStatus()).toMatchObject({state: 'cooldown'});
  const next = await owner.recoveryAdmission(now, true, `next-${mode}`);
  expect(next).toMatchObject({allowed: true, kind: 'half_open'});
  await owner.forConversation(`next-${mode}`).releaseRecoveryAdmission?.();
});

it('does not release a foreign or pending half-open claim', async () => {
  let now = 0;
  const owner = await openReleaseAccounting(await directory(), () => now);
  closers.push(() => owner.close());
  await seedCooldown(owner);
  now = 300_000;
  expect(await owner.recoveryAdmission(now, true, 'claim-owner')).toMatchObject({allowed: true, kind: 'half_open'});
  await owner.forConversation('wrong-owner').releaseRecoveryAdmission?.();
  expect(await owner.recoveryAdmission(now, true, 'wrong-owner')).toMatchObject({allowed: false, reason: 'half_open_busy'});
  const view = owner.forConversation('claim-owner');
  const pending = await view.reserve('half_open');
  expect(pending).not.toBeNull();
  await view.releaseRecoveryAdmission?.();
  expect(owner.snapshot()).toMatchObject({inFlight: 1});
  expect(await owner.recoveryAdmission(now, true, 'next-owner')).toMatchObject({allowed: false, reason: 'half_open_busy'});
  await view.cancelBeforeDispatch(pending!);
});

it('releases an unreserved half-open claim on restart but preserves a reserved claim', async () => {
  let now = 0;
  const path = await directory();
  let owner = await openReleaseAccounting(path, () => now);
  closers.push(() => owner.close());
  await seedCooldown(owner);
  now = 300_000;
  expect(await owner.recoveryAdmission(now, true, 'restart-before-reserve')).toMatchObject({allowed: true, kind: 'half_open'});
  await owner.close();
  owner = await openReleaseAccounting(path, () => now);
  closers.push(() => owner.close());
  expect(owner.recoveryStatus()).not.toMatchObject({state: 'blocked'});
  expect(await owner.recoveryAdmission(now, true, 'after-restart')).toMatchObject({allowed: true, kind: 'half_open'});
  const view = owner.forConversation('after-restart');
  expect(await view.reserve('half_open')).not.toBeNull();
  await owner.close();
  owner = await openReleaseAccounting(path, () => now);
  closers.push(() => owner.close());
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning'});
  expect(owner.snapshot()).toMatchObject({inFlight:1,unknown:3});
  expect(await owner.recoveryAdmission(now,true,'after-restart')).toMatchObject({allowed:false,reason:'unresolved_previous_call'});
});
