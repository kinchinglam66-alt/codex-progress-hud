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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => {resolve = nextResolve;});
  return {promise, resolve};
}

describe('desktop observer provider composition', () => {
  it.each(['dynamic','compatibility'])('forwards stages through the %s provider host',async mode=>{
    const directory=await mkdtemp(join(tmpdir(),'observer-stage-forwarding-'));
    const delegate=worker('stages');
    delegate.observe=async(_input,_signal,_key,_generation,onStage)=>{onStage?.('preparation');return {status:'process_error',interpretation:null,usage:null};};
    const owned:ProviderWorkerOwner={workers:[delegate],workerSource:{acquire:()=>delegate,release:async()=>{},all:()=>[delegate]},close:async()=>{},inspect:async()=>({label:'fixture',fingerprint:'fixture'})};
    const host=await createObserverProviderHost({dataDirectory:directory,consentProtection:{protect:v=>v,unprotect:v=>v},openSubscription:async()=>owned,autoStartSubscription:true});
    try{
      await host.start(new AbortController().signal);
      const stages:string[]=[];
      const subject=mode==='dynamic'?host.workerSource!.acquire('stages'):host.workers[0]!;
      await subject.observe({goalSummary:null,activeSeconds:0,runtime:'running',messages:[],truncated:false},new AbortController().signal,'stages',0,stage=>stages.push(stage));
      expect(stages).toEqual(['preparation']);
    }finally{await host.close();}
  });
  it('replaces a retained poisoned lease after its child finally exits',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'observer-retained-lease-'));
    let alive=true;
    const old=worker('old');old.status=()=>({active:alive,disabled:true,poisoned:true});
    const fresh=worker('fresh');fresh.observe=async()=>({status:'interpreted',interpretation:{relation:'continue',status:'running',summary:'new',estimate:null},usage:null});
    const owned:ProviderWorkerOwner={workers:[],workerSource:{acquire:()=>alive?old:fresh,release:async()=>{throw Error('close unconfirmed');},all:()=>alive?[old]:[fresh]},close:async()=>undefined,inspect:async()=>({label:'fixture',fingerprint:'fixture'})};
    const host=await createObserverProviderHost({dataDirectory:directory,consentProtection:{protect:v=>v,unprotect:v=>v},openSubscription:async()=>owned,autoStartSubscription:true});
    try{
      await host.start(new AbortController().signal);host.workerSource!.acquire('same');
      await expect(host.workerSource!.release('same')).rejects.toThrow('close unconfirmed');
      alive=false;
      const next=host.workerSource!.acquire('same');
      const result=await next.observe({goalSummary:null,activeSeconds:1,runtime:'running',messages:[],truncated:false},new AbortController().signal,'same');
      expect(result).toMatchObject({status:'interpreted',interpretation:{summary:'new'}});
    }finally{await host.close();}
  });
  it('fences dynamically acquired workers after disable and forwards the actual turn generation',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'observer-dynamic-fence-'));
    const pending=deferred<any>(),released=deferred<void>();
    const delegate=worker('dynamic');delegate.observe=vi.fn(()=>pending.promise);
    const owned:ProviderWorkerOwner={workers:[],workerSource:{acquire:()=>delegate,release:()=>released.promise,all:()=>[delegate]},close:async()=>undefined,inspect:async()=>({label:'fixture',fingerprint:'fixture'})};
    const host=await createObserverProviderHost({dataDirectory:directory,consentProtection:{protect:v=>v,unprotect:v=>v},openSubscription:async()=>owned,autoStartSubscription:true});
    try{
      await host.start(new AbortController().signal);
      const lease=host.workerSource!.acquire('conversation');
      const input={goalSummary:null,activeSeconds:1,runtime:'running' as const,messages:[],truncated:false};
      const signal=new AbortController().signal;
      const result=lease.observe(input,signal,'conversation',17);
      expect(delegate.observe).toHaveBeenCalledWith(input,signal,'conversation',17,undefined);
      const releasing=host.workerSource!.release('conversation');
      expect(()=>host.workerSource!.acquire('conversation')).toThrow('PROVIDER_WORKER_CLOSING');
      released.resolve();await releasing;
      host.disable();expect(delegate.disable).toHaveBeenCalled();
      pending.resolve({status:'interpreted',interpretation:{status:'running'},usage:null});
      expect(await result).toMatchObject({status:'disabled',interpretation:null});
      await lease.observe(input,signal,'conversation',18);
      expect(delegate.observe).toHaveBeenCalledTimes(1);
    }finally{await host.close();}
  });
  it('keeps verified identity when interactive start fails after inspection',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'observer-interactive-account-'));
    const settings={inspect:async()=>({accountLabel:'retained@example.invalid',evidence:{accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64),observedAt:0,expiresAt:300000}})} as any;
    const host=await createObserverProviderHost({dataDirectory:directory,consentProtection:{protect:v=>v,unprotect:v=>v},subscriptionAccount:settings,openSubscription:async()=>{throw Error('SETUP_FAILED');}});
    try{
      await expect(host.startProvider({...host.status(),selected:'subscription',consent:true})).rejects.toThrow('PROVIDER_ACTIVATION_FAILED');
      expect(await host.readProviderSettings()).toMatchObject({state:'inactive',accountStatus:'ready',account:{label:'retained@example.invalid'}});
    }finally{await host.close();}
  });
  it.each(['ready','unavailable','signed_out'])('separates account %s from estimator startup failure', async(expected)=>{
    const directory=await mkdtemp(join(tmpdir(),'observer-account-status-'));
    const host=await createObserverProviderHost({dataDirectory:directory,consentProtection:{protect:v=>v,unprotect:v=>v},autoStartSubscription:true,
      readSubscriptionAccount:async()=>{if(expected!=='ready')throw Error(expected==='signed_out'?'OBSERVER_LOGIN_REQUIRED':'PRIVATE_NETWORK_ERROR');return {label:'fixture@example.invalid',observedAt:0,expiresAt:300000};},
      openSubscription:async()=>{throw Error('SETUP_FAILED');}});
    try{
      expect((await host.readProviderSettings()).accountStatus).toBe('unknown');
      await host.start(new AbortController().signal);
      const value=await host.readProviderSettings();
      expect(value.state).toBe('inactive');expect(value.accountStatus).toBe(expected);
      expect(value.account?.label??null).toBe(expected==='ready'?'fixture@example.invalid':null);
      expect(JSON.stringify(value)).not.toContain('PRIVATE_NETWORK_ERROR');
    }finally{await host.close();}
  });
  it('never reuses an API secret after changing its endpoint or profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const openApi = vi.fn(async () => owner('api'));
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: v => v, unprotect: v => v}, openSubscription: async () => owner('subscription'), openApi});
    await host.saveProviderSettings({...host.status(), draft: apiDraft, secret: 'original-key'});
    const changed = {...apiDraft, api: {...apiDraft.api, baseUrl: 'https://different.example.test/v1'}};
    await host.saveProviderSettings({...host.status(), draft: changed});
    expect((await host.readProviderSettings()).draft.api?.keyConfigured).toBe(false);
    expect((await host.checkProvider({...host.status()})).ok).toBe(false);
    expect(openApi).not.toHaveBeenCalled();
    await host.close();
  });
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

  it('composes subscription account verification and activation with a one-shot inline consent marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const subscription = owner('subscription');
    const openSubscription = vi.fn(async (_signal: AbortSignal, consent: unknown) => {
      expect(consent).toMatchObject({kind: 'inline'});
      return subscription;
    });
    const accountSettings = {
      inspect: vi.fn(async () => ({accountLabel: 'person@example.invalid', evidence: {
        accountFingerprint: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64), assetsFingerprint: 'c'.repeat(64), observedAt: 0, expiresAt: 300000,
      }})),
      login: vi.fn(async () => 'process_exited' as const), deviceAuth: vi.fn(), logout: vi.fn(), status: vi.fn(), providerOwner: vi.fn(), close: vi.fn(async () => undefined),
    } as any;
    const host = await createObserverProviderHost({
      dataDirectory: directory,
      consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value},
      openSubscription,
      subscriptionAccount: accountSettings,
      readSubscriptionAccount: async () => ({label: 'person@example.invalid', observedAt: 0, expiresAt: 300000}),
      now: () => 0,
    });
    const before = host.status();
    await host.startProvider({generation: before.generation, revision: before.revision, selected: 'subscription', consent: true});
    expect(accountSettings.inspect).toHaveBeenCalled();
    expect(accountSettings.login).not.toHaveBeenCalled();
    expect(openSubscription).toHaveBeenCalledOnce();
    expect(host.status().state).toBe('ready');
    await host.close();
  });

  it('opens the official login only after draining an active subscription runtime when attestation says login is required', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const events: string[] = [];
    const first = owner('old-subscription'); first.close = vi.fn(async () => {events.push('close-old');});
    const second = owner('new-subscription');
    const snapshot = {accountLabel: 'person@example.invalid', evidence: {accountFingerprint: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64), assetsFingerprint: 'c'.repeat(64), observedAt: 0, expiresAt: 300000}};
    const inspect = vi.fn(async () => snapshot);
    const accountSettings = {
      inspect,
      login: vi.fn(async () => {events.push('login'); return 'process_exited' as const;}), deviceAuth: vi.fn(), logout: vi.fn(), status: vi.fn(), providerOwner: vi.fn(), close: vi.fn(async () => undefined),
    } as any;
    const openSubscription = vi.fn(async (_signal: AbortSignal, consent: unknown) => {events.push(consent ? 'open-inline' : 'open-old'); return openSubscription.mock.calls.length === 1 ? first : second;});
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value}, openSubscription, subscriptionAccount: accountSettings, readSubscriptionAccount: async () => ({label: snapshot.accountLabel, observedAt: 0, expiresAt: 300000}), now: () => 0});
    const initial = host.status();
    await host.startProvider({generation: initial.generation, revision: initial.revision, selected: 'subscription', consent: true});
    inspect.mockRejectedValueOnce(new Error('OBSERVER_LOGIN_REQUIRED'));
    const beforeLogin = host.status();
    await host.startProvider({generation: beforeLogin.generation, revision: beforeLogin.revision, selected: 'subscription', consent: true});
    expect(events.indexOf('close-old')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('close-old')).toBeLessThan(events.indexOf('login'));
    expect(events.filter(event => event === 'open-inline')).toHaveLength(2);
    await host.close();
  });

  it('saves and activates an API in one step', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const openApi = vi.fn(async () => owner('api'));
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value}, openSubscription: async () => owner('subscription'), openApi});
    const before = host.status();
    const result = await host.startProvider({generation: before.generation, revision: before.revision, selected: 'api', consent: true, draft: apiDraft, secret: 'one-shot-key'});
    expect(result.state).toBe('ready');
    expect(result.active.selected).toBe('api');
    expect((await host.readProviderSettings()).draft.api?.keyConfigured).toBe(true);
    expect(openApi).toHaveBeenCalledOnce();
    await host.close();
  });

  it('aborting an API one-step action drains the composed promise before returning and never activates the saved draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    const pending = deferred<ProviderWorkerOwner>();
    const openApi = vi.fn(() => pending.promise);
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: {protect: (value: string) => value, unprotect: (value: string) => value}, openSubscription: async () => owner('subscription'), openApi});
    const before = host.status();
    const starting = host.startProvider({generation: before.generation, revision: before.revision, selected: 'api', consent: true, draft: apiDraft, secret: 'one-shot-key'});
    await vi.waitFor(() => expect(openApi).toHaveBeenCalledOnce());
    expect(() => host.startProvider({generation: before.generation, revision: before.revision, selected: 'api', consent: true, draft: apiDraft, secret: 'second-key'})).toThrow('PROVIDER_ACTION_BUSY');
    const canceling = host.cancelProviderAction();
    pending.resolve(owner('late-api'));
    await canceling;
    await expect(starting).rejects.toThrow();
    expect(host.status().active.selected).toBe('subscription');
    expect(host.status().state).toBe('inactive');
    await host.close();
  });

  it('cancelling while the write-only API key is being saved does not continue into activation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observer-provider-host-'));
    let saving = false;
    let release!: (value: string) => void;
    const protection = {protect: vi.fn(async (value: string) => {saving = true; return new Promise<string>(resolve => {release = () => resolve(value);});}), unprotect: (value: string) => value};
    const openApi = vi.fn(async () => owner('api'));
    const host = await createObserverProviderHost({dataDirectory: directory, consentProtection: protection, openSubscription: async () => owner('subscription'), openApi});
    const before = host.status();
    const starting = host.startProvider({generation: before.generation, revision: before.revision, selected: 'api', consent: true, draft: apiDraft, secret: 'one-shot-key'});
    await vi.waitFor(() => expect(saving).toBe(true));
    const canceling = host.cancelProviderAction();
    release('sealed-key');
    await canceling;
    await expect(starting).rejects.toThrow();
    expect(openApi).not.toHaveBeenCalled();
    expect(host.status().active.selected).toBe('subscription');
    await host.close();
  });
});
