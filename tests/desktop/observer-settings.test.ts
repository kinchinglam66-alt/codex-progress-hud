import {expect, it, vi} from 'vitest';
import {createObserverSettingsController, SETTINGS_CHANNELS, type SettingsBrowserWindowLike} from '../../src/desktop/observer-settings.js';

function windowFixture() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const webContents = {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {listeners.set(event, listener);}),
    setWindowOpenHandler: vi.fn(),
  };
  let destroyed = false;
  const window: SettingsBrowserWindowLike = {
    webContents,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {listeners.set(event, listener); return window;}),
    loadFile: vi.fn(async () => undefined),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {destroyed = true;}),
  };
  return {window, listeners};
}

it('reuses one local settings window and rejects untrusted or stale IPC senders', async () => {
  const first = windowFixture();
  const createWindow = vi.fn(() => first.window);
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const controller = createObserverSettingsController({
    createWindow,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog: {showMessageBox: vi.fn(async () => ({response: 0}))},
    uiPath: 'C:/hud/settings.html',
    preloadPath: 'C:/hud/settings-preload.js',
    quitting: () => false,
    readStatus: () => ({state: 'blocked', revision: 4, knownTokens: 12, unknown: 1, recoveryAllowed: true}),
    preflight: async () => ({state: 'blocked', revision: 4, knownTokens: 12, unknown: 1, recoveryAllowed: true, allowed: true}),
    binding: () => 'account:route:assets',
    confirm: async () => ({state: 'recovered', revision: 4, knownTokens: 20, unknown: 1, recoveryAllowed: false}),
  });

  await controller.open();
  await controller.open();
  expect(createWindow).toHaveBeenCalledOnce();
  expect(first.window.focus).toHaveBeenCalledOnce();

  const getStatus = handlers.get(SETTINGS_CHANNELS.status)!;
  await expect(getStatus({sender: {}})).rejects.toThrow('SETTINGS_UNTRUSTED_SENDER');
  await expect(getStatus({sender: first.window.webContents})).resolves.toMatchObject({state: 'blocked'});

  const close = first.listeners.get('close')!;
  const event = {preventDefault: vi.fn()};
  close(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(first.window.hide).toHaveBeenCalledOnce();

  await expect(getStatus({sender: first.window.webContents})).resolves.toMatchObject({state: 'blocked'});
  await controller.dispose();
});

it('shows native confirmation before a revision-bound recovery and rejects stale revision data', async () => {
  const fixture = windowFixture();
  const dialog = {showMessageBox: vi.fn(async () => ({response: 0}))};
  const confirm = vi.fn(async () => ({state: 'recovered' as const, revision: 4, knownTokens: 20, unknown: 1, recoveryAllowed: false}));
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog,
    uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.js', quitting: () => false,
    readStatus: () => ({state: 'blocked', revision: 4, knownTokens: 12, unknown: 1, recoveryAllowed: true}),
    preflight: async () => ({state: 'blocked', revision: 4, knownTokens: 12, unknown: 1, recoveryAllowed: true, allowed: true}),
    binding: () => 'account:route:assets',
    confirm,
  });
  await controller.open();
  const invoke = handlers.get(SETTINGS_CHANNELS.confirm)!;
  await expect(invoke({sender: fixture.window.webContents}, {revision: 3, challenge: '11111111-1111-4111-8111-111111111111'})).rejects.toThrow('SETTINGS_STALE_REVISION');
  expect(confirm).not.toHaveBeenCalled();
  const preflight = handlers.get(SETTINGS_CHANNELS.preflight)!;
  const checked = await preflight({sender: fixture.window.webContents}) as {challenge: string};
  await expect(invoke({sender: fixture.window.webContents}, {revision: 4, challenge: checked.challenge})).resolves.toMatchObject({state: 'recovered'});
  await expect(invoke({sender: fixture.window.webContents}, {revision: 4, challenge: checked.challenge})).rejects.toThrow('SETTINGS_STALE_CHALLENGE');
  expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  expect(confirm).toHaveBeenCalledOnce();
  await controller.dispose();
});

