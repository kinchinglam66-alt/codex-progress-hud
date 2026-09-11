import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {openReleaseAccounting, type ReleaseAccountingOwner, type ReleaseRecoveryAdmission, type ReleaseRecoveryEvent} from '../../src/estimation/release-accounting.js';

type AutomaticOwner = ReleaseAccountingOwner & {
  reconcileAutomatic(): Promise<{released: number; nextCheckAt: number | null}>;
  recoveryAdmission(now: number, eligibleTask: boolean, conversationKey?: string): Promise<ReleaseRecoveryAdmission>;
  recordRecoveryEvent(event: ReleaseRecoveryEvent): Promise<void>;
};

const directories: string[] = [];
const owners: ReleaseAccountingOwner[] = [];

it('checks bound process identity before releasing or terminating a recovered call', async()=>{
  const path=await mkdtemp(join(tmpdir(),'hud-process-recovery-'));directories.push(path);
  let now=0;
  const first=await open(path,()=>now),view=first.forConversation('owned');
  const id=(await view.reserve())!;
  await view.bindInvocation!(id,{admissionId:id,conversationKey:'owned',turnGeneration:7,ownerUuid:randomUUID(),providerKind:'subscription',phase:'dispatching',deadline:60_000,pid:123,creationIdentity:'456',cleanupOutcome:'pending'});
  await first.close();owners.pop();
  let closed=false,inspectionFailed=false;const inspections:boolean[]=[];
  now=10_000;
  const owner=await openReleaseAccounting(path,()=>now,async(record,terminate)=>{
    expect(record).toMatchObject({pid:123,creationIdentity:'456',turnGeneration:7});inspections.push(terminate);
    return closed?'closed':inspectionFailed?'unconfirmed':'live';
  });owners.push(owner);
  expect(inspections).toEqual([false]);
  now=300_000;await owner.reconcileAutomatic!();
  expect(inspections.at(-1)).toBe(true);
  expect(owner.snapshot().inFlight).toBe(1);
  inspectionFailed=true;now=600_000;await owner.reconcileAutomatic!();
  expect(owner.snapshot()).toMatchObject({inFlight:1,unknown:0});
  closed=true;await owner.reconcileAutomatic!();
  expect(owner.snapshot()).toMatchObject({inFlight:0,unknown:1});
  expect(await owner.forConversation('owned').reserve('retry')).not.toBeNull();
});

async function open(path: string, now: () => number): Promise<AutomaticOwner> {
  const owner = await openReleaseAccounting(path, now);
  owners.push(owner);
  return owner as AutomaticOwner;
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true});
});

it('admits distinct conversations concurrently while retaining one active claim per conversation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'hud-automatic-recovery-'));
  directories.push(path);
  const owner = await open(path, () => 0);
  const reservations = await Promise.all(['a', 'b', 'c'].map(key => owner.forConversation(key).reserve()));

  expect(reservations.filter(Boolean)).toHaveLength(3);
  expect(await owner.forConversation('a').reserve()).toBeNull();
});

it('automatically releases a reopened legacy call at the grace threshold and is idempotent', async () => {
  const path = await mkdtemp(join(tmpdir(), 'hud-automatic-recovery-'));
  directories.push(path);
  let now = 0;
  let owner = await open(path, () => now);
  expect(await owner.forConversation('legacy').reserve()).toMatch(/^[0-9a-f-]{36}$/);
  await owner.close();
  owners.pop();

  now = 299_999;
  owner = await open(path, () => now);
  expect(owner.snapshot()).toMatchObject({starts: 1, inFlight: 1, unknown: 0});
  await expect(owner.reconcileAutomatic()).resolves.toMatchObject({released: 0});
  expect(owner.snapshot()).toMatchObject({inFlight: 1, unknown: 0});

  now = 300_000;
  await expect(owner.reconcileAutomatic()).resolves.toMatchObject({released: 1, nextCheckAt: null});
  expect(owner.snapshot()).toMatchObject({starts: 1, inFlight: 0, unresolved: 0, unknown: 1});
  await expect(owner.reconcileAutomatic()).resolves.toMatchObject({released: 0});
});

it('persists per-conversation retry backoff without delaying an unrelated conversation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'hud-automatic-recovery-'));
  directories.push(path);
  let now = 0;
  let owner = await open(path, () => now);
  await owner.recordRecoveryEvent({kind: 'recoverable_failure', at: now, conversationKey: 'a'});

  expect(await owner.recoveryAdmission(now, true, 'a')).toMatchObject({allowed: false, reason: 'retry_backoff', nextEligibleAt: 60_000});
  expect(await owner.recoveryAdmission(now, true, 'b')).toMatchObject({allowed: true});
  await owner.close();
  owners.pop();

  now = 30_000;
  owner = await open(path, () => now);
  expect(await owner.recoveryAdmission(now, true, 'a')).toMatchObject({allowed: false, nextEligibleAt: 60_000});
  now = 60_000;
  expect(await owner.recoveryAdmission(now, true, 'a')).toMatchObject({allowed: true, kind: 'retry'});
});

it('creates one persisted retry claim after legacy release and consumes it idempotently', async () => {
  const path = await mkdtemp(join(tmpdir(), 'hud-automatic-recovery-'));
  directories.push(path);
  let now = 0;
  let owner = await open(path, () => now);
  const first = await owner.forConversation('claim').reserve();
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  await owner.close();
  owners.pop();

  now = 300_000;
  owner = await open(path, () => now);
  expect(owner.snapshot()).toMatchObject({unknown: 1, inFlight: 0});
  await expect(owner.reconcileAutomatic()).resolves.toMatchObject({released: 0});
  const admission = await owner.recoveryAdmission(now, true, 'claim');
  expect(admission).toMatchObject({allowed: true, kind: 'retry'});

  const [claimed, duplicate] = await Promise.all([
    owner.forConversation('claim').reserve('retry'),
    owner.forConversation('claim').reserve('retry'),
  ]);
  expect([claimed, duplicate].filter(Boolean)).toHaveLength(1);
  await owner.close();
  owners.pop();
  now = 300_001;
  owner = await open(path, () => now);
  expect(await owner.recoveryAdmission(now, true, 'claim')).toMatchObject({allowed: false, reason: 'unresolved_previous_call'});
  await owner.close();
  owners.pop();
  now = 600_000;
  owner = await open(path, () => now);
  expect(owner.snapshot()).toMatchObject({unknown: 2, inFlight: 0});
  expect(await owner.recoveryAdmission(now,true,'claim')).toMatchObject({allowed:false,nextEligibleAt:660_000});
  now=660_000;
  expect(await owner.recoveryAdmission(now, true, 'claim')).toMatchObject({allowed: true, kind: 'retry'});
  const next = await owner.forConversation('claim').reserve('retry');
  await owner.forConversation('claim').cancelBeforeDispatch(next!);
});

it('uses a monotonic five-minute grace after clock rollback',async()=>{
  const path=await mkdtemp(join(tmpdir(),'hud-clock-recovery-'));directories.push(path);
  const first=await open(path,()=>900_000);await first.forConversation('future').reserve();await first.close();owners.pop();
  let mono=0;
  const owner=await openReleaseAccounting(path,()=>100_000,undefined,()=>mono);owners.push(owner);
  mono=299_999;expect((await owner.reconcileAutomatic!()).released).toBe(0);
  mono=300_000;expect((await owner.reconcileAutomatic!()).released).toBe(1);
  expect(owner.snapshot()).toMatchObject({unknown:1,inFlight:0});
});
