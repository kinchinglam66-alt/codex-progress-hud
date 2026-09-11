import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {openReleaseAccounting, type ReleaseAccountingRecoveryOwner} from '../../src/estimation/release-accounting.js';

const DB_NAME = 'release-observer-accounting.sqlite';
const directories: string[] = [];
const owners: ReleaseAccountingRecoveryOwner[] = [];
const usage = {inputTokens: 8, outputTokens: 2, cachedInputTokens: 1};

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hud-release-recovery-'));
  directories.push(path);
  return path;
}

async function open(path: string, now: () => number): Promise<ReleaseAccountingRecoveryOwner> {
  const owner = await openReleaseAccounting(path, now);
  owners.push(owner);
  return owner;
}

async function mutateDatabase(path: string, mutation: (db: import('node:sqlite').DatabaseSync) => void): Promise<void> {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(join(path, DB_NAME));
  try { mutation(db); } finally { db.close(); }
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true});
});

it('keeps unknown history while allowing ordinary admission within the bounded allowance', async () => {
  const owner = await open(await directory(), () => 0);
  const view = owner.forConversation('fixture');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');

  expect(owner.snapshot().unknown).toBe(1);
  const ordinaryAfterRecovery = await view.reserve();
  expect(ordinaryAfterRecovery).toMatch(/^[0-9a-f-]{36}$/);
  await view.cancelBeforeDispatch(ordinaryAfterRecovery!);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', unknown: 1, recoveryAllowed: false});

  const preflight = await owner.preflightRecovery('account:route:assets');
  expect(preflight).toMatchObject({allowed: true, revision: 1});
  const confirmation = await owner.confirmRecovery({
    revision: preflight.revision,
    binding: 'account:route:assets'
  });
  const [firstTrial, secondTrial] = await Promise.all([
    owner.reserveRecoveryTrial(confirmation),
    owner.reserveRecoveryTrial(confirmation)
  ]);
  expect([firstTrial, secondTrial].filter(Boolean)).toHaveLength(1);
  expect(await view.reserve()).toBeNull();

  await owner.settleRecoveryTrial(confirmation.attemptId, firstTrial ?? secondTrial!, usage);
  await owner.finishRecovery(confirmation.attemptId, {success: true, closureConfirmed: true});

  expect(owner.snapshot().unknown).toBe(1);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', unknown: 1, recoveryAllowed: false});
  expect(await view.reserve()).toMatch(/^[0-9a-f-]{36}$/);
});

it('reports recovered pending history without globally blocking another conversation', async () => {
  const path = await directory();
  let owner = await open(path, () => 0);
  const first = owner.forConversation('fixture');
  await first.reserve();
  await owner.close();
  owners.pop();

  owner = await open(path, () => 1);
  expect(await owner.forConversation('other').reserve()).not.toBeNull();
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', reason: 'unresolved_previous_call'});
  expect(await owner.recoveryAdmission(1, true, 'other')).toMatchObject({allowed: false, reason: 'unresolved_previous_call'});
  expect(await owner.recoveryAdmission(1, true, 'independent')).toMatchObject({allowed:true});
});

it('reports generic unsafe unknown status without unresolved prior-call guidance', async () => {
  const owner = await open(await directory(), () => 0);
  const view = owner.forConversation('unsafe-current-call');
  const reservation = await view.reserve();
  await view.settle(reservation!, null, 'unsafe_unknown');

  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', reason: 'unsafe_unknown'});
  expect(await owner.recoveryAdmission(0, true, 'another-call')).toMatchObject({allowed: true, kind: 'ordinary'});
});

it('reconciles only previous-owner pending calls after a verified reboot and is idempotent', async () => {
  const path = await directory();
  let now = 0;
  let owner = await open(path, () => now);
  await owner.forConversation('old-call').reserve();
  await owner.close();
  owners.pop();

  now = 20_000;
  owner = await open(path, () => now);
  const proof = {source: 'windows-win32-operating-system' as const, bootAt: 10_001, observedAt: now};
  await expect(owner.reconcileRecoveredPending(proof)).resolves.toBe(1);
  expect(owner.snapshot()).toMatchObject({starts: 1, inFlight: 0, unresolved: 0, unknown: 1, knownTokens: 0});
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', recoveryAllowed: false});
  expect(await owner.forConversation('new-call').reserve()).not.toBeNull();
  await expect(owner.reconcileRecoveredPending(proof)).resolves.toBe(0);

  await owner.close();
  owners.pop();
  owner = await open(path, () => now);
  expect(owner.snapshot()).toMatchObject({starts: 2, inFlight: 1, unknown: 1});
});