it('issues a one-time expiring challenge bound to the settings window and recovery binding', async () => {
  const fixture = windowFixture();
  let now = 1000;
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog: {showMessageBox: vi.fn(async () => ({response: 0}))},
    uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.cjs', quitting: () => false,
    now: () => now,
    readStatus: () => ({state: 'blocked', revision: 9, knownTokens: 12, unknown: 1, recoveryAllowed: true}),
    preflight: async () => ({state: 'blocked' as const, revision: 9, knownTokens: 12, unknown: 1, recoveryAllowed: true, allowed: true}),
    binding: () => 'account:route:assets',
    confirm: async () => ({state: 'recovered' as const, revision: 9, knownTokens: 20, unknown: 1, recoveryAllowed: false}),
  });
  await controller.open();
  const checked = await handlers.get(SETTINGS_CHANNELS.preflight)!({sender: fixture.window.webContents}) as {challenge: string};
  expect(checked.challenge).toMatch(/^[0-9a-f-]{36}$/);
  now += 30_001;
  await expect(handlers.get(SETTINGS_CHANNELS.confirm)!({sender: fixture.window.webContents}, {revision: 9, challenge: checked.challenge})).rejects.toThrow('SETTINGS_STALE_CHALLENGE');
  await controller.dispose();
});

it('keeps the settings surface available when observer configuration is absent', async () => {
  const fixture = windowFixture();
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog: {showMessageBox: vi.fn(async () => ({response: 0}))},
    uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.cjs', quitting: () => false,
    readStatus: () => ({state: 'unconfigured' as const, revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    preflight: async () => ({state: 'unconfigured' as const, revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    binding: () => undefined,
    confirm: async () => { throw new Error('SETTINGS_UNAVAILABLE'); },
  });
  await controller.open();
  await expect(handlers.get(SETTINGS_CHANNELS.status)!({sender: fixture.window.webContents})).resolves.toMatchObject({state: 'unconfigured'});
  await expect(handlers.get(SETTINGS_CHANNELS.preflight)!({sender: fixture.window.webContents})).resolves.toMatchObject({allowed: false, state: 'unconfigured'});
  await controller.dispose();
});

it.each([0,1])('reports whether native confirmation actually revoked consent (choice %s)', async response => {
  const fixture = windowFixture();
  const revokeConsent = vi.fn(async () => undefined);
  const dialog = {showMessageBox: vi.fn(async () => ({response}))};
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog, uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.cjs', quitting: () => false,
    readStatus: () => ({state: 'normal' as const, revision: 1, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    preflight: async () => ({state: 'normal' as const, revision: 1, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    binding: () => 'binding', confirm: async () => ({state: 'normal' as const, revision: 1, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    revokeConsent,
  });
  await controller.open();
  const result=await handlers.get(SETTINGS_CHANNELS.revoke)!({sender: fixture.window.webContents});
  expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('撤销估时授权')}));
  expect(revokeConsent).toHaveBeenCalledTimes(response===0?1:0);
  expect(result).toMatchObject({consentRevoked:response===0});
  await controller.dispose();
});

it('routes provider settings only through a trusted sender and keeps save inert', async () => {
  const fixture = windowFixture();
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const readProviderSettings = vi.fn(async () => ({
    generation: 7, revision: 3, selected: 'subscription', state: 'ready',
    draft: {selected: 'api', api: {profileId: 'draft', name: 'Draft', baseUrl: 'https://api.example.test/v1', protocol: 'responses', model: 'model', reasoningEffort: 'medium', maxOutputTokens: 2048, dailyCallLimit: 24}},
    active: {selected: 'subscription', api: null}, keyConfigured: false,
    account: {label: 'person@example.invalid', observedAt: 1000, expiresAt: 301000}, recipient: 'Codex Progress HUD observer',
  }));
  const saveProviderSettings = vi.fn(async () => readProviderSettings());
  const checkProvider = vi.fn();
  const providerDialog = {showMessageBox: vi.fn(async () => ({response:1}))};
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog: providerDialog,
    uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.cjs', quitting: () => false,
    readStatus: () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    preflight: async () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    binding: () => 'binding', confirm: async () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    provider: {readProviderSettings, saveProviderSettings,
      replaceSubscriptionAccount: vi.fn(), checkProvider, trialProvider: vi.fn(), activateProvider: vi.fn(), startProvider: vi.fn(), cancelProviderAction: vi.fn()},
  });
  await controller.open();
  const channel = 'codex-progress-hud:settings:provider:read';
  const read = handlers.get(channel)!;
  await expect(read({sender: {}})).rejects.toThrow('SETTINGS_UNTRUSTED_SENDER');
  await expect(read({sender: fixture.window.webContents})).resolves.toMatchObject({keyConfigured: false});
  const save = handlers.get('codex-progress-hud:settings:provider:save')!;
  await expect(save({sender: fixture.window.webContents}, {
    generation: 7, revision: 3, draft: {selected: 'api', api: {profileId: 'draft', name: 'Draft', baseUrl: 'https://api.example.test/v1', protocol: 'responses', model: 'model', reasoningEffort: 'medium', maxOutputTokens: 2048, dailyCallLimit: 24}}, secret: 'write-only-secret'
  })).resolves.toMatchObject({selected: 'subscription'});
  expect(saveProviderSettings).toHaveBeenCalledWith(expect.objectContaining({generation: 7, revision: 3, secret: 'write-only-secret'}));
  expect(await read({sender: fixture.window.webContents})).not.toHaveProperty('apiKey');
  expect(await read({sender: fixture.window.webContents})).not.toHaveProperty('keyRef');
  // A declined endpoint-specific credential disclosure must not run the check.
  await handlers.get(SETTINGS_CHANNELS.providerCheck)!({sender: fixture.window.webContents}, {generation:7,revision:3});
  expect(providerDialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({detail:expect.stringContaining('API 密钥')}));
  expect(checkProvider).not.toHaveBeenCalled();
  await controller.dispose();
});

it('routes the primary one-step provider action without stacking a native confirmation', async () => {
  const fixture = windowFixture();
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const startProvider = vi.fn(async () => ({state: 'ready'}));
  const dialog = {showMessageBox: vi.fn(async () => ({response: 0}))};
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog, uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.cjs', quitting: () => false,
    readStatus: () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    preflight: async () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    binding: () => 'binding', confirm: async () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    provider: {
      readProviderSettings: async () => ({}), saveProviderSettings: async () => ({}), replaceSubscriptionAccount: async () => ({}),
      checkProvider: async () => ({ok: true}), trialProvider: async () => ({}), activateProvider: async () => ({}), cancelProviderAction: async () => ({}), startProvider,
    },
  });
  await controller.open();
  const invoke = handlers.get(SETTINGS_CHANNELS.providerStart)!;
  await expect(invoke({sender: {}} as any, {generation: 7, revision: 3, selected: 'subscription', consent: true})).rejects.toThrow('SETTINGS_UNTRUSTED_SENDER');
  await expect(invoke({sender: fixture.window.webContents}, {generation: 7, revision: 3, selected: 'subscription', consent: true})).resolves.toMatchObject({state: 'ready'});
  expect(startProvider).toHaveBeenCalledWith({generation: 7, revision: 3, selected: 'subscription', consent: true});
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
  await controller.dispose();
});

