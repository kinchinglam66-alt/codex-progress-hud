import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {expect, it, vi} from 'vitest';
import {createObserverAccountReader} from '../../src/estimation/observer-account-reader.js';
import {ObserverAccountTimeout} from '../../src/estimation/observer-call-failure.js';

type Account = {type: 'chatgpt'; email: string | null; planType: string};
type Snapshot = {accountId: string | null; account: Account | null; requiresOpenaiAuth: boolean};
type Mode = 'valid' | 'logged-out' | 'bad-route' | 'changed-route' | 'missing-route' | 'missing-account-id' | 'api-auth' | 'api-key' | 'unsafe-id' | 'unicode-id' | 'oversized-id' | 'changed-email' | 'changed-plan' | 'changed-id' | 'malformed' | 'duplicate' | 'error' | 'updated' | 'trailing' | 'flood' | 'silent' | 'draining';

const account = (email: string | null = 'reader@example.com', planType = 'plus'): Account => ({
  type: 'chatgpt', email, planType,
});

function snapshot(mode: Mode, read: number): Snapshot {
  return {
    accountId: mode === 'missing-account-id' ? null : mode === 'changed-id' && read > 0 ? 'acct-two' : 'acct-one',
    account: mode === 'api-auth' ? null : mode === 'changed-email' && read > 0 ? account('changed@example.com') : account(),
    requiresOpenaiAuth: mode !== 'api-auth',
  };
}

