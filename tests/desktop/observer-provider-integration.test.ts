import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {createObserverProviderHost, type ProviderWorkerOwner} from '../../src/desktop/observer-provider-host.js';
import type {ObserverWorker} from '../../src/estimation/observer-scheduler.js';

const apiDraft = {
  selected: 'api' as const,
  api: {profileId: 'api-profile', name: 'Fixture API', baseUrl: 'https://api.example.test/v1', protocol: 'responses' as const,
    model: 'fixture-model', reasoningEffort: 'medium' as const, maxOutputTokens: 2048, dailyCallLimit: 24},
};

function worker(label: string): ObserverWorker {
  return {observe: vi.fn(async () => ({status: 'disabled' as const, interpretation: null, usage: null})),
    status: () => ({active: false, disabled: false, poisoned: false}), disable: vi.fn(), close: vi.fn(async () => undefined),
    provenance: () => null};
}

function owner(label: string): ProviderWorkerOwner {
  const workers = [worker(`${label}-1`), worker(`${label}-2`)] as const;
  return {workers, close: vi.fn(async () => undefined), inspect: vi.fn(async () => ({label, fingerprint: `${label}-fingerprint`}))};
}

describe('desktop observer provider composition', () => {
  it('retains failed check cleanup and blocks another operation until close succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const candidate = owner('api');
    candidate.close = vi.fn().mockRejectedValueOnce(new Error('fixture')).mockResolvedValue(undefined);
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: v => v, unprotect: v => v}, openSubscription: async () => owner('subscription'), openApi: async () => candidate});
    await host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'fixture'});
    await expect(host.checkProvider({...host.status()})).rejects.toThrow('PROVIDER_CLEANUP_FAILED');
    await expect(host.activateProvider({...host.status(), selected: 'api'})).rejects.toThrow('PROVIDER_CLEANUP_FAILED');
    await host.close(); expect(candidate.close).toHaveBeenCalledTimes(2);
  });

  it('a saved API draft remains inert across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const openApi = vi.fn(async () => owner('api'));
    const options = {dataDirectory: directory, consentProtection: {protect: (v: string) => v, unprotect: (v: string) => v}, openSubscription: async () => owner('subscription'), openApi};
    const host = await createObserverProviderHost(options);
    await host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'fixture'}); await host.close();
    const next = await createObserverProviderHost(options); await next.start(new AbortController().signal);
    expect(openApi).not.toHaveBeenCalled(); expect(next.status().state).toBe('inactive'); await next.close();
  });

  it('drains the active owner before a synthetic API trial and leaves tracking inactive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const events: string[] = [];
    const old = owner('subscription'); old.close = async () => {events.push('close');};
    const candidate = owner('api'); candidate.trial = async () => {events.push('trial');};
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: v => v, unprotect: v => v}, openSubscription: async () => old, openApi: async () => candidate});
    await host.activateProvider({...host.status(), selected: 'subscription'});
    await host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'fixture'});
    await host.trialProvider({...host.status()});
    expect(events).toEqual(['close', 'trial']); expect(host.status().state).toBe('inactive'); await host.close();
  });
  it('releases the action lock after activation has no key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: v => v, unprotect: v => v}, openSubscription: async () => owner('subscription')});
    await host.saveProviderSettings({...host.status(), draft: apiDraft});
    await expect(host.activateProvider({...host.status(), selected: 'api'})).rejects.toThrow();
    await expect(host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'fixture'})).resolves.toHaveProperty('draft');
    await host.close();
  });

  it('close waits for a deferred check owner and rejects subsequent mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    let release!: (value: ProviderWorkerOwner) => void;
    const deferred = new Promise<ProviderWorkerOwner>(resolve => {release = resolve;});
    const openApi = vi.fn(() => deferred);
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: v => v, unprotect: v => v}, openSubscription: async () => owner('subscription'), openApi});
    await host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'fixture'});
    const checking = host.checkProvider({...host.status()});
    await vi.waitFor(() => expect(openApi).toHaveBeenCalled());
    let closed = false;
    const closing = host.close().then(() => {closed = true;});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    const candidate = owner('api'); release(candidate);
    await checking.catch(() => undefined); await closing;
    expect(candidate.close).toHaveBeenCalled();
    await expect(host.saveProviderSettings({...host.status(), draft: apiDraft})).rejects.toThrow();
  });

  it('does not reopen an API after its remembered grant is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const openApi = vi.fn(async () => owner('api'));
    const options = {dataDirectory: directory, consentProtection: {protect: (v: string) => v, unprotect: (v: string) => v}, openSubscription: async () => owner('subscription'), openApi};
    const host = await createObserverProviderHost(options);
    await host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'fixture'});
    await host.activateProvider({...host.status(), selected: 'api'}); await host.close();
    await writeFile(join(directory, 'observer-api-consent.json'), '{}');
    openApi.mockClear();
    const restarted = await createObserverProviderHost(options);
    await restarted.start(new AbortController().signal);
    expect(openApi).not.toHaveBeenCalled(); await restarted.close();
  });
  it('keeps save inert and persists only a draft with write-only secret input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const host = await createObserverProviderHost({
      dataDirectory: directory,
      consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value},
      openSubscription: vi.fn(async () => owner('subscription')),
      openApi: vi.fn(async () => owner('api')),
      readSubscriptionAccount: vi.fn(async () => ({label: 'person@example.invalid', observedAt: 1000, expiresAt: 301000})),
      now: () => 1000,
    });
    const before = host.status();
    await host.saveProviderSettings({generation: before.generation, revision: before.revision, draft: apiDraft, secret: 'secret-only'});
    expect(host.status().state).toBe('inactive');
    expect(host.status().active.selected).toBe('subscription');
    const draft = JSON.parse(await readFile(join(directory, 'observer-provider-draft.json'), 'utf8')) as Record<string, unknown>;
    expect(draft).not.toHaveProperty('apiKey');
    expect(draft).toHaveProperty('api');
    await host.close();
  });

  it('invalidates stable workers before an activation await and delegates the selected owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const subscription = owner('subscription');
    const api = owner('api');
    const host = await createObserverProviderHost({
      dataDirectory: directory,
      consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value},
      openSubscription: vi.fn(async () => subscription),
      openApi: vi.fn(async () => api),
      readSubscriptionAccount: vi.fn(async () => ({label: 'person@example.invalid', observedAt: 1000, expiresAt: 301000})),
      now: () => 1000,
    });
    const initial = host.status();
    await host.saveProviderSettings({generation: initial.generation, revision: initial.revision, draft: apiDraft, secret: 'synthetic-secret'});
    await host.activateProvider({generation: host.status().generation, revision: host.status().revision, selected: 'subscription'});
    const proxy = host.workers[0]!;
    expect(proxy.status().disabled).toBe(false);
    const switching = host.activateProvider({generation: host.status().generation, revision: host.status().revision, selected: 'api'});
    expect(proxy.status().disabled).toBe(true);
    await switching;
    expect(proxy.status().disabled).toBe(false);
    expect(proxy).not.toBe(api.workers[0]);
    expect(api.workers[0]!.status().disabled).toBe(false);
    expect(JSON.parse(await readFile(join(directory, 'observer-provider-active.json'), 'utf8'))).toMatchObject({selected: 'api'});
    await host.close();
  });

  it('preserves late usage and outcomes while discarding only a stale interpretation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    let resolveObservation!: (value: any) => void;
    const observation = new Promise<any>(resolve => { resolveObservation = resolve; });
    const old = owner('subscription');
    old.workers[0]!.observe = vi.fn(async () => observation);
    const api = owner('api');
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value},
      openSubscription: vi.fn(async () => old), openApi: vi.fn(async () => api), autoStartSubscription: false});
    const first = host.status();
    await host.activateProvider({generation: first.generation, revision: first.revision, selected: 'subscription'});
    const pending = host.workers[0]!.observe({} as never, new AbortController().signal, 'conversation');
    const switching = host.activateProvider({generation: host.status().generation, revision: host.status().revision, selected: 'subscription'});
    resolveObservation({status: 'interpreted', interpretation: {relation: 'continue', status: 'running', summary: null, estimate: null}, usage: {kind: 'api-tokens', inputTokens: 4, outputTokens: 2, cachedInputTokens: 0}, outcomes: {prediction: 'unknown', call: 'success', usage: 'known', framingValid: true, closureConfirmed: true, dispatch: 'started'}});
    await switching;
    await expect(pending).resolves.toMatchObject({status: 'disabled', interpretation: null, usage: {inputTokens: 4}, outcomes: {dispatch: 'started'}});
    await host.close();
  });

  it('does not auto-start a subscription when the durable provider state is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    await writeFile(join(directory, 'observer-provider-state.json'), JSON.stringify({version: 1, generation: 1, revision: 1, state: 'ready', selected: 'subscription', unexpected: true}));
    const openSubscription = vi.fn(async () => owner('subscription'));
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value}, openSubscription, autoStartSubscription: true});
    await host.start(new AbortController().signal);
    expect(openSubscription).not.toHaveBeenCalled();
    await host.close();
  });

  it('drains the active owner before invoking an independent account action', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const events: string[] = [];
    const subscription = owner('subscription');
    subscription.close = vi.fn(async () => { events.push('close'); });
    const accountSettings = {login: vi.fn(async () => { events.push('login'); return 'cancelled' as const; }), deviceAuth: vi.fn(), logout: vi.fn(), inspect: vi.fn(), status: vi.fn(), providerOwner: vi.fn(), close: vi.fn(async () => undefined)} as never;
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value},
      openSubscription: vi.fn(async () => subscription), subscriptionAccount: accountSettings, autoStartSubscription: true});
    await host.start(new AbortController().signal);
    const status = host.status();
    const result = await host.replaceSubscriptionAccount({generation: status.generation, revision: status.revision, action: 'login'});
    expect(result.outcome).toBe('cancelled');
    expect(events).toEqual(['close', 'login']);
    expect(JSON.parse(await readFile(join(directory, 'observer-provider-state.json'), 'utf8'))).toMatchObject({state: 'inactive'});
    await host.close();
  });
});