it('cancels provider work on hide and dispose while retaining handlers until disposal', async () => {
  const fixture = windowFixture();
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  const cancelProviderAction = vi.fn(() => cancellation);
  const controller = createObserverSettingsController({
    createWindow: () => fixture.window,
    ipcMain: {handle: (channel, listener) => {handlers.set(channel, listener);}, removeHandler: vi.fn()},
    dialog: {showMessageBox: vi.fn(async () => ({response: 0}))},
    uiPath: 'C:/hud/settings.html', preloadPath: 'C:/hud/settings-preload.cjs', quitting: () => false,
    readStatus: () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    preflight: async () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    binding: () => 'binding', confirm: async () => ({state: 'normal' as const, revision: 3, knownTokens: 0, unknown: 0, recoveryAllowed: false}),
    provider: {readProviderSettings: async () => ({}), saveProviderSettings: async () => ({}), replaceSubscriptionAccount: async () => ({}), checkProvider: async () => ({ok: true}), trialProvider: async () => ({}), activateProvider: async () => ({}), startProvider: async () => ({}), cancelProviderAction},
  });
  await controller.open();
  fixture.listeners.get('close')!({preventDefault: vi.fn()});
  await vi.waitFor(()=>expect(cancelProviderAction).toHaveBeenCalledOnce());
  expect(handlers.has(SETTINGS_CHANNELS.providerStart)).toBe(true);
  let disposed = false;
  const disposing = controller.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  releaseCancellation();
  await disposing;
  expect(disposed).toBe(true);
  expect(cancelProviderAction).toHaveBeenCalledOnce();
});
