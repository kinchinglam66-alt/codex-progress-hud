import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingOwner} from '../../src/estimation/release-accounting.js';

const directories: string[] = [];
const owners: ReleaseAccountingOwner[] = [];
const DB_NAME = 'release-observer-accounting.sqlite';
const usage = {inputTokens: 10, outputTokens: 2, cachedInputTokens: 5};
it('persists not-dispatched separately, releases concurrency and retains hourly starts',async()=>{
  const path=await directory(),owner=await open(path,()=>0),view=owner.forConversation('one');
  const id=(await view.reserve())!;await view.cancelBeforeDispatch(id);
  expect(owner.snapshot()).toMatchObject({starts:1,inFlight:0,unknown:0,knownTokens:0,activeStarts:1});
  await expect(view.cancelBeforeDispatch(id)).rejects.toThrow();await owner.close();
  await mutateDatabase(path,db=>{expect(db.prepare('SELECT state FROM admissions WHERE id=?').get(id)).toMatchObject({state:'not_dispatched'});});
  const restored=await open(path,()=>0);expect(restored.snapshot()).toMatchObject({starts:1,inFlight:0,unknown:0,knownTokens:0});
  const next=restored.forConversation('one');
  for(let i=1;i<12;i++)await next.cancelBeforeDispatch((await next.reserve())!);
  expect(await next.reserve()).toBeNull();
});
it('does not let another conversation or reopened owner cancel an uncertain reservation',async()=>{
  const path=await directory(),owner=await open(path,()=>0),id=(await owner.forConversation('one').reserve())!;
  await expect(owner.forConversation('two').cancelBeforeDispatch(id)).rejects.toThrow();await owner.close();
  const restored=await open(path,()=>0);await expect(restored.forConversation('one').cancelBeforeDispatch(id)).rejects.toThrow();
  expect(restored.snapshot()).toMatchObject({starts:1,inFlight:1,unknown:0});
});
it.each(['settled','pending','unknown'] as const)('migrates v2 %s accounting without erasing history or uncertainty',async state=>{
  const path=await directory(),id=randomUUID();
  await mutateDatabase(path,db=>{
    db.exec(`PRAGMA page_size=4096;PRAGMA journal_mode=DELETE;
      CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=2),
        cumulative_starts INTEGER NOT NULL,known_tokens INTEGER NOT NULL,unknown_count INTEGER NOT NULL,unknown_admission_ceiling INTEGER,last_admission INTEGER);
      CREATE TABLE admissions(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL UNIQUE,conversation TEXT NOT NULL,admitted_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown')),input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL);
      CREATE INDEX admissions_conversation_time ON admissions(conversation,admitted_at);
      CREATE INDEX admissions_state_time ON admissions(state,admitted_at);PRAGMA user_version=2;`);
    db.prepare('INSERT INTO metadata VALUES(1,2,1,?,?,?,0)').run(state==='settled'?12:0,state==='unknown'?1:0,state==='unknown'?1:null);
    insertAdmission(db,id,1,'one',0,state);
  });
  const owner=await open(path,()=>0);
  expect(owner.snapshot()).toMatchObject({starts:1,knownTokens:state==='settled'?12:0,unknown:state==='unknown'?1:0,unresolved:state==='pending'?1:0});
  if(state!=='settled')expect(await owner.forConversation('two').reserve()).toBeNull();
  if(state==='pending')await expect(owner.forConversation('one').cancelBeforeDispatch(id)).rejects.toThrow();
  await owner.close();
  await mutateDatabase(path,db=>{
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:3});
    expect(db.prepare('SELECT id,state FROM admissions').get()).toMatchObject({id,state});
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-release-accounting-'));
  directories.push(path);
  return path;
}

async function open(path: string, now: () => number) {
  const owner = await openReleaseAccounting(path, now);
  owners.push(owner);
  return owner;
}

async function initialize(path: string, now = 0): Promise<void> {
  const owner = await open(path, () => now);
  await owner.close();
  owners.pop();
}

async function mutateDatabase(path: string, mutation: (db: import('node:sqlite').DatabaseSync) => void): Promise<void> {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(join(path, DB_NAME));
  try { mutation(db); }
  finally { db.close(); }
}

function insertAdmission(db: import('node:sqlite').DatabaseSync, id: string, ordinal: number, conversation: string, admittedAt: number, state: 'pending' | 'settled' | 'unknown'): void {
  const token = state === 'settled' ? usage.inputTokens : 1_000_000_000;
  db.prepare('INSERT INTO admissions (id, ordinal, conversation, admitted_at, state, input_tokens, output_tokens, cached_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ordinal, conversation, admittedAt, state, token, state === 'settled' ? usage.outputTokens : 1_000_000_000, state === 'settled' ? usage.cachedInputTokens : 1_000_000_000);
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true});
});

