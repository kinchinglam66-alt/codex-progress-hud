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
it('retains confirmed cancellation unknowns across reopen without causing account cooldown',async()=>{
 const path=await directory();let owner=await open(path,()=>1000);
 for(let n=0;n<3;n++){
  const view=owner.forConversation(`cancel-${n}`);
  await view.settle((await view.reserve())!,null,'confirmed_cancelled_unknown');
 }
 expect(owner.snapshot()).toMatchObject({starts:3,unknown:3,knownTokens:0,inFlight:0});
 await owner.close();owner=await open(path,()=>1000);
 expect(owner.snapshot()).toMatchObject({unknown:3,knownTokens:0});
 expect(await owner.recoveryAdmission(1000,true,'other')).toMatchObject({allowed:true});
 const view=owner.forConversation('compression');
 await expect(view.settle((await view.reserve('ordinary','context_compression'))!,null,'confirmed_cancelled_unknown')).rejects.toThrow('RELEASE_USAGE_INVALID');
 const eta=owner.forConversation('eta');
 await expect(eta.settle((await eta.reserve())!,usage,'confirmed_cancelled_unknown')).rejects.toThrow('RELEASE_USAGE_INVALID');
});
it('preserves successful ETA compaction unknowns across reopen without counting them as failures',async()=>{
 const path=await directory();let owner=await open(path,()=>1000);
 for(let i=0;i<4;i++){
  const view=owner.forConversation(`eta-${i}`),id=(await view.reserve())!;
  await view.settle(id,null,'confirmed_eta_compaction_unknown');
 }
 expect(owner.snapshot()).toMatchObject({starts:4,unknown:4,knownTokens:0,inFlight:0});
 expect(await owner.recoveryAdmission(1000,true,'next')).toMatchObject({allowed:true});
 await owner.close();owner=await open(path,()=>1000);
 expect(owner.snapshot()).toMatchObject({unknown:4,knownTokens:0});
 expect(await owner.recoveryAdmission(1000,true,'next')).toMatchObject({allowed:true});
 for(let i=0;i<3;i++){
  const view=owner.forConversation(`failed-${i}`),id=(await view.reserve())!;
  await view.settle(id,null,'safe_unknown');
 }
 expect(await owner.recoveryAdmission(1000,true,'next')).toMatchObject({allowed:false,reason:'cooldown'});
 expect(owner.snapshot().unknown).toBe(7);
});
it('rejects ETA compaction classifications for compression purposes or known usage',async()=>{
 const owner=await open(await directory(),()=>1000),view=owner.forConversation('one');
 const compression=(await view.reserve('ordinary','context_compression'))!;
 await expect(view.settle(compression,null,'confirmed_eta_compaction_unknown')).rejects.toThrow('RELEASE_USAGE_INVALID');
 const etaView=owner.forConversation('eta'),eta=(await etaView.reserve())!;
 expect(eta).not.toBeNull();
 await expect(etaView.settle(eta,usage,'confirmed_eta_compaction_unknown')).rejects.toThrow('RELEASE_USAGE_INVALID');
 expect(owner.snapshot()).toMatchObject({unknown:0,inFlight:2});
});
it('keeps unadmitted unknown work across restart and resumes only after matching process exit',async()=>{
 const path=await directory();let exited=false;
 const incident={ownerUuid:randomUUID(),conversationKey:'source',generation:0,at:1000,pid:123,creationIdentity:'birth',reason:'turn/started' as const};
 let owner=await openReleaseAccounting(path,()=>1000,undefined,undefined,undefined,async()=>exited);owners.push(owner);
 await owner.recordUnexpectedOperation(incident);await owner.recordUnexpectedOperation(incident);
 expect(owner.snapshot()).toMatchObject({starts:0,unknown:1,unresolved:1});
 expect(owner.recoveryStatus()).toMatchObject({state:'warning',unknown:1,recoveryAllowed:false});
 expect(await owner.recoveryAdmission(1000,true,'other')).toMatchObject({allowed:false,reason:'unresolved_previous_call'});
 expect(await owner.forConversation('other').reserve()).toBeNull();
 await owner.close();
 owner=await openReleaseAccounting(path,()=>1000,undefined,undefined,undefined,async()=>exited);owners.push(owner);
 expect(owner.snapshot()).toMatchObject({starts:0,unknown:1,unresolved:1});
 await expect(owner.confirmUnexpectedExit(incident)).rejects.toThrow();
 exited=true;await owner.reconcileAutomatic!();
 expect(owner.snapshot()).toMatchObject({starts:0,unknown:1,unresolved:0});
 const view=owner.forConversation('other'),id=await view.reserve();expect(id).not.toBeNull();await view.cancelBeforeDispatch(id!);
});
it('finishes half-open recovery after an accepted ETA compaction while preserving unknown history',async()=>{
 let now=0;const owner=await open(await directory(),()=>now);
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 now=300000;const admission=await owner.recoveryAdmission(now,true,'trial');
 expect(admission).toMatchObject({allowed:true,kind:'half_open'});
 const view=owner.forConversation('trial'),id=(await view.reserve(admission.kind))!;
 await view.settle(id,null,'confirmed_eta_compaction_unknown');await owner.releaseRecoveryAdmission('trial');
 expect(owner.snapshot()).toMatchObject({unknown:4,knownTokens:0});
 expect(await owner.recoveryAdmission(now,true,'next')).toMatchObject({allowed:true,kind:'ordinary'});
});
it.each(['purpose','state'])('rejects forged ETA compaction %s on reopen',async(field)=>{
 const path=await directory(),owner=await open(path,()=>1000),view=owner.forConversation('eta');
 const id=(await view.reserve())!;await view.settle(id,null,'confirmed_eta_compaction_unknown');await owner.close();
 await mutateDatabase(path,db=>{if(field==='purpose')db.prepare("UPDATE admissions SET purpose='context_compression' WHERE id=?").run(id);
 else db.prepare("UPDATE admissions SET state='settled',input_tokens=1,output_tokens=0,cached_input_tokens=0 WHERE id=?").run(id);});
 await expect(open(path,()=>1000)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});
it.each(['confirmed_eta_compaction_unknown','confirmed_cancelled_unknown','known_cancelled','known_success','known_non_success','safe_unknown'] as const)('does not let another conversation change an active half-open trial: %s',async classification=>{
 let now=0;const owner=await open(await directory(),()=>now);
 const old=owner.forConversation('other'),oldId=(await old.reserve())!;
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 now=300000;const admission=await owner.recoveryAdmission(now,true,'trial');
 expect(admission).toMatchObject({allowed:true,kind:'half_open'});
 const trial=owner.forConversation('trial'),trialId=(await trial.reserve(admission.kind))!;
 await old.settle(oldId,classification.startsWith('known_')?usage:null,classification);
 expect(await owner.recoveryAdmission(now,true,'next')).toMatchObject({allowed:false,reason:'half_open_busy'});
 await trial.settle(trialId,null,'confirmed_eta_compaction_unknown');
 expect(await owner.recoveryAdmission(now,true,'next')).toMatchObject({allowed:true,kind:'ordinary'});
});
it.each([false,true])('releases its confirmed cancelled half-open trial without falsely declaring recovery successful (known=%s)',async known=>{
 let now=0;const owner=await open(await directory(),()=>now);
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 now=300000;const admission=await owner.recoveryAdmission(now,true,'trial');
 expect(admission).toMatchObject({allowed:true,kind:'half_open'});
 const trial=owner.forConversation('trial'),id=(await trial.reserve(admission.kind))!;
 await trial.settle(id,known?usage:null,known?'known_cancelled':'confirmed_cancelled_unknown');
 expect(owner.snapshot()).toMatchObject({unknown:known?3:4,knownTokens:known?12:0});
 expect(await owner.recoveryAdmission(now,true,'next')).toMatchObject({allowed:true,kind:'half_open'});
});
it('clears an owned expired retry after successful ETA compaction in half-open recovery',async()=>{
 let now=0;const owner=await open(await directory(),()=>now);
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 await owner.recordRecoveryEvent!({kind:'recoverable_failure',at:now,conversationKey:'trial'});
 now=300000;const admission=await owner.recoveryAdmission(now,true,'trial');
 expect(admission).toMatchObject({allowed:true,kind:'half_open'});
 const trial=owner.forConversation('trial'),id=(await trial.reserve(admission.kind))!;
 await trial.settle(id,null,'confirmed_eta_compaction_unknown');
 expect(await owner.recoveryAdmission(now,true,'trial')).toMatchObject({allowed:true,kind:'ordinary'});
 expect(owner.snapshot()).toMatchObject({unknown:4,knownTokens:0});
});
it('reserves the granted half-open compression when that conversation also has an expired retry',async()=>{
 let now=0;const owner=await open(await directory(),()=>now);
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 await owner.recordRecoveryEvent!({kind:'recoverable_failure',at:now,conversationKey:'current'});
 now=300_000;
 const admission=await owner.recoveryAdmission!(now,true,'current');
 expect(admission).toMatchObject({allowed:true,kind:'half_open'});
 const view=owner.forConversation('current'),id=await view.reserve(admission.kind,'context_compression');
 expect(id).not.toBeNull();
 expect((await owner.recoveryAdmission!(now,true,'other')).allowed).toBe(false);
 await view.cancelBeforeDispatch(id!);
 await owner.releaseRecoveryAdmission!('current');
 const next=await owner.recoveryAdmission!(now,true,'current');
 expect(next).toMatchObject({allowed:true,kind:'half_open'});
 const nextId=await view.reserve(next.kind,'context_compression');
 expect(nextId).not.toBeNull();
 await view.cancelBeforeDispatch(nextId!);
});
it('does not let half-open reservation bypass an unexpired conversation retry',async()=>{
 let now=0;const owner=await open(await directory(),()=>now);
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 now=290_000;await owner.recordRecoveryEvent!({kind:'recoverable_failure',at:now,conversationKey:'current'});
 now=300_000;
 expect(await owner.recoveryAdmission!(now,true,'current')).toMatchObject({allowed:false,reason:'retry_backoff'});
 expect(await owner.forConversation('current').reserve('half_open','context_compression')).toBeNull();
});
it('releases a half-open retry claim when reboot evidence reconciles its pending admission',async()=>{
 let now=0;const path=await directory();let owner=await open(path,()=>now);
 for(const key of ['a','b','c']){const view=owner.forConversation(key);await view.settle((await view.reserve())!,null,'safe_unknown');}
 await owner.recordRecoveryEvent!({kind:'recoverable_failure',at:now,conversationKey:'current'});
 now=300_000;
 const admission=await owner.recoveryAdmission!(now,true,'current');
 expect(await owner.forConversation('current').reserve(admission.kind,'context_compression')).not.toBeNull();
 await owner.close();now=320_000;owner=await open(path,()=>now);
 expect(await owner.reconcileRecoveredPending({source:'windows-win32-operating-system',bootAt:310_001,observedAt:now})).toBe(1);
 now=500_000;
 const next=await owner.recoveryAdmission!(now,true,'current');
 expect(next.allowed).toBe(true);
 const view=owner.forConversation('current'),id=await view.reserve(next.kind,'context_compression');
 expect(id).not.toBeNull();await view.cancelBeforeDispatch(id!);
});
it('rejects a settled token-bearing row forged as confirmed compression unknown on reopen',async()=>{
 const path=await directory(),owner=await open(path,()=>0),view=owner.forConversation('compression');
 const id=(await view.reserve('ordinary','context_compression'))!;
 await view.settle(id,usage,'known_success');await owner.close();
 await mutateDatabase(path,db=>{db.prepare("UPDATE admissions SET settlement_classification='confirmed_compression_unknown' WHERE id=?").run(id);});
 await expect(open(path,()=>0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});
it('persists not-dispatched separately, releases concurrency and retains hourly starts',async()=>{
  const path=await directory(),owner=await open(path,()=>0),view=owner.forConversation('one');
  const id=(await view.reserve())!;await view.cancelBeforeDispatch(id);
  expect(owner.snapshot()).toMatchObject({starts:1,inFlight:0,unknown:0,knownTokens:0,activeStarts:1});
  await expect(view.cancelBeforeDispatch(id)).rejects.toThrow();await owner.close();
  await mutateDatabase(path,db=>{expect(db.prepare('SELECT state FROM admissions WHERE id=?').get(id)).toMatchObject({state:'not_dispatched'});});
  const restored=await open(path,()=>0);expect(restored.snapshot()).toMatchObject({starts:1,inFlight:0,unknown:0,knownTokens:0});
  const next=restored.forConversation('one');
  for(let i=1;i<12;i++)await next.cancelBeforeDispatch((await next.reserve())!);
  const thirteenth=await next.reserve();expect(thirteenth).not.toBeNull();
  await next.cancelBeforeDispatch(thirteenth!);
});
it('propagates compression purpose through threaded reserve and persists legacy eta defaults',async()=>{
  const path=await directory(),owner=await open(path,()=>0),compression=owner.forConversation('compression');
  const compressionId=(await compression.reserve('ordinary','context_compression'))!;
  await compression.cancelBeforeDispatch(compressionId);
  const legacy=owner.forConversation('legacy'),legacyId=(await legacy.reserve())!;
  await legacy.cancelBeforeDispatch(legacyId);
  await owner.close();
  await mutateDatabase(path,db=>{
    expect(db.prepare('SELECT purpose FROM admissions WHERE id=?').get(compressionId)).toEqual({purpose:'context_compression'});
    expect(db.prepare('SELECT purpose FROM admissions WHERE id=?').get(legacyId)).toEqual({purpose:'eta'});
  });
  const reopened=await open(path,()=>0);
  expect(reopened.snapshot()).toMatchObject({starts:2,unknown:0});
  await reopened.close();
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
  if(state==='pending') { const peer = await owner.forConversation('two').reserve(); expect(peer).not.toBeNull(); await owner.forConversation('two').cancelBeforeDispatch(peer!); }
  if(state==='unknown') { expect(await owner.forConversation('two').reserve()).not.toBeNull(); expect(owner.recoveryStatus()).toMatchObject({state:'warning'}); }
  if(state==='pending')await expect(owner.forConversation('one').cancelBeforeDispatch(id)).rejects.toThrow();
  await owner.close();
  await mutateDatabase(path,db=>{
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:5});
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

it('admits distinct conversations without a global cap while denying a duplicate active conversation', async () => {
  let now = 0;
  const owner = await open(await directory(), () => now);
  const first = owner.forConversation('conversation-a');
  const second = owner.forConversation('conversation-b');
  const third = owner.forConversation('conversation-c');

  const [firstId, secondId, thirdId] = await Promise.all([first.reserve(), second.reserve(), third.reserve()]);
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  expect(secondId).toMatch(/^[0-9a-f-]{36}$/);
  expect(thirdId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await first.reserve()).toBeNull();
  await first.settle(firstId!, usage);
  await second.settle(secondId!, usage);
  await third.settle(thirdId!, usage);
});

it('keeps call counts across reopen without imposing a twelve-call quota', async () => {
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
  const extra=await reopened.forConversation('conversation-a').reserve();
  expect(extra).not.toBeNull();
  await reopened.forConversation('conversation-a').settle(extra!,usage);
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

it('treats null settlement as unknown while allowing bounded future admission', async () => {
  let now = 0;
  const path = await directory();
  const owner = await open(path, () => now);
  const view = owner.forConversation('conversation-a');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  await owner.close();
  const reopened = await open(path, () => now);
  const next = await reopened.forConversation('conversation-a').reserve();
  expect(next).toMatch(/^[0-9a-f-]{36}$/);
  await reopened.forConversation('conversation-a').cancelBeforeDispatch(next!);
  expect(reopened.snapshot()).toEqual(expect.objectContaining({unknown: 1}));
});

it('requires confirmed compression unknown to use a compression admission', async () => {
  const owner = await open(await directory(), () => 0);
  const eta = owner.forConversation('eta');
  const etaId = (await eta.reserve())!;
  await expect(eta.settle(etaId, null, 'confirmed_compression_unknown')).rejects.toThrow('RELEASE_USAGE_INVALID');
  expect(owner.snapshot()).toMatchObject({starts: 1, inFlight: 1, unknown: 0, knownTokens: 0});
  const compression = owner.forConversation('compression');
  const compressionId = (await compression.reserve('ordinary', 'context_compression'))!;
  await expect(compression.settle(compressionId, usage, 'confirmed_compression_unknown')).rejects.toThrow('RELEASE_USAGE_INVALID');
  expect(owner.snapshot()).toMatchObject({starts: 2, inFlight: 2, unknown: 0, knownTokens: 0});
});

it('rejects a forged confirmed compression unknown with ETA purpose on reopen', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('compression');
  const id = (await view.reserve('ordinary', 'context_compression'))!;
  await view.settle(id, null, 'confirmed_compression_unknown');
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => db.prepare("UPDATE admissions SET purpose = 'eta' WHERE id = ?").run(id));
  await expect(open(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
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

it('rejects a corrupted unsafe unknown ceiling even with the later row absent', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('unknown');
  await view.settle((await view.reserve())!, null, 'unsafe_unknown');
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
  await a.settle(first!, null, 'safe_unknown');
  await b.settle(second!, usage);
  await owner.close();
  const recovered = await open(path, () => now);
  expect(recovered.snapshot()).toMatchObject({starts: 2, knownTokens: 12, unknown: 1, unresolved: 0});
  const later = await recovered.forConversation('later').reserve();
  expect(later).toMatch(/^[0-9a-f-]{36}$/);
  await recovered.forConversation('later').cancelBeforeDispatch(later!);
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
  await unknownView.settle(unknownId!, null, 'safe_unknown');
  await owner.close();
  owners.pop();

  const reopened = await open(path, () => now);
  expect(reopened.snapshot()).toEqual(expect.objectContaining({starts: 2, knownTokens: 12, unknown: 1, unresolved: 0, inFlight: 0}));
  const later = await reopened.forConversation('conversation-later').reserve();
  expect(later).toMatch(/^[0-9a-f-]{36}$/);
  await reopened.forConversation('conversation-later').cancelBeforeDispatch(later!);
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
  await unknownView.settle(unknownId!, null, 'safe_unknown');
  await owner.close();
  owners.pop();

  const reopened = await open(path, () => now);
  expect(await reopened.forConversation('conversation-later').reserve()).not.toBeNull();
  await reopened.forConversation('conversation-pending').settle(pendingId!, usage);
  expect(reopened.snapshot()).toEqual(expect.objectContaining({starts: 3, knownTokens: 12, unknown: 1, unresolved: 1, inFlight: 1}));
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

it('allows a validated safe unknown alongside a later persisted settlement', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const id = await owner.forConversation('conversation-a').reserve();
  await owner.forConversation('conversation-a').settle(id!, null, 'safe_unknown');
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => {
    db.exec('BEGIN IMMEDIATE');
    insertAdmission(db, randomUUID(), 2, 'conversation-a', 1, 'settled');
    db.prepare('UPDATE metadata SET cumulative_starts = 2, known_tokens = 12, last_admission = 1 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  const reopened = await open(path, () => 1);
  expect(reopened.snapshot()).toMatchObject({starts: 2, knownTokens: 12, unknown: 1});
});

it('retains persisted occupancy and denies same-conversation overlapping reservations', async () => {
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
  const thirdOwner = await openReleaseAccounting(thirdPath, () => 0);
  expect(thirdOwner.snapshot()).toMatchObject({inFlight: 3});
  await thirdOwner.close();

  const overlapPath = await directory();
  await initialize(overlapPath);
  await mutateDatabase(overlapPath, db => {
    db.exec('BEGIN IMMEDIATE');
    insertAdmission(db, randomUUID(), 1, 'conversation-a', 0, 'pending');
    insertAdmission(db, randomUUID(), 2, 'conversation-a', 0, 'pending');
    db.prepare('UPDATE metadata SET cumulative_starts = 2, last_admission = 0 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  const overlapOwner = await openReleaseAccounting(overlapPath, () => 0);
  expect(await overlapOwner.forConversation('conversation-a').reserve()).toBeNull();
  await overlapOwner.close();
});

it('accepts valid persisted call counts beyond twelve inside one rolling hour', async () => {
  const path = await directory();
  await initialize(path);
  await mutateDatabase(path, db => {
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 13; index++) insertAdmission(db, randomUUID(), index + 1, 'conversation-a', index, 'settled');
    db.prepare('UPDATE metadata SET cumulative_starts = 13, known_tokens = 156, last_admission = 12 WHERE id = 1').run();
    db.exec('COMMIT');
  });
  const restored=await open(path,()=>12);
  expect(restored.snapshot()).toMatchObject({starts:13,knownTokens:156});
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

it('rejects invalid clocks and clamps rollback admission timestamps across reopen', async () => {
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
  const rollbackReservation = await view.reserve();
  expect(rollbackReservation).toMatch(/^[0-9a-f-]{36}$/);
  await view.cancelBeforeDispatch(rollbackReservation!);
  await owner.close();
  const rollbackOwner = await open(path, () => now);
  expect(await rollbackOwner.forConversation('conversation-a').reserve()).not.toBeNull();

  let reopenedClock = 100;
  const secondPath = await directory();
  const secondOwner = await open(secondPath, () => reopenedClock);
  const secondView = secondOwner.forConversation('conversation-a');
  const secondId = await secondView.reserve();
  await secondView.settle(secondId!, usage);
  reopenedClock = 0;
  const clampedId = await secondView.reserve();
  expect(clampedId).not.toBeNull();
  await secondView.cancelBeforeDispatch(clampedId!);
  await secondOwner.close();
  await mutateDatabase(secondPath, db => {
    expect(db.prepare('SELECT admitted_at FROM admissions WHERE id = ?').get(clampedId!)).toMatchObject({admitted_at:100});
  });
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
