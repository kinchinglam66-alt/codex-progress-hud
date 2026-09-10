import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createObserverConsentStore, type ObserverConsentScope} from '../../src/estimation/observer-consent-store.js';

const directories: string[] = [];
const scope: ObserverConsentScope = {
  accountFingerprint: 'a'.repeat(64),
  providerFingerprint: 'b'.repeat(64),
  recipientFingerprint: 'c'.repeat(64),
  dataCategories: ['goal', 'conversation', 'tools'],
  billingMode: 'subscription',
  policyVersion: 'remembered-v1',
};

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hud-consent-store-'));
  directories.push(directory);
  const protectedValues: string[] = [];
  const store = createObserverConsentStore(join(directory, 'consent.json'), {
    protect: async value => { protectedValues.push(value); return `sealed:${value}`; },
    unprotect: async value => value.startsWith('sealed:') ? value.slice('sealed:'.length) : null,
  });
  return {store, protectedValues, path: join(directory, 'consent.json')};
}

it('persists only a versioned scoped grant and restores it after reopening', async () => {
  const first = await storeFixture();
  await first.store.grant(scope, 100);
  expect(first.protectedValues[0]).not.toContain('task text');
  expect(await first.store.read()).toMatchObject({version: 1, scope: {...scope, dataCategories: ['conversation', 'goal', 'tools']}, grantedAt: 100});

  const second = createObserverConsentStore(first.path, {
    protect: async value => `sealed:${value}`,
    unprotect: async value => value.startsWith('sealed:') ? value.slice('sealed:'.length) : null,
  });
  expect(await second.read()).toMatchObject({version: 1, scope: {...scope, dataCategories: ['conversation', 'goal', 'tools']}, grantedAt: 100});
});

it('rejects changed account, recipient, category, or billing scope without deleting the record', async () => {
  const {store} = await storeFixture();
  await store.grant(scope, 100);
  expect(store.matches({...scope, accountFingerprint: 'd'.repeat(64)})).toBe(false);
  expect(store.matches({...scope, recipientFingerprint: 'd'.repeat(64)})).toBe(false);
  expect(store.matches({...scope, dataCategories: ['goal']})).toBe(false);
  expect(store.matches({...scope, billingMode: 'subscription', policyVersion: 'remembered-v2'})).toBe(false);
  expect(await store.read()).not.toBeNull();
});

it('revocation durably removes the grant', async () => {
  const {store} = await storeFixture();
  await store.grant(scope, 100);
  await store.revoke();
  expect(await store.read()).toBeNull();
  expect(store.matches(scope)).toBe(false);
});

it('fails closed for malformed, forged, and oversized stored records', async () => {
  const {store, path} = await storeFixture();
  await writeFile(path, 'sealed:{"version":999}', {mode: 0o600});
  await expect(store.read()).resolves.toBeNull();
});