it('admits two different conversations concurrently and denies a third or a duplicate conversation', async () => {
  let now = 0;
  const owner = await open(await directory(), () => now);
  const first = owner.forConversation('conversation-a');
  const second = owner.forConversation('conversation-b');
  const third = owner.forConversation('conversation-c');

  const [firstId, secondId, thirdId] = await Promise.all([first.reserve(), second.reserve(), third.reserve()]);
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  expect(secondId).toMatch(/^[0-9a-f-]{36}$/);
  expect(thirdId).toBeNull();
  expect(await first.reserve()).toBeNull();
  await first.settle(firstId!, usage);
  await second.settle(secondId!, usage);
  now = 1;
  expect(await third.reserve()).toMatch(/^[0-9a-f-]{36}$/);
});

it('keeps twelve starts consumed across reopen and releases the first at exactly one hour', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  for (let index = 0; index < 12; index++) {
    const id = await view.reserve();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await view.settle(id!, usage);
  }
  now = 3_599_999;
  await owner.close();
  await open(path, () => now);
  const reopened = owners.at(-1)!;
  expect(await reopened.forConversation('conversation-a').reserve()).toBeNull();
  await reopened.close();
  owners.pop();

  now = 3_600_000;
  const afterWindow = await open(path, () => now);
  const id = await afterWindow.forConversation('conversation-a').reserve();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await afterWindow.forConversation('conversation-a').settle(id!, usage);
});

it('replays known settlements and preserves durable reservation metadata', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('opaque-conversation-key');
  const id = await view.reserve();
  await view.settle(id!, usage);
  await owner.close();
  expect((await stat(join(path, DB_NAME))).size).toBeGreaterThan(0);
  await expect(stat(join(path, 'release-observer-accounting.jsonl'))).rejects.toThrow();

  const reopened = await open(path, () => now);
  expect(reopened.snapshot()).toEqual(expect.objectContaining({starts: 1, knownTokens: 12, unresolved: 0, unknown: 0}));
});

it('blocks admission after an unmatched restart until the known reservation settles', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  const id = await view.reserve();
  await owner.close();

  const reopened = await open(path, () => now);
  const recovered = reopened.forConversation('conversation-a');
  expect(await recovered.reserve()).toBeNull();
  await recovered.settle(id!, usage);
  expect(await recovered.reserve()).toMatch(/^[0-9a-f-]{36}$/);
});

it('treats null settlement as unknown and permanently blocks future admission', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  const id = await view.reserve();
  await view.settle(id!, null);
  await owner.close();
  const reopened = await open(path, () => now);
  expect(await reopened.forConversation('conversation-a').reserve()).toBeNull();
  expect(reopened.snapshot()).toEqual(expect.objectContaining({unknown: 1}));
});

