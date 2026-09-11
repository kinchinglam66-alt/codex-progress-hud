import {access, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {ChildProcess} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';
import {createAccountedObserverWorker} from '../../src/estimation/observer-worker.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
import type {Invocation} from '../../src/estimation/owned-process.js';
import {createObserverConsentGate} from '../../src/estimation/observer-consent.js';

const input: ObserverInput = {
  goalSummary: null,
  activeSeconds: 20,
  runtime: 'running',
  messages: [{kind: 'user', text: 'Build a report password=private', truncated: false}],
  truncated: false,
};
const interpretation = {
  relation: 'replace' as const,
  status: 'running' as const,
  summary: 'Build a report',
  estimate: {remainingSeconds: 7200, errorPercent: 40},
};
it('preserves the local recovery cooldown reason without preparing a model invocation', async()=>{
  const accounting=await owner(await directory());
  for(const key of ['a','b','c']){
    const view=accounting.forConversation(key), id=await view.reserve();
    await view.settle(id!,null,'safe_unknown');
    await view.close();
  }
  let prepared=false;
  const subject=createAccountedObserverWorker({accounting,authorize:()=>true,now:()=>0,
    prepare:()=>{prepared=true;throw new Error('must not prepare');}});
  try{
    expect(await subject.observe(input,new AbortController().signal,'denied')).toMatchObject({
      status:'admission_denied',admissionReason:'cooldown',usage:null,
    });
    expect(prepared).toBe(false);
    expect(accounting.snapshot().starts).toBe(3);
  }finally{await subject.close();}
});
it('blocks the unresolved conversation after reopen while independently preparing another conversation',async()=>{
  const path=await directory(), first=await owner(path);
  await first.forConversation('previous').reserve();
  await first.close();
  const reopened=await owner(path);
  const prepare=vi.fn(()=>{throw new Error('controlled preparation failure');});
  const subject=createAccountedObserverWorker({accounting:reopened,authorize:()=>true,now:()=>0,
    prepare});
  try{
    expect(await subject.observe(input,new AbortController().signal,'previous')).toMatchObject({
      status:'admission_denied',admissionReason:'unresolved_previous_call',usage:null,
    });
    expect(reopened.snapshot()).toMatchObject({starts:1,inFlight:1,unknown:0});
    expect(prepare).not.toHaveBeenCalled();
    expect(await subject.observe(input,new AbortController().signal,'new')).toMatchObject({status:'process_error',usage:null});
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(reopened.snapshot()).toMatchObject({starts:1,inFlight:1,unknown:0,knownTokens:0});
  }finally{await subject.close();}
});
const stream = (includeUsage = true) => [
  {type: 'turn.started'},
  {type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: JSON.stringify(interpretation)}},
  {type: 'turn.completed', ...(includeUsage ? {usage: {input_tokens: 20, output_tokens: 3, cached_input_tokens: 5}} : {})},
].map(event => JSON.stringify(event)).join('\n') + '\n';

interface Gate {ready: string; release: string; closed: string}
const paths: string[] = [];
const owners: ReleaseAccountingOwner[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-observer-worker-'));
  paths.push(path);
  return path;
}

function gate(path: string, name: string): Gate {
  return {ready: join(path, `${name}.ready`), release: join(path, `${name}.release`), closed: join(path, `${name}.closed`)};
}