function launch(mode: Mode, onChild?: (child: ChildProcessWithoutNullStreams) => void): () => ChildProcessWithoutNullStreams {
  return () => {
    const script = [
      "const readline = require('node:readline');",
      `const mode = ${JSON.stringify(mode)};`,
      'let accountReads = 0;',
      'let configReads = 0;',
      'const write = value => process.stdout.write(JSON.stringify(value) + \'\\n\');',
      'const sendSnapshot = (id, rateLimits) => {',
      '  const value = {accountId: rateLimits ? (mode === \'missing-account-id\' ? null : (mode === \'unsafe-id\' ? \' acct-one\' : (mode === \'unicode-id\' ? \'acct-\\u202e-one\' : (mode === \'oversized-id\' ? \'x\'.repeat(300) : (mode === \'changed-id\' && accountReads > 1 ? \'acct-two\' : \'acct-one\'))))) : undefined};',
      '  if (rateLimits) write({id, result: {accountId: value.accountId, rateLimits: {planType: \'plus\'}}});',
      '  else { const changedEmail = mode === \'changed-email\' && accountReads > 0; const changedPlan = mode === \'changed-plan\' && accountReads > 0; write({id, result: {account: mode === \'api-auth\' ? null : {type: mode === \'api-key\' ? \'apiKey\' : \'chatgpt\', email: changedEmail ? \'changed@example.com\' : \'reader@example.com\', planType: changedPlan ? \'pro\' : \'plus\'}, requiresOpenaiAuth: mode !== \'api-auth\'}}); accountReads++; }',
      '};',
      'if (mode === \'silent\') { process.stdin.resume(); }',
      'else if (mode === \'malformed\') { process.stdout.write(\'{malformed\\n\'); process.stdin.resume(); }',
      'else if (mode === \'flood\') { process.stdout.write(\'x\'.repeat(600000)); process.stdin.resume(); }',
      'else {',
      '  const rl = readline.createInterface({input: process.stdin});',
      '  rl.on(\'line\', line => {',
      '    const request = JSON.parse(line);',
      '    if (request.method === \'initialize\') write({id: request.id, result: {protocolVersion: \'2\'}});',
      '    else if (request.method === \'initialized\') write({method: \'unrelated/notification\', params: {secret: \'must-not-leak\'}});',
      `    else if (request.method === 'config/read') {
        const bad = mode === 'bad-route' || (mode === 'changed-route' && configReads > 0);
        const config = {model_provider:'openai',forced_login_method:'chatgpt',cli_auth_credentials_store:'file',chatgpt_base_url:bad?'https://relay.invalid/':'https://chatgpt.com/backend-api/',model_providers:{}};
        write({id:request.id,result:{config:mode==='missing-route'?{}:config,origins:{}}});
        configReads++;
        if(mode==='trailing' && configReads===2) process.stdout.write('trailing-data');
      }`,
      '    else if (request.method === \'account/read\') {',
      `      if(mode==='logged-out') {write({id:request.id,result:{account:null,requiresOpenaiAuth:true}});return;}`,
      '      if (mode === \'error\') write({id: request.id, error: {code: -32000, message: \'private backend detail\'}});',
      '      else if (mode === \'duplicate\') write({id: 1, result: {account: {type: \'chatgpt\', email: \'reader@example.com\', planType: \'plus\'}, requiresOpenaiAuth: true}});',
      '      else { sendSnapshot(request.id, false); }',
      '    } else if (request.method === \'account/rateLimits/read\') {',
      '      if (mode === \'updated\') write({method: \'account/updated\', params: {secret: \'must-not-leak\'}});',
      '      else if (mode === \'duplicate\') write({id: request.id, result: {accountId: \'acct-one\', rateLimits: {planType: \'plus\'}}});',
      '      else { sendSnapshot(request.id, true); }',
      '    }',
      '  });',
      '  process.stdin.on(\'end\', () => { if (mode !== \'draining\') process.exit(0); });',
      '  if (mode === \'draining\') setInterval(() => {}, 1000);',
      '}',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    onChild?.(child);
    return child;
  };
}

it('reads a stable ChatGPT account using the exact bounded observer protocol and is reusable', async () => {
  const requests: Array<{id?: unknown; method?: unknown; params?: unknown}> = [];
  const reader = createObserverAccountReader(() => {
    const child = launch('valid')();
    const originalWrite = child.stdin.write.bind(child.stdin);
    const write = vi.spyOn(child.stdin, 'write');
    write.mockImplementation((chunk: string | Uint8Array, ...args: any[]) => {
      for (const line of chunk.toString().trim().split('\n')) if (line) requests.push(JSON.parse(line));
      return originalWrite(chunk, ...args);
    });
    return child;
  });
  try {
    await expect(reader.read(new AbortController().signal)).resolves.toEqual({accountId: 'acct-one', email: 'reader@example.com', planType: 'plus',routeFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
    await expect(reader.read(new AbortController().signal)).resolves.toEqual({accountId: 'acct-one', email: 'reader@example.com', planType: 'plus',routeFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
  } finally { reader.disable(); }
  expect(requests.filter(value => value.method).map(value => value.method)).toEqual([
    'initialize', 'initialized', 'config/read', 'account/read', 'account/rateLimits/read', 'account/read', 'account/rateLimits/read', 'config/read',
    'initialize', 'initialized', 'config/read', 'account/read', 'account/rateLimits/read', 'account/read', 'account/rateLimits/read', 'config/read',
  ]);
  expect(requests.filter(value => value.method === 'account/read').every(value => JSON.stringify(value.params) === JSON.stringify({refreshToken: false}))).toBe(true);
  expect(requests.filter(value => value.method === 'account/rateLimits/read').every(value => !('params' in value))).toBe(true);
  expect(requests.filter(value=>value.method==='config/read').every(value=>JSON.stringify(value.params)===JSON.stringify({includeLayers:false}))).toBe(true);
});

it('allows a healthy account response delayed beyond five seconds by default',async()=>{
 const reader=createObserverAccountReader(launch('valid',child=>{
  child.stdout.pause();setTimeout(()=>child.stdout.resume(),5200);
 }));
 try{await expect(reader.read(new AbortController().signal)).resolves.toMatchObject({planType:'plus'});}
 finally{reader.disable();}
},10000);

it('reports timeout separately without exposing account data',async()=>{
 const diagnostics:unknown[]=[];
 const reader=createObserverAccountReader(launch('silent'),40,value=>diagnostics.push(value));
 await expect(reader.read(new AbortController().signal)).rejects.toBeInstanceOf(ObserverAccountTimeout);
 expect(diagnostics).toEqual([expect.objectContaining({reason:'timeout',phase:0})]);
 expect(reader.ownership()).toBe('idle');
});

it.each(['bad-route','changed-route','missing-route','missing-account-id', 'api-auth', 'api-key', 'unsafe-id', 'unicode-id', 'oversized-id', 'changed-email', 'changed-plan', 'changed-id', 'malformed', 'duplicate', 'error', 'updated'] as Mode[])(
  'fails closed for %s without exposing child data', async mode => {
    const reader = createObserverAccountReader(launch(mode), 500);
    try { await expect(reader.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED'); }
    finally { reader.disable(); }
  },
);

it('cancels the owned child, rejects overlap, and retains uncertain termination', async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const reader = createObserverAccountReader(launch('silent', value => { child = value; }), 40);
  const controller = new AbortController();
  const pending = reader.read(controller.signal);
  await expect(reader.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READER_BUSY');
  controller.abort();
  await expect(pending).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED');
  expect(child).toBeDefined();
  reader.disable();
  await vi.waitFor(() => expect(reader.ownership()).toBe('idle'));
});

it('identifies explicit logged-out state separately from malformed or failed account checks',async()=>{
  const reader=createObserverAccountReader(launch('logged-out'));
  try {await expect(reader.read(new AbortController().signal)).rejects.toThrow(/^OBSERVER_LOGIN_REQUIRED$/);}
  finally {reader.disable();}
  expect(reader.ownership()).toBe('idle');
});

it('poisons the reader when termination is not confirmed and never reuses that slot', async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let realKill: (() => boolean) | undefined;
  const reader = createObserverAccountReader(launch('silent', value => {
    child = value;
    realKill = value.kill.bind(value);
    vi.spyOn(value, 'kill').mockReturnValue(false);
  }), 25);
  const controller = new AbortController();
  const pending = reader.read(controller.signal);
  await vi.waitFor(() => expect(child).toBeDefined());
  controller.abort();
  await expect(pending).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED');
  expect(reader.ownership()).toBe('termination_failed');
  await expect(reader.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READER_DISABLED');
  realKill?.();
  await vi.waitFor(() => expect(reader.ownership()).toBe('idle'));
});

it('terminates a child when abort arrives during graceful draining', async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let draining!: () => void;
  const drainStarted = new Promise<void>(resolve => { draining = resolve; });
  const reader = createObserverAccountReader(launch('draining', value => {
    child = value;
    value.stdin.once('finish', draining);
  }), 500);
  const controller = new AbortController();
  try {
    const pending = reader.read(controller.signal);
    await drainStarted;
    controller.abort();
    await expect(pending).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED');
    expect(reader.ownership()).toBe('idle');
  } finally { reader.disable(); }
});

it('rejects non-whitespace trailing data after the final complete frame', async () => {
  const reader = createObserverAccountReader(launch('trailing'), 500);
  try { await expect(reader.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED'); }
  finally { reader.disable(); }
});

it('bounds silent and oversized streams and supports disable before a read', async () => {
  const silent = createObserverAccountReader(launch('silent'), 25);
  await expect(silent.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED');
  silent.disable();
  const flood = createObserverAccountReader(launch('flood'), 500);
  await expect(flood.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READ_FAILED');
  flood.disable();
  await expect(flood.read(new AbortController().signal)).rejects.toThrow('OBSERVER_ACCOUNT_READER_DISABLED');
});