it('rejects already queued reservations after the first admission commit fails', async () => {
  const owner = await open(await directory(), () => 0);
  const {DatabaseSync} = await import('node:sqlite');
  const original = DatabaseSync.prototype.exec;
  let failOnce = true;
  DatabaseSync.prototype.exec = function(sql: string): void {
    if (failOnce && sql === 'COMMIT') { failOnce = false; throw new Error('TEST_COMMIT_FAILURE'); }
    original.call(this, sql);
  };
  try {
    const results = await Promise.allSettled([
      owner.forConversation('first').reserve(),
      owner.forConversation('already-queued').reserve(),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(owner.snapshot()).toMatchObject({starts: 0, unresolved: 0, poisoned: true});
  } finally { DatabaseSync.prototype.exec = original; }
});

it('rejects cumulative admissions beyond the unknown ceiling even with the later row absent', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('unknown');
  await view.settle((await view.reserve())!, null);
  await owner.close();
  await mutateDatabase(path, db => db.exec('UPDATE metadata SET cumulative_starts = 2, last_admission = 1'));
  await expect(open(path, () => 1)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it.each([0, 1])('reopens unknown-then-known settlement with peer admission time %i', async peerTime => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const a = owner.forConversation('a'), b = owner.forConversation('b');
  const first = await a.reserve();
  now = peerTime;
  const second = await b.reserve();
  await a.settle(first!, null);
  await b.settle(second!, usage);
  await owner.close();
  const recovered = await open(path, () => now);
  expect(recovered.snapshot()).toMatchObject({starts: 2, knownTokens: 12, unknown: 1, unresolved: 0});
  expect(await recovered.forConversation('later').reserve()).toBeNull();
});

it('reopens a valid peer settled before an unknown result despite distinct admission times', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const unknownView = owner.forConversation('conversation-unknown');
  const knownView = owner.forConversation('conversation-known');
  const unknownId = await unknownView.reserve();
  now = 1;
  const knownId = await knownView.reserve();
  await knownView.settle(knownId!, usage);
  await unknownView.settle(unknownId!, null);
  await owner.close();
  owners.pop();

  const reopened = await open(path, () => now);
  expect(reopened.snapshot()).toEqual(expect.objectContaining({starts: 2, knownTokens: 12, unknown: 1, unresolved: 0}));
  expect(await reopened.forConversation('conversation-later').reserve()).toBeNull();
});

it('reopens with an unknown result and settles an earlier admitted pending peer', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const unknownView = owner.forConversation('conversation-unknown');
  const pendingView = owner.forConversation('conversation-pending');
  const unknownId = await unknownView.reserve();
  now = 1;
  const pendingId = await pendingView.reserve();
  await unknownView.settle(unknownId!, null);
  await owner.close();
  owners.pop();

  const reopened = await open(path, () => now);
  expect(await reopened.forConversation('conversation-later').reserve()).toBeNull();
  await reopened.forConversation('conversation-pending').settle(pendingId!, usage);
  expect(reopened.snapshot()).toEqual(expect.objectContaining({starts: 2, knownTokens: 12, unknown: 1, unresolved: 0}));
});

it('rejects duplicate and foreign settlements without changing totals', async () => {
  let now = 0;
  const owner = await open(await directory(), () => now);
  const first = owner.forConversation('conversation-a');
  const foreign = owner.forConversation('conversation-b');
  const id = await first.reserve();
  await expect(foreign.settle(id!, usage)).rejects.toThrow();
  await first.settle(id!, usage);
  await expect(first.settle(id!, usage)).rejects.toThrow();
  await expect(first.settle('00000000-0000-4000-8000-000000000000', usage)).rejects.toThrow();
  expect(owner.snapshot()).toEqual(expect.objectContaining({knownTokens: 12, unresolved: 0, unknown: 0}));
});

it('rejects a persisted reserve after unknown settlement as an invalid journal', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const id = await owner.forConversation('conversation-a').reserve();
  await owner.forConversation('conversation-a').settle(id!, null);
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => {
    db.exec('BEGIN IMMEDIATE');
    insertAdmission(db, randomUUID(), 2, 'conversation-a', 1, 'settled');
    db.prepare('UPDATE metadata SET cumulative_starts = 2, known_tokens = 12, last_admission = 1 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  await expect(openReleaseAccounting(path, () => 1)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('rejects persisted third and same-conversation overlapping reservations', async () => {
  const thirdPath = await directory();
  await initialize(thirdPath);
  await mutateDatabase(thirdPath, db => {
    db.exec('BEGIN IMMEDIATE');
    insertAdmission(db, randomUUID(), 1, 'conversation-a', 0, 'pending');
    insertAdmission(db, randomUUID(), 2, 'conversation-b', 0, 'pending');
    insertAdmission(db, randomUUID(), 3, 'conversation-c', 0, 'pending');
    db.prepare('UPDATE metadata SET cumulative_starts = 3, last_admission = 0 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  await expect(openReleaseAccounting(thirdPath, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');

  const overlapPath = await directory();
  await initialize(overlapPath);
  await mutateDatabase(overlapPath, db => {
    db.exec('BEGIN IMMEDIATE');
    insertAdmission(db, randomUUID(), 1, 'conversation-a', 0, 'pending');
    insertAdmission(db, randomUUID(), 2, 'conversation-a', 0, 'pending');
    db.prepare('UPDATE metadata SET cumulative_starts = 2, last_admission = 0 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  await expect(openReleaseAccounting(overlapPath, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('rejects a persisted thirteenth start inside one rolling hour', async () => {
  const path = await directory();
  await initialize(path);
  await mutateDatabase(path, db => {
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 13; index++) insertAdmission(db, randomUUID(), index + 1, 'conversation-a', index, 'settled');
    db.prepare('UPDATE metadata SET cumulative_starts = 13, known_tokens = 156, last_admission = 12 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  await expect(openReleaseAccounting(path, () => 12)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('fails closed on an altered SQLite schema without rewriting the original evidence', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  await owner.forConversation('conversation-a').reserve();
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => db.exec('PRAGMA user_version = 99'));
  await expect(openReleaseAccounting(path, () => now)).rejects.toThrow();
  expect((await stat(join(path, DB_NAME))).size).toBeGreaterThan(0);
});

it('rejects conflicting owners without unlinking the existing owner lock', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  await expect(openReleaseAccounting(path, () => now)).rejects.toThrow();
  await owner.close();
  const reopened = await open(path, () => now);
  expect(reopened.snapshot().starts).toBe(0);
});

it('rejects invalid clocks and regressions that would reopen an old admission window', async () => {
  await expect(openReleaseAccounting(await directory(), () => -1)).rejects.toThrow();
  await expect(openReleaseAccounting(await directory(), () => 0.5)).rejects.toThrow();
  await expect(openReleaseAccounting(await directory(), () => Number.NaN)).rejects.toThrow();
  await expect(openReleaseAccounting(await directory(), () => Number.POSITIVE_INFINITY)).rejects.toThrow();

  let now = 10;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  const id = await view.reserve();
  await view.settle(id!, usage);
  now = 9;
  await expect(view.reserve()).rejects.toThrow();
  await owner.close();
  await expect(openReleaseAccounting(path, () => now)).rejects.toThrow();

  let reopenedClock = 100;
  const secondPath = await directory();
  const secondOwner = await open(secondPath, () => reopenedClock);
  const secondView = secondOwner.forConversation('conversation-a');
  const secondId = await secondView.reserve();
  await secondView.settle(secondId!, usage);
  reopenedClock = 0;
  await expect(secondView.reserve()).rejects.toThrow();
});

it('fails closed before metadata counters can overflow', async () => {
  const startsPath = await directory();
  await initialize(startsPath);
  await mutateDatabase(startsPath, db => db.prepare('UPDATE metadata SET cumulative_starts = ?, last_admission = 0 WHERE id = 1').run(Number.MAX_SAFE_INTEGER));
  const startsOwner = await open(startsPath, () => 0);
  expect(await startsOwner.forConversation('conversation-a').reserve()).toBeNull();
  await startsOwner.close();
  owners.pop();

  const tokensPath = await directory();
  await initialize(tokensPath);
  await mutateDatabase(tokensPath, db => db.prepare('UPDATE metadata SET known_tokens = ? WHERE id = 1').run(Number.MAX_SAFE_INTEGER - 1));
  const tokensOwner = await open(tokensPath, () => 0);
  expect(await tokensOwner.forConversation('conversation-a').reserve()).toBeNull();
});

it('grows durably through a synthetic twenty-five-hour task without remote inference', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  for (let hour = 0; hour < 25; hour++) {
    now = hour * 3_600_000;
    const id = await view.reserve();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await view.settle(id!, usage);
  }
  const bytes = (await stat(join(path, DB_NAME))).size;
  expect(bytes).toBeGreaterThan(0);
  expect(owner.snapshot()).toEqual(expect.objectContaining({starts: 25, knownTokens: 300, unresolved: 0, unknown: 0}));
});

it('drains queued settlement on view close while leaving the owner and another view usable', async () => {
  let now = 0;
  const owner = await open(await directory(), () => now);
  const first = owner.forConversation('conversation-a');
  const second = owner.forConversation('conversation-b');
  const firstId = await first.reserve();
  const settlement = first.settle(firstId!, usage);
  await first.close();
  await settlement;
  const secondId = await second.reserve();
  expect(secondId).toMatch(/^[0-9a-f-]{36}$/);
  await second.settle(secondId!, usage);
  expect(await owner.forConversation('conversation-a').reserve()).toMatch(/^[0-9a-f-]{36}$/);
});

it('drains queued reservations before owner and view close take effect', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  const first = view.reserve();
  const second = view.reserve();
  const ownerClosing = owner.close();
  expect(await first).toMatch(/^[0-9a-f-]{36}$/);
  expect(await second).toBeNull();
  await ownerClosing;

  const secondPath = await directory();
  const reopened = await open(secondPath, () => now);
  const reopenedView = reopened.forConversation('conversation-b');
  const queued = reopenedView.reserve();
  const viewClosing = reopenedView.close();
  expect(await queued).toMatch(/^[0-9a-f-]{36}$/);
  await viewClosing;
  expect(await reopenedView.reserve()).toBeNull();
});
