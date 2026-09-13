import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, expect, it} from 'vitest';
import {ensureSubscriptionRootOwner, loadDesktopObserverPilot, subscriptionAccountingDirectory,shouldEnablePersistentObserver} from '../../src/desktop/observer-pilot.js';

const roots: string[] = [];
it('requires host opt-in and allows the host to override its saved pilot choice',()=>{
  expect(shouldEnablePersistentObserver({},null)).toBe(false);
  expect(shouldEnablePersistentObserver({},{persistentObserver:true})).toBe(true);
  expect(shouldEnablePersistentObserver({enablePersistentObserver:false},{persistentObserver:true})).toBe(false);
  expect(shouldEnablePersistentObserver({enablePersistentObserver:true},{persistentObserver:false})).toBe(true);
});
const protection = {
  protect: (value: string) => value,
  unprotect: (value: string) => value,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

it('keeps API-only provider settings available when the optional subscription pin is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hud-pilot-'));
  roots.push(root);
  await writeFile(join(root, 'observer-pilot.json'), '{not valid observer runtime config');

  const pilot = await loadDesktopObserverPilot({
    dataDirectory: root,
    resourcesDirectory: join(root, 'resources'),
    environment: {},
    consentProtection: protection,
    dialog: {showMessageBox: async () => ({response: 1})},
  });

  try {
    const settings = await pilot.providerSettings.readProviderSettings();
    expect(settings.state).toBe('inactive');
    expect(settings.selected).toBe('subscription');
    await expect(pilot.start(new AbortController().signal)).resolves.toBeUndefined();
  } finally {
    await pilot.close();
  }
});

it('keeps a new account in its account ledger after restart instead of rebinding the legacy root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hud-ledger-'));
  roots.push(root);
  const oldAccount='a'.repeat(64);
  const newAccount='b'.repeat(64);
  const oldGrant=async()=>({scope:{billingMode:'subscription',accountFingerprint:oldAccount}});
  const newGrant=async()=>({scope:{billingMode:'subscription',accountFingerprint:newAccount}});

  const initialized=await ensureSubscriptionRootOwner(root, oldGrant);
  expect(initialized).toBe(oldAccount);
  expect(subscriptionAccountingDirectory(root,newAccount,initialized)).toBe(join(root,'observer-accounting','accounts',newAccount));

  // Simulate account replacement and a fresh process reading the newly written grant.
  const afterRestart=await ensureSubscriptionRootOwner(root, newGrant);
  expect(afterRestart).toBe(oldAccount);
  expect(subscriptionAccountingDirectory(root,newAccount,afterRestart)).toBe(join(root,'observer-accounting','accounts',newAccount));
  expect(subscriptionAccountingDirectory(root,oldAccount,afterRestart)).toBe(join(root,'observer-accounting'));
});