it.each([
  ['same boot', {bootAt: 0, observedAt: 20_000}],
  ['future boot', {bootAt: 30_000, observedAt: 20_000}],
  ['stale observation', {bootAt: 10_001, observedAt: 0}],
] as const)('keeps recovered pending blocked for %s boot evidence', async (_label, values) => {
  const path = await directory();
  let owner = await open(path, () => 0);
  await owner.forConversation('old-call').reserve();
  await owner.close();
  owners.pop();
  owner = await open(path, () => 60_001);
  await expect(owner.reconcileRecoveredPending({source: 'windows-win32-operating-system', ...values})).rejects.toThrow('RELEASE_RECOVERY_INVALID');
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', reason: 'unresolved_previous_call'});
  expect(owner.snapshot()).toMatchObject({inFlight: 1, unknown: 0});
});

it('reconciles two recovered pending calls in one operation without granting a trial', async () => {
  const path = await directory();
  let owner = await open(path, () => 0);
  await owner.forConversation('old-one').reserve();
  await owner.forConversation('old-two').reserve();
  await owner.close();
  owners.pop();
  owner = await open(path, () => 20_000);

  await expect(owner.reconcileRecoveredPending({source: 'windows-win32-operating-system', bootAt: 10_001, observedAt: 20_000})).resolves.toBe(2);
  expect(owner.snapshot()).toMatchObject({starts: 2, inFlight: 0, unknown: 2, knownTokens: 0});
  expect(await owner.recoveryAdmission(20_000, true, 'new-call')).toMatchObject({allowed: true, kind: 'ordinary'});
  expect(await owner.forConversation('new-call').reserve()).not.toBeNull();
});

it('allows an ordinary estimate after reboot reconciliation and preserves unknown history after success', async () => {
  const path = await directory();
  let owner = await open(path, () => 0);
  await owner.forConversation('old-call').reserve();
  await owner.close();
  owners.pop();

  owner = await open(path, () => 20_000);
  await owner.reconcileRecoveredPending({source: 'windows-win32-operating-system', bootAt: 10_001, observedAt: 20_000});
  const ordinary = await owner.forConversation('new-call').reserve();
  expect(ordinary).toMatch(/^[0-9a-f-]{36}$/);
  await owner.forConversation('new-call').settle(ordinary!, usage);
  expect(owner.snapshot()).toMatchObject({starts:2,unknown:1,knownTokens:10,inFlight:0,unresolved:0});

  await owner.close();
  owners.pop();
  owner = await open(path, () => 20_000);
  expect(owner.snapshot()).toMatchObject({unknown: 1, knownTokens: 10});
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', recoveryAllowed: false});
});

it('never reconciles a current-owner pending call even with a future boot claim', async () => {
  let now = 0;
  const owner = await open(await directory(), () => now);
  await owner.forConversation('current-call').reserve();
  now = 20_000;
  await expect(owner.reconcileRecoveredPending({source: 'windows-win32-operating-system', bootAt: 10_001, observedAt: now})).resolves.toBe(0);
  expect(owner.snapshot()).toMatchObject({inFlight: 1, unknown: 0});
});

it('persists a five-minute cooldown after three rolling unknown-usage events', async () => {
  let now = 0;
  const owner = await open(await directory(), () => now);
  const views = ['one', 'two', 'three'].map(key => owner.forConversation(key));
  for (const view of views) { const reservation = await view.reserve(); await view.settle(reservation!, null, 'safe_unknown'); }
  expect(owner.recoveryStatus()).toMatchObject({state: 'cooldown', cooldownUntil: 300_000, nextEligibleAt: 300_000});
  now = 100_000;
  expect(owner.recoveryStatus()).toMatchObject({state: 'cooldown', cooldownUntil: 300_000});
  await owner.close(); owners.pop();
  const reopened = await open((directories[0])!, () => now);
  expect(reopened.recoveryStatus()).toMatchObject({state: 'cooldown', cooldownUntil: 300_000});
  expect(reopened.snapshot().unknown).toBe(3);
});