function scriptFor(g: Gate, output: string, ignoreTermination = false): string {
  return [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(g.ready)}, 'ready');`,
    `process.on('exit',()=>fs.writeFileSync(${JSON.stringify(g.closed)}, 'closed'));`,
    ignoreTermination ? "process.on('SIGTERM',()=>{});" : '',
    "process.stdin.resume();process.stdin.on('data',()=>{});",
    `process.stdin.on('end',()=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(g.release)})){clearInterval(timer);process.stdout.write(${JSON.stringify(output)});}},5);});`,
  ].join('');
}

function simpleScript(output = stream()): string {
  return `process.stdout.write(${JSON.stringify(output)})`;
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    try { await access(path); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw new Error(`TEST_CHILD_NOT_READY:${path}`);
}

async function waitForInactive(value: ReturnType<typeof worker>, attempts = 1_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!value.status().active) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('TEST_CHILD_NOT_CLOSED');
}

async function owner(path: string): Promise<ReleaseAccountingOwner> {
  const value = await openReleaseAccounting(path, () => 0);
  owners.push(value);
  return value;
}

function worker(accounting: ReleaseAccountingOwner, script: () => string, authorize = () => true) {
  return createAccountedObserverWorker({
    accounting,
    authorize,
    prepare: value => ({
      executable: process.execPath,
      cwd: process.cwd(),
      args: ['-e', script()],
      env: process.env,
      input: JSON.stringify(value),
    }),
  });
}

afterEach(async () => {
  for (const value of owners.splice(0).reverse()) await value.close().catch(() => undefined);
  for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});
});

it.each([false, true])('waits for async preparation before admission (disable=%s)', async disableDuring => {
  const accounting=await owner(await directory());
  let release!:(value:Invocation)=>void;
  const prepared=new Promise<Invocation>(resolve=>{release=resolve;});
  let entered!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;});
  let preparationSignal:AbortSignal|undefined;
  const value=createAccountedObserverWorker({accounting,authorize:()=>true,
    prepare:async (_input,signal)=>{preparationSignal=signal;entered();return prepared;}});
  const pending=value.observe(input,new AbortController().signal,'async-prepare');
  await entering;
  expect(accounting.snapshot().starts).toBe(0);
  expect(value.status().active).toBe(true);
  if(disableDuring) value.disable();
  release({executable:process.execPath,cwd:process.cwd(),args:['-e',simpleScript()],env:process.env,input:''});
  expect((await pending).status).toBe(disableDuring?'disabled':'interpreted');
  expect(accounting.snapshot().starts).toBe(disableDuring?0:1);
  if(disableDuring) expect(preparationSignal?.aborted).toBe(true);
  await value.close();
});

it('reuses workers across keys and preserves usage without a twelve-call cap through replacement', async () => {
  const path = await directory();
  const accounting = await owner(path);
  const first = worker(accounting, simpleScript);
  await expect(first.observe(input, new AbortController().signal, 'conversation-a')).resolves.toMatchObject({status: 'interpreted'});
  await expect(first.observe(input, new AbortController().signal, 'conversation-b')).resolves.toMatchObject({status: 'interpreted'});
  await first.close();
  await expect(first.observe(input, new AbortController().signal, 'closed-worker')).resolves.toMatchObject({status: 'disabled'});

  const replacement = worker(accounting, simpleScript);
  for (let call = 0; call < 10; call++) {
    await expect(replacement.observe(input, new AbortController().signal, 'conversation-a')).resolves.toMatchObject({status: 'interpreted'});
  }
  await expect(replacement.observe(input, new AbortController().signal, 'conversation-a')).resolves.toMatchObject({status: 'interpreted'});
  await expect(replacement.observe(input, new AbortController().signal, 'conversation-a')).resolves.toMatchObject({status: 'interpreted'});
  expect(accounting.snapshot()).toMatchObject({starts: 14, knownTokens: 322, unknown: 0, unresolved: 0});
  await replacement.close();

  const later = accounting.forConversation('after-worker-close');
  const id = await later.reserve();
  expect(id).not.toBeNull();
  await later.settle(id!, {inputTokens: 1, outputTokens: 1, cachedInputTokens: 0});
  await later.close();
});

it('does not reserve for an invalid key or missing authorization', async () => {
  const path = await directory();
  const accounting = await owner(path);
  let preparations = 0;
  const unauthorized = createAccountedObserverWorker({
    accounting,
    authorize: () => false,
    prepare: value => {
      preparations++;
      return {executable: process.execPath, cwd: process.cwd(), args: ['-e', simpleScript()], env: process.env, input: JSON.stringify(value)};
    },
  });
  await expect(unauthorized.observe(input, new AbortController().signal, 'conversation-a')).resolves.toMatchObject({status: 'disabled'});
  expect(preparations).toBe(0);
  await unauthorized.close();

  const invalid = worker(accounting, simpleScript);
  await expect(invalid.observe(input, new AbortController().signal, '')).resolves.toEqual({status: 'process_error', interpretation: null, usage: null});
  expect(accounting.snapshot()).toMatchObject({starts: 0, unresolved: 0, unknown: 0});
  await invalid.close();
});

it('excludes a busy slot and drains a disabled child to actual closure', async () => {
  const path = await directory();
  const accounting = await owner(path);
  const firstGate = gate(path, 'busy');
  const value = worker(accounting, () => scriptFor(firstGate, stream()));
  const first = value.observe(input, new AbortController().signal, 'conversation-a');
  await waitFor(firstGate.ready);
  await expect(value.observe(input, new AbortController().signal, 'conversation-b')).resolves.toMatchObject({status: 'busy'});
  await writeFile(firstGate.release, 'release');
  await expect(first).resolves.toMatchObject({status: 'interpreted'});

  const disabledGate = gate(path, 'disabled');
  const disabled = worker(accounting, () => scriptFor(disabledGate, stream()));
  const pending = disabled.observe(input, new AbortController().signal, 'conversation-c');
  await waitFor(disabledGate.ready);
  disabled.disable();
  await expect(pending).resolves.toMatchObject({status: 'disabled', interpretation: null});
  await waitForInactive(disabled);
  expect(disabled.status()).toMatchObject({active: false, disabled: true});
  await value.close();
  await disabled.close();
});

it('suppresses a revoked result while retaining known usage', async () => {
  const path = await directory();
  const accounting = await owner(path);
  let consent = true;
  let enteredClose!: () => void, releaseClose!: () => void;
  const entered = new Promise<void>(resolve => { enteredClose = resolve; });
  const released = new Promise<void>(resolve => { releaseClose = resolve; });
  const delayedClose: ReleaseAccountingOwner = {...accounting, forConversation(key) {
    const view = accounting.forConversation(key);
    return {...view, async close() {
      await view.close();
      enteredClose();
      await released;
    }};
  }};
  const value = worker(delayedClose, simpleScript, () => consent);
  const pending = value.observe(input, new AbortController().signal, 'conversation-revoked');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('TEST_DRAIN_NOT_REACHED')), 3000);
    })]);
    expect(accounting.snapshot()).toMatchObject({starts: 1, knownTokens: 23, unknown: 0, unresolved: 0});
    consent = false;
    releaseClose();
    await expect(pending).resolves.toMatchObject({status: 'disabled', interpretation: null, usage: {inputTokens: 20, outputTokens: 3}});
  } finally {
    clearTimeout(timer);
    releaseClose();
    await value.close();
  }
});

it('revoking consent stops the real owned child and denies further reservation', async () => {
  const path = await directory();
  const accounting = await owner(path);
  const child = gate(path, 'consent-revoke');
  let value: ReturnType<typeof worker> | undefined;
  const consent = createObserverConsentGate({now: () => 0, onInvalidate() {value?.disable();}});
  consent.update({accountFingerprint: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64),
    assetsFingerprint: 'c'.repeat(64), observedAt: 0, expiresAt: 1000});
  expect(consent.accept(consent.offer()!)).toBe(true);
  value = worker(accounting, () => scriptFor(child, stream()), consent.authorized);
  const pending = value.observe(input, new AbortController().signal, 'consent-owned');
  try {
    await waitFor(child.ready);
    consent.revoke();
    await expect(pending).resolves.toMatchObject({status: 'disabled', interpretation: null});
    expect(value.status().active).toBe(false);
    expect(accounting.snapshot()).toMatchObject({starts: 1, unresolved: 0});
    await expect(value.observe(input, new AbortController().signal, 'later')).resolves.toMatchObject({status: 'disabled'});
    expect(accounting.snapshot().starts).toBe(1);
  } finally {await value.close();}
});

it('turns missing usage into unknown accounting and permits bounded warning admissions', async () => {
  const path = await directory();
  const accounting = await owner(path);
  const value = worker(accounting, () => simpleScript(stream(false)));
  await expect(value.observe(input, new AbortController().signal, 'conversation-unknown')).resolves.toMatchObject({status: 'interpreted', usage: null,
    outcomes:{prediction:'numeric',call:'success',usage:'unknown',framingValid:true,closureConfirmed:true}});
  expect(accounting.snapshot()).toMatchObject({starts: 1, unknown: 1, unresolved: 0});
  await expect(value.observe(input, new AbortController().signal, 'conversation-later')).resolves.toMatchObject({status: 'interpreted', usage: null});
  expect(accounting.snapshot()).toMatchObject({starts: 2, unknown: 2, unresolved: 0});
  await value.close();
});

it('poisons the slot when a disabled child will not confirm closure and refuses reuse', async () => {
  const path = await directory();
  const accounting = await owner(path);
  const child = gate(path, 'unconfirmed');
  const value = worker(accounting, () => scriptFor(child, stream(), true));
  const controller = new AbortController();
  const pending = value.observe(input, controller.signal, 'conversation-unconfirmed');
  await waitFor(child.ready);
  const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(false);
  try {
    controller.abort();
    await expect(pending).resolves.toMatchObject({status: 'aborted', interpretation: null, usage: null});
    expect(value.status()).toMatchObject({active: true, disabled: true, poisoned: true});
    await expect(value.observe(input, new AbortController().signal, 'conversation-after-failure')).resolves.toMatchObject({status: 'disabled'});
  } finally {
    kill.mockRestore();
  }
  try {
    await expect(value.close()).rejects.toThrow('OBSERVER_WORKER_CLOSE_UNCONFIRMED');
    // Once termination works again, close must retry the retained child owner.
    await waitForInactive(value, 200);
  } finally {
    await writeFile(child.release, 'release');
    await waitForInactive(value);
  }
}, 10_000);
