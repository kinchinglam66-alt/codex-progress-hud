import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {createApiAccounting,type ApiAccounting} from '../../src/estimation/observer-api-accounting.js';

const paths:string[]=[],owners:ApiAccounting[]=[];
const binding={kind:'api' as const,profileId:'fixture',generation:1};
const limits={dailyCallLimit:100,maxInputTokens:20,maxOutputTokens:10};
const ownership=(key:string,now:number)=>({conversationKey:key,turnGeneration:7,ownerUuid:randomUUID(),providerKind:'api' as const,phase:'prepared' as const,deadline:now+60_000,cleanupOutcome:'pending' as const});
async function path(){const dir=await mkdtemp(join(tmpdir(),'hud-api-recovery-'));paths.push(dir);return join(dir,'api.sqlite');}
function open(file:string,now:()=>number){const value=createApiAccounting(file,now);owners.push(value);return value;}
afterEach(async()=>{for(const owner of owners.splice(0))await owner.close();vi.useRealTimers();for(const dir of paths.splice(0))await rm(dir,{recursive:true,force:true});});

it('atomically owns a conversation at reservation without a global parallel ceiling',async()=>{
  const owner=open(await path(),()=>0);
  const first=await owner.reserve(binding,limits,ownership('same',0));
  expect(first).not.toBeNull();
  expect(await owner.reserve(binding,limits,{...ownership('same',0),turnGeneration:8})).toBeNull();
  for(const key of ['b','c','d','e'])expect(await owner.reserve(binding,limits,ownership(key,0))).not.toBeNull();
  expect(owner.snapshot().unresolved).toBe(5);
});

it('recovers HTTP orphans and retains retry occupancy and backoff across restart',async()=>{
  const file=await path();let now=0;
  let owner=open(file,()=>now);
  const first=(await owner.reserve(binding,limits,ownership('same',now)))!;
  await owner.markDispatch(first.id);await owner.close();
  now=299_999;owner=open(file,()=>now);
  expect(await owner.reserve(binding,limits,ownership('same',now))).toBeNull();
  now=300_000;
  const retry=await owner.reserve(binding,limits,ownership('same',now));
  expect(retry).not.toBeNull();
  expect(owner.snapshot()).toMatchObject({unknown:1,unresolved:1,knownTokens:0});
  expect(owner.snapshot().rows.find(row=>row.id===first.id)?.invocation).toMatchObject({recoveryOutcome:'abandoned_unconfirmed',cleanupOutcome:'unconfirmed'});
  await owner.close();now=300_001;owner=open(file,()=>now);
  expect(await owner.reserve(binding,limits,ownership('same',now))).toBeNull();
  now=600_000;
  expect(await owner.reserve(binding,limits,ownership('same',now))).toBeNull();
  expect(owner.snapshot()).toMatchObject({unknown:2,unresolved:0});
  await owner.close();now=659_999;owner=open(file,()=>now);
  expect(await owner.reserve(binding,limits,ownership('same',now))).toBeNull();
  now=660_000;expect(await owner.reserve(binding,limits,ownership('same',now))).not.toBeNull();
});

it('does not release configured token budgets when orphan usage remains unknown',async()=>{
  const file=await path();let now=0;let owner=open(file,()=>now);
  await owner.reserve(binding,{...limits,dailyTokenCap:30});await owner.close();
  now=300_000;owner=open(file,()=>now);
  expect(await owner.reserve(binding,{...limits,dailyTokenCap:30},ownership('new',now))).toBeNull();
  expect(owner.snapshot()).toMatchObject({unknown:1,knownTokens:0,unresolved:0});
  expect(owner.snapshot().rows[0]).toMatchObject({recoveryOutcome:'abandoned_unconfirmed',usage:null});
});

it('runs local recovery on its timer without dispatching a model request',async()=>{
  const file=await path();let now=0;let owner=open(file,()=>now);
  await owner.reserve(binding,limits,ownership('old',now));await owner.close();
  now=270_000;vi.useFakeTimers();owner=open(file,()=>now);
  expect(owner.snapshot().unresolved).toBe(1);
  now=300_000;await vi.advanceTimersByTimeAsync(30_000);
  expect(owner.snapshot()).toMatchObject({starts:1,unknown:1,unresolved:0});
  await owner.close();expect(vi.getTimerCount()).toBe(0);
});

it('persists the entire retry backoff sequence and resets only after success',async()=>{
  const file=await path();let now=0;let owner=open(file,()=>now);
  for(const delay of [60_000,120_000,300_000,600_000,1_800_000,1_800_000]) {
    const reservation=(await owner.reserve(binding,limits,ownership('failed',now)))!;
    expect(reservation).not.toBeNull();await owner.markDispatch(reservation.id);await owner.settle(reservation.id,null);
    await owner.close();owner=open(file,()=>now);
    expect(await owner.reserve(binding,limits,{...ownership('failed',now),turnGeneration:99})).toBeNull();
    now+=delay-1;expect(await owner.reserve(binding,limits,ownership('failed',now))).toBeNull();now++;
  }
  const success=(await owner.reserve(binding,limits,ownership('failed',now)))!;
  await owner.markDispatch(success.id);await owner.settle(success.id,{kind:'api-tokens',inputTokens:3,outputTokens:2,cachedInputTokens:0});
  expect(await owner.reserve(binding,limits,ownership('failed',now))).not.toBeNull();
  expect(owner.snapshot()).toMatchObject({unknown:6,knownTokens:5});
});

it('waits a monotonic grace after wall clock rollback',async()=>{
  const file=await path();let owner=open(file,()=>900_000);
  await owner.reserve(binding,limits,ownership('old',900_000));await owner.close();
  let mono=0;owner=createApiAccounting(file,()=>100_000,()=>mono);owners.push(owner);
  mono=299_999;expect(await owner.reserve(binding,limits,ownership('old',100_000))).toBeNull();
  mono=300_000;expect(await owner.reserve(binding,limits,ownership('old',100_000))).not.toBeNull();
  expect(owner.snapshot().unknown).toBe(1);
});

it('does not inherit another credential scope pending call or retry history',async()=>{
  const owner=open(await path(),()=>0);
  const old={...ownership('same',0),accountScope:'a'.repeat(64)};
  const fresh={...ownership('same',0),accountScope:'b'.repeat(64)};
  const first=(await owner.reserve(binding,limits,old))!;
  expect(await owner.reserve(binding,limits,fresh)).not.toBeNull();
  await owner.settle(first.id,null);
  expect(await owner.reserve(binding,limits,old)).toBeNull();
});

it('bounds retry abandonment backoff after clock rollback',async()=>{
  const file=await path();let now=900_000,mono=0;
  let owner=open(file,()=>now);
  const first=(await owner.reserve(binding,limits,ownership('same',now)))!;
  await owner.settle(first.id,null);now+=60_000;
  expect(await owner.reserve(binding,limits,ownership('same',now))).not.toBeNull();await owner.close();
  now=100_000;owner=createApiAccounting(file,()=>now,()=>mono);owners.push(owner);
  mono=300_000;expect(await owner.reserve(binding,limits,ownership('same',now))).toBeNull();
  // Second failed attempt: two-minute backoff, not the pre-rollback wall time.
  now=219_999;expect(await owner.reserve(binding,limits,ownership('same',now))).toBeNull();
  now=220_000;expect(await owner.reserve(binding,limits,ownership('same',now))).not.toBeNull();
});