it('migrates an old recovery policy table before inserting the claim marker', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  await owner.close(); owners.pop();
  await mutateDatabase(path, db => {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE recovery_policy_old (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        failure_count INTEGER NOT NULL,
        next_eligible INTEGER,
        cooldown_until INTEGER,
        cooldown_level INTEGER NOT NULL,
        half_open INTEGER NOT NULL,
        half_open_conversation TEXT
      );
      INSERT INTO recovery_policy_old SELECT id, failure_count, next_eligible, cooldown_until, cooldown_level, half_open, half_open_conversation FROM recovery_policy;
      DROP TABLE recovery_policy;
      ALTER TABLE recovery_policy_old RENAME TO recovery_policy;
      COMMIT;`);
  });
  const reopened = await open(path, () => 0);
  expect(reopened.recoveryStatus()).toMatchObject({state: 'normal'});
});

it('rejects a forged future half-open claim ordinal before restart cleanup', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  await owner.close(); owners.pop();
  await mutateDatabase(path, db => db.prepare("UPDATE recovery_policy SET half_open = 1, half_open_conversation = 'forged', half_open_claim_after_ordinal = 1 WHERE id = 1").run());
  await expect(openReleaseAccounting(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('keeps a known-usage trial failure blocked and requires a new confirmation', async () => {
  const owner = await open(await directory(), () => 0);
  const view = owner.forConversation('failed-trial');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = await owner.reserveRecoveryTrial(confirmation);
  await owner.settleRecoveryTrial(confirmation.attemptId, trial!, usage);
  await expect(owner.finishRecovery(confirmation.attemptId, {success: true, closureConfirmed: false})).rejects.toThrow('RELEASE_RECOVERY_FAILED');
  expect(owner.recoveryStatus()).toMatchObject({state: 'failed', recoveryAllowed: false});
  expect(await view.reserve()).not.toBeNull();
  expect((await owner.preflightRecovery('account:route:assets')).allowed).toBe(false);
});

it('turns an unknown or cancelled trial into a durable failure without replaying it', async () => {
  const owner = await open(await directory(), () => 0);
  const view = owner.forConversation('cancelled-trial');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = await owner.reserveRecoveryTrial(confirmation);
  await owner.cancelRecoveryTrial(confirmation.attemptId, trial!);
  expect(owner.recoveryStatus()).toMatchObject({state: 'failed', recoveryAllowed: false});
  await expect(owner.cancelRecoveryTrial(confirmation.attemptId, trial!)).rejects.toThrow('RELEASE_RECOVERY_INVALID');
  await expect(owner.confirmRecovery({revision: 1, binding: 'account:route:assets'})).rejects.toThrow('RELEASE_RECOVERY_NOT_ALLOWED');
  expect(owner.snapshot().unknown).toBe(1);
  const ordinary = await view.reserve();
  expect(ordinary).toMatch(/^[0-9a-f-]{36}$/);
  await view.cancelBeforeDispatch(ordinary!);
});

it('marks an interrupted reserved trial unknown on reopen and never replays its call', async () => {
  const path = await directory();
  let owner = await open(path, () => 0);
  const view = owner.forConversation('interrupted-trial');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = await owner.reserveRecoveryTrial(confirmation);
  await owner.close();
  owners.pop();

  owner = await open(path, () => 0);
  expect(owner.snapshot().unknown).toBe(2);
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', recoveryAllowed: false});
  const later = await owner.forConversation('later').reserve();
  expect(later).not.toBeNull();
  expect(trial).toMatch(/^[0-9a-f-]{36}$/);
});

it('invalidates a successful recovery as soon as a new unknown result is recorded', async () => {
  const owner = await open(await directory(), () => 0);
  const first = owner.forConversation('new-unknown');
  const firstId = await first.reserve();
  await first.settle(firstId!, null, 'safe_unknown');
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = await owner.reserveRecoveryTrial(confirmation);
  await owner.settleRecoveryTrial(confirmation.attemptId, trial!, usage);
  await owner.finishRecovery(confirmation.attemptId, {success: true, closureConfirmed: true});
  const ordinary = await first.reserve();
  await first.settle(ordinary!, null, 'safe_unknown');
  expect(owner.recoveryStatus()).toMatchObject({state: 'warning', revision: 2, recoveryAllowed: false});
  const later = await first.reserve();
  expect(later).toMatch(/^[0-9a-f-]{36}$/);
  await first.cancelBeforeDispatch(later!);
});

it('rejects forged v4 coverage with no succeeded known-usage evidence', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('forged-coverage');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => db.prepare('UPDATE metadata SET recovery_covered_revision = recovery_revision WHERE id = 1').run());
  await expect(openReleaseAccounting(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('rejects contradictory v4 recovery attempt evidence on reopen', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('contradictory-evidence');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => {
    const attemptId = '33333333-3333-4333-8333-333333333333';
    db.prepare("INSERT INTO recovery_attempts (id, revision, binding, status, trial_reservation_id, usage_state, created_at, updated_at) VALUES (?, 1, 'account:route:assets', 'succeeded', ?, 'known', 0, 0)")
      .run(attemptId, '44444444-4444-4444-8444-444444444444');
    db.prepare("INSERT INTO recovery_events (id, attempt_id, sequence, revision, event, recorded_at) VALUES (?, ?, 1, 1, 'succeeded', 0)")
      .run('55555555-5555-4555-8555-555555555555', attemptId);
    db.prepare('UPDATE metadata SET recovery_covered_revision = 1 WHERE id = 1').run();
  });
  await expect(openReleaseAccounting(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it.each(['confirmed', 'reserved', 'known-settled', 'unknown-settled', 'known-failed', 'unknown-failed', 'succeeded'])(
  'reopens the durable %s boundary twice without replay or lost accounting', async boundary => {
    const path = await directory();
    let owner = await open(path, () => 0);
    const view = owner.forConversation('boundary');
    await view.settle((await view.reserve())!, null, 'safe_unknown');
    const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
    if (boundary !== 'confirmed') {
      const trial = (await owner.reserveRecoveryTrial(confirmation))!;
      if (boundary !== 'reserved') {
        await owner.settleRecoveryTrial(confirmation.attemptId, trial, boundary.startsWith('unknown') ? null : usage);
        if (boundary.endsWith('failed') || boundary === 'succeeded') {
          await owner.finishRecovery(confirmation.attemptId, {success: boundary === 'succeeded', closureConfirmed: true});
        }
      }
    }
    for (let iteration = 0; iteration < 2; iteration++) {
      await owner.close();
      owners.pop();
      owner = await open(path, () => 0);
      expect(owner.snapshot()).toMatchObject({
        starts: boundary === 'confirmed' ? 1 : 2,
        unknown: boundary === 'reserved' || boundary.startsWith('unknown') ? 2 : 1,
        knownTokens: boundary.startsWith('known') || boundary === 'succeeded' ? 10 : 0,
        inFlight: 0, unresolved: 0, poisoned: false
      });
      expect(owner.recoveryStatus().recoveryAllowed).toBe(false);
    }
    if (boundary === 'succeeded') expect(await owner.forConversation('resumed').reserve()).not.toBeNull();
  }
);

it.each(['settlement-revision', 'terminal-revision', 'usage-state', 'missing-reservation'])(
  'rejects tampered unknown-trial %s evidence', async corruption => {
    const path = await directory();
    const owner = await open(path, () => 0);
    const view = owner.forConversation('tampered');
    await view.settle((await view.reserve())!, null, 'safe_unknown');
    const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
    const trial = (await owner.reserveRecoveryTrial(confirmation))!;
    await owner.settleRecoveryTrial(confirmation.attemptId, trial, null);
    await owner.finishRecovery(confirmation.attemptId, {success: false, closureConfirmed: true});
    await owner.close();
    owners.pop();
    await mutateDatabase(path, db => {
      if (corruption === 'settlement-revision') db.prepare("UPDATE recovery_events SET revision = 1 WHERE event = 'trial_settled'").run();
      if (corruption === 'terminal-revision') db.prepare("UPDATE recovery_events SET revision = 1 WHERE event = 'failed'").run();
      if (corruption === 'usage-state') db.prepare("UPDATE recovery_attempts SET usage_state = 'known'").run();
      if (corruption === 'missing-reservation') db.prepare('UPDATE recovery_attempts SET trial_reservation_id = NULL').run();
    });
    await expect(openReleaseAccounting(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
  }
);

it('rejects recovery history borrowing an ordinary settled admission', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('ordinary');
  const ordinary = (await view.reserve())!;
  await view.settle(ordinary, usage);
  await view.settle((await view.reserve())!, null, 'safe_unknown');
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = (await owner.reserveRecoveryTrial(confirmation))!;
  await owner.settleRecoveryTrial(confirmation.attemptId, trial, usage);
  await owner.finishRecovery(confirmation.attemptId, {success: true, closureConfirmed: true});
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => db.prepare('UPDATE recovery_attempts SET trial_reservation_id = ?').run(ordinary));
  await expect(openReleaseAccounting(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('rejects swapped terminal trial IDs between failed and succeeded recovery attempts', async () => {
  const path = await directory();
  const owner = await open(path, () => 0);
  const view = owner.forConversation('swap');
  await view.settle((await view.reserve())!, null, 'safe_unknown');
  const attempts: Array<{attemptId: string; trial: string}> = [];
  for (const success of [false, true]) {
    // A new unknown event permits another optional diagnostic attempt; a failed
    // attempt alone does not grant a new manual confirmation.
    if (success) await view.settle((await view.reserve())!, null, 'safe_unknown');
    const confirmation = await owner.confirmRecovery({revision: owner.recoveryStatus().revision, binding: 'account:route:assets'});
    const trial = (await owner.reserveRecoveryTrial(confirmation))!;
    await owner.settleRecoveryTrial(confirmation.attemptId, trial, usage);
    await owner.finishRecovery(confirmation.attemptId, {success, closureConfirmed: true});
    attempts.push({attemptId: confirmation.attemptId, trial});
  }
  await owner.close();
  owners.pop();
  await mutateDatabase(path, db => {
    const update = db.prepare('UPDATE recovery_attempts SET trial_reservation_id = ? WHERE id = ?');
    update.run('55555555-5555-4555-8555-555555555555', attempts[0]!.attemptId);
    update.run(attempts[0]!.trial, attempts[1]!.attemptId);
    update.run(attempts[1]!.trial, attempts[0]!.attemptId);
  });
  await expect(open(path, () => 0)).rejects.toThrow('RELEASE_SCHEMA_INVALID');
});

it('retains recovery admission evidence when ordinary admission prunes hour-old rows', async () => {
  const path = await directory();
  let now = 0;
  const owner = await open(path, () => now);
  const view = owner.forConversation('pruning');
  await view.settle((await view.reserve())!, null, 'safe_unknown');
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = (await owner.reserveRecoveryTrial(confirmation))!;
  await owner.settleRecoveryTrial(confirmation.attemptId, trial, usage);
  await owner.finishRecovery(confirmation.attemptId, {success: true, closureConfirmed: true});
  now = 3_600_001;
  await view.settle((await view.reserve())!, usage);
  await owner.close();
  owners.pop();
  const reopened = await open(path, () => now);
  expect(reopened.recoveryStatus().state).toBe('recovered');
  expect(reopened.snapshot()).toMatchObject({knownTokens: 20, unknown: 1});
});

it('prevents ordinary callers from claiming the recovery-trial namespace', async () => {
  const owner = await open(await directory(), () => 0);
  expect(() => owner.forConversation('__recovery_trial__')).toThrow('RELEASE_CONVERSATION_KEY_INVALID');
});

it('migrates actual v3 CHECK constraints and permits recovery without losing history', async () => {
  const path = await directory();
  await mutateDatabase(path, db => db.exec(`
    CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=3), cumulative_starts INTEGER NOT NULL, known_tokens INTEGER NOT NULL, unknown_count INTEGER NOT NULL, unknown_admission_ceiling INTEGER, last_admission INTEGER);
    CREATE TABLE admissions(id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, conversation TEXT NOT NULL, admitted_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown','not_dispatched')), input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL);
    CREATE INDEX admissions_conversation_time ON admissions(conversation,admitted_at);
    CREATE INDEX admissions_state_time ON admissions(state,admitted_at);
    INSERT INTO metadata VALUES(1,3,1,0,1,1,0);
    INSERT INTO admissions VALUES('33333333-3333-4333-8333-333333333333',1,'legacy',0,'unknown',1000000000,1000000000,1000000000);
    PRAGMA user_version=3;
  `));
  const owner = await open(path, () => 0);
  expect(owner.snapshot()).toMatchObject({starts: 1, unknown: 1, knownTokens: 0});
  const confirmation = await owner.confirmRecovery({revision: 1, binding: 'account:route:assets'});
  const trial = (await owner.reserveRecoveryTrial(confirmation))!;
  await owner.settleRecoveryTrial(confirmation.attemptId, trial, usage);
  await owner.finishRecovery(confirmation.attemptId, {success: true, closureConfirmed: true});
  await owner.close();
  owners.pop();
  expect((await open(path, () => 0)).snapshot()).toMatchObject({starts: 2, unknown: 1, knownTokens: 10});
});

it('allows automatic recovery admission without a synthetic trial quota', async () => {
  const owner = await open(await directory(), () => 0);
  const view = owner.forConversation('recovery-rate-limit');
  const id = await view.reserve();
  await view.settle(id!, null, 'safe_unknown');
  expect(await owner.recoveryAdmission(0, true, 'next-conversation')).toMatchObject({allowed: true, kind: 'ordinary'});
  const next = await owner.forConversation('next-conversation').reserve();
  expect(next).toMatch(/^[0-9a-f-]{36}$/);
  await owner.forConversation('next-conversation').cancelBeforeDispatch(next!);
});
