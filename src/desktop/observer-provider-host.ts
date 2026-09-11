import {randomUUID} from 'node:crypto';
import {mkdir, lstat, open} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {parseProviderConfig, readProviderConfig, saveProviderConfig, toPublicProviderConfig, type ApiConfig, type ProviderConfig} from './observer-provider-config.js';
import {createObserverSecretStore} from './observer-secret-store.js';
import type {ConsentProtection} from '../estimation/observer-consent-store.js';
import {createObserverConsentStore, type ObserverConsentStore} from '../estimation/observer-consent-store.js';
import {observerApiConsentScope} from '../estimation/observer-consent.js';
import type {ObserverWorker, ObserverWorkerSource} from '../estimation/observer-scheduler.js';
import type {ProviderOwner} from './observer-provider-selection.js';
import {createProviderSelection} from './observer-provider-selection.js';
import type {ObserverAccountSettings} from './observer-account-settings.js';

const activePath = (root: string): string => join(root, 'observer-provider-active.json');
const draftPath = (root: string): string => join(root, 'observer-provider-draft.json');
const statePath = (root: string): string => join(root, 'observer-provider-state.json');
const secretPath = (root: string): string => join(root, 'observer-provider-secrets.json');

const mutation = z.object({generation: z.number().int().nonnegative().safe(), revision: z.number().int().nonnegative().safe()}).passthrough();
const apiDraft = z.object({selected: z.literal('api'), api: z.object({
  profileId: z.string().min(1).max(128), name: z.string().min(1).max(256), baseUrl: z.string().min(1).max(2048),
  protocol: z.literal('responses'), model: z.string().min(1).max(256), reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  maxOutputTokens: z.number().int().positive().max(100_000), dailyCallLimit: z.number().int().positive().max(10_000),
}).strict()}).strict();
const providerDraft = z.union([z.object({selected: z.literal('subscription'), api: z.null()}).strict(), apiDraft]);

export interface ProviderWorkerOwner extends ProviderOwner {
  workers: readonly ObserverWorker[];
  workerSource?: ObserverWorkerSource;
  check?(signal: AbortSignal): Promise<{ok: boolean; message: string}>;
  trial?(signal: AbortSignal): Promise<unknown>;
}

export interface ProviderAccountMetadata {label: string; observedAt: number; expiresAt: number}
export interface ProviderSettingsPublic {
  generation: number;
  revision: number;
  state: 'inactive' | 'switching' | 'ready' | 'failed';
  selected: ProviderConfig['selected'];
  active: ReturnType<typeof toPublicProviderConfig>;
  draft: ReturnType<typeof toPublicProviderConfig>;
  keyConfigured: boolean;
  account: ProviderAccountMetadata | null;
  accountStatus?: 'unknown' | 'checking' | 'ready' | 'signed_out' | 'unavailable';
  recipient: string;
  proxyUrl?: string;
}
export interface ProviderMutation {generation: number; revision: number}
export interface ProviderInlineConsent {kind: 'inline'; generation: number; revision: number}
export interface ProviderSettingsHost {
  workers: readonly ObserverWorker[];
  workerSource?: ObserverWorkerSource;
  status(): ProviderSettingsPublic;
  readProviderSettings(): Promise<ProviderSettingsPublic>;
  saveProviderSettings(input: ProviderMutation & {draft: unknown; secret?: string}): Promise<ProviderSettingsPublic>;
  checkProvider(input: ProviderMutation): Promise<{ok: boolean; stage: 'local' | 'network'; message: string}>;
  trialProvider(input: ProviderMutation): Promise<ProviderSettingsPublic>;
  activateProvider(input: ProviderMutation & {selected?: ProviderConfig['selected']}): Promise<ProviderSettingsPublic>;
  cancelProviderAction(): Promise<ProviderSettingsPublic>;
  providerConsentRequired(input: ProviderMutation & {selected?: ProviderConfig['selected']}): Promise<boolean>;
  startProvider(input: ProviderMutation & {selected: ProviderConfig['selected']; consent: true; draft?: unknown; secret?: string}): Promise<ProviderSettingsPublic>;
  replaceSubscriptionAccount(input: ProviderMutation & {action: 'login' | 'device-auth' | 'logout'}, signal?: AbortSignal): Promise<{outcome: string; account: ProviderAccountMetadata | null}>;
  start(signal: AbortSignal): Promise<void>;
  disable(): void;
  close(): Promise<void>;
}

export interface ObserverProviderHostOptions {
  dataDirectory: string;
  consentProtection: ConsentProtection;
  openSubscription(signal: AbortSignal, consent?: ProviderInlineConsent): Promise<ProviderWorkerOwner>;
  openApi?: (config: ApiConfig, readKey: () => Promise<string | null>, signal: AbortSignal, generation: number) => Promise<ProviderWorkerOwner>;
  readSubscriptionAccount?: (signal: AbortSignal) => Promise<ProviderAccountMetadata>;
  subscriptionAccount?: ObserverAccountSettings;
  autoStartSubscription?: boolean;
  proxyUrl?: string;
  now?: () => number;
  recipient?: string;
}

type PersistedState = {version: 1; generation: number; revision: number; state: 'inactive' | 'switching' | 'ready'; selected: ProviderConfig['selected']};
const initialConfig: ProviderConfig = Object.freeze({version: 1, selected: 'subscription', api: null});
const fixedFailure = (message = 'PROVIDER_ACTION_FAILED'): Error => new Error(message);
const ownerWorkers = (owner:ProviderWorkerOwner|null|undefined): readonly ObserverWorker[] =>
  owner ? [...new Set([...owner.workers,...(owner.workerSource?.all()??[])])] : [];

async function readState(path: string): Promise<PersistedState | null | 'invalid'> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) return 'invalid';
    const file = await open(path, 'r');
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(4097);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > 4096) return 'invalid';
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
    const schema=z.object({version:z.literal(1),generation:z.number().int().nonnegative().safe(),revision:z.number().int().nonnegative().safe(),state:z.enum(['inactive','switching','ready']),selected:z.enum(['subscription','api'])}).strict();
    const parsed=schema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success?parsed.data:'invalid';
  } catch(error) { return (error as NodeJS.ErrnoException).code==='ENOENT'?null:'invalid'; }
}

export async function createObserverProviderHost(options: ObserverProviderHostOptions): Promise<ProviderSettingsHost> {
  await mkdir(options.dataDirectory, {recursive: true});
  const [activeRead, draftRead, storedState] = await Promise.all([
    readProviderConfig(activePath(options.dataDirectory)), readProviderConfig(draftPath(options.dataDirectory)), readState(statePath(options.dataDirectory)),
  ]);
  let active = activeRead ?? initialConfig;
  let draft = draftRead ?? active;
  let generation = storedState !== 'invalid' ? storedState?.generation ?? 0 : 0;
  let revision = storedState !== 'invalid' ? storedState?.revision ?? 0 : 0;
  let state: ProviderSettingsPublic['state'] = 'inactive';
  let account: ProviderAccountMetadata | null = null;
  let accountStatus: NonNullable<ProviderSettingsPublic['accountStatus']> = 'unknown';

  async function readAccount(signal: AbortSignal): Promise<void> {
    if (!options.readSubscriptionAccount) return;
    accountStatus='checking';
    try {
      const value=await options.readSubscriptionAccount(signal);
      signal.throwIfAborted(); account=value; accountStatus='ready';
    } catch(error) {
      account=null;
      accountStatus=error instanceof Error && error.message==='OBSERVER_LOGIN_REQUIRED' ? 'signed_out' : 'unavailable';
      throw error;
    }
  }
  let action: Promise<unknown> | undefined;
  let actionToken: object | undefined;
  let actionController: AbortController | undefined;
  let composedStartBusy = false;
  let composedStartController: AbortController | undefined;
  let composedStartPromise: Promise<ProviderSettingsPublic> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let releasePending: (() => void) | undefined;
  const retained = new Set<ProviderWorkerOwner>();
  let current: ProviderWorkerOwner | null = null;
  let inlineSubscriptionConsent: ProviderInlineConsent | undefined;
  let dispatchGeneration = generation;
  const apiConsentStore: ObserverConsentStore = createObserverConsentStore(join(options.dataDirectory,'observer-api-consent.json'),options.consentProtection);
  const secretStore = createObserverSecretStore(secretPath(options.dataDirectory), options.consentProtection);

  const makeSelection = () => createProviderSelection({
    open: async (config, signal) => config.selected === 'subscription'
      ? options.openSubscription(signal, inlineSubscriptionConsent)
      : options.openApi === undefined ? Promise.reject(fixedFailure('PROVIDER_API_UNAVAILABLE')) : options.openApi(config.api!, async () => {
        const value = await secretStore.read(config.api!.keyRef);
        return value;
      }, signal, generation),
    persist: async () => undefined,
  });
  let selection = makeSelection();

  async function drainSelection(): Promise<void> {
    await selection.close();
    current = null;
    if (!closed) selection = makeSelection();
  }
  async function closeAuxiliary(owner: ProviderWorkerOwner | undefined): Promise<void> {
    if (!owner) return;
    retained.add(owner);
    try { await owner.close(); retained.delete(owner); }
    catch { state = 'failed'; throw fixedFailure('PROVIDER_CLEANUP_FAILED'); }
  }

  async function writeState(value: PersistedState): Promise<void> {
    const path = statePath(options.dataDirectory);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const {rename, rm} = await import('node:fs/promises');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value), 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    }
    finally { await rm(temporary, {force: true}).catch(() => undefined); }
  }

  async function keyConfigured(config: ProviderConfig): Promise<boolean> {
    if (!config.api) return false;
    try { return await secretStore.read(config.api.keyRef) !== null; } catch { return false; }
  }

  async function publicStatus(): Promise<ProviderSettingsPublic> {
    const disclosure = draft.selected === 'api' && draft.api ? (() => { try { const url=new URL(draft.api!.baseUrl); return `${url.origin}${url.pathname} · ${draft.api!.model}`; } catch { return 'API 提供方'; } })() : (options.recipient ?? 'Codex Progress HUD observer');
    return {
      generation, revision, state, selected: active.selected,
      active: toPublicProviderConfig(active, await keyConfigured(active)),
      draft: toPublicProviderConfig(draft, await keyConfigured(draft)),
      keyConfigured: await keyConfigured(active), account, accountStatus,
      recipient: disclosure, ...(options.proxyUrl === undefined ? {} : {proxyUrl: options.proxyUrl}),
    };
  }

  function checkMutation(input: ProviderMutation, internalComposedStart = false): void {
    if (closed) throw fixedFailure('PROVIDER_CLOSED');
    if (retained.size) throw fixedFailure('PROVIDER_CLEANUP_FAILED');
    if (!mutation.safeParse(input).success || input.generation !== generation || input.revision !== revision || actionToken !== undefined || (composedStartBusy && !internalComposedStart)) throw fixedFailure(actionToken === undefined && (!composedStartBusy || internalComposedStart) ? 'PROVIDER_STALE_REVISION' : 'PROVIDER_ACTION_BUSY');
  }

  function acquireAction(): {controller: AbortController; token: object} {
    if (closed) throw fixedFailure('PROVIDER_CLOSED');
    if (retained.size) throw fixedFailure('PROVIDER_CLEANUP_FAILED');
    if (actionToken !== undefined) throw fixedFailure('PROVIDER_ACTION_BUSY');
    const token={}; actionToken=token;
    action = new Promise<void>(resolve => { releasePending = resolve; });
    const controller=new AbortController(); actionController=controller;
    return {controller,token};
  }
  function releaseAction(token: object): void { if(actionToken===token){actionToken=undefined;actionController=undefined;releasePending?.();releasePending=undefined;action=undefined;} }
  async function grantApiConsent(config: ApiConfig): Promise<void> {
    const scope=await apiConsentScope(config);
    const prior=await apiConsentStore.read();
    if(prior?.scope.billingMode==='api'&&apiConsentStore.matches(scope))return;
    await apiConsentStore.grant(scope,options.now?.()??Date.now());
  }
  async function apiConsentScope(config: ApiConfig) {
    const {createHash}=await import('node:crypto');
    const providerFingerprint=createHash('sha256').update(`provider:${config.baseUrl}`).digest('hex');
    const recipientFingerprint=createHash('sha256').update(options.recipient??'Codex Progress HUD observer').digest('hex');
    return observerApiConsentScope({accountFingerprint:providerFingerprint,providerFingerprint,recipientFingerprint,profileId:config.profileId,keyRevision:config.keyRef,endpointFingerprint:providerFingerprint,dataCategories:['goal','conversation','tools']});
  }
  async function providerConsentRequired(input: ProviderMutation & {selected?: ProviderConfig['selected']}): Promise<boolean> {
    if(!mutation.safeParse(input).success || input.generation!==generation || input.revision!==revision)throw fixedFailure('PROVIDER_STALE_REVISION');
    const config=input.selected==='subscription'?initialConfig:draft;
    if(config.selected!=='api'||!(await keyConfigured(config)))return false;
    const scope=await apiConsentScope(config.api!); await apiConsentStore.read();
    return !apiConsentStore.matches(scope);
  }

  function proxy(index: number): ObserverWorker {
    return {
      async observe(input, signal, conversationKey, turnGeneration, onStage) {
        const expected = dispatchGeneration;
        const owner = current;
        const delegate = state === 'ready' ? owner?.workerSource?.acquire(conversationKey) ?? owner?.workers[index] : undefined;
        if (state !== 'ready' || owner === null || delegate === undefined) return {status: 'disabled', interpretation: null, usage: null};
        const result = await delegate.observe(input, signal, conversationKey, turnGeneration, onStage);
        if (owner === current && expected === dispatchGeneration && (result.outcomes?.failureCode === 'unauthorized' || result.outcomes?.failureCode === 'forbidden')) {
          state='failed'; dispatchGeneration=++generation; current=null;
          for (const worker of ownerWorkers(owner)) worker.disable();
          await writeState({version:1,generation,revision,state:'inactive',selected:active.selected}).catch(() => undefined);
        }
        if (expected !== dispatchGeneration || state !== 'ready' || owner !== current) return {...result, status: 'disabled', interpretation: null};
        return result;
      },
      status() {
        const delegate = current?.workers[index];
        if (state !== 'ready' || current === null || delegate === undefined) return {active: false, disabled: true, poisoned: false};
        try { return delegate.status(); } catch { return {active: true, disabled: true, poisoned: true}; }
      },
      disable() { try { current?.workers[index]?.disable(); } catch { /* close owns the failure */ } },
      close: async () => undefined,
      provenance() { return state === 'ready' ? current?.workers[index]?.provenance?.() ?? null : null; },
      recoveryStatus() { return current?.workers[index]?.recoveryStatus?.(); },
    };
  }
  const workers = Object.freeze([proxy(0), proxy(1)]);
  const leases=new Map<string,{owner:ProviderWorkerOwner;delegate:ObserverWorker;proxy:ObserverWorker}>();
  const releasingLeases=new Set<string>();
  const workerSource: ObserverWorkerSource = {
    acquire(key) {
      if(releasingLeases.has(key))throw fixedFailure('PROVIDER_WORKER_CLOSING');
      const owner=current,expected=dispatchGeneration;
      if (state!=='ready'||!owner?.workerSource) throw fixedFailure('PROVIDER_UNAVAILABLE');
      const existing=leases.get(key);
      if(existing?.owner===owner) {
        const status=existing.delegate.status();
        if(status.active||(!status.disabled&&!status.poisoned))return existing.proxy;
        // A failed close retains ownership until the child actually exits.
        // Once inactive, let the runtime replace the unusable delegate.
        leases.delete(key);
      }
      const delegate=owner.workerSource.acquire(key);
      const guarded:ObserverWorker={
        ...delegate,
        async observe(input,signal,conversationKey,turnGeneration,onStage) {
          if(current!==owner||state!=='ready'||expected!==dispatchGeneration)return {status:'disabled',interpretation:null,usage:null};
          const result=await delegate.observe(input,signal,conversationKey,turnGeneration,onStage);
          if(current===owner&&expected===dispatchGeneration&&(result.outcomes?.failureCode==='unauthorized'||result.outcomes?.failureCode==='forbidden')) {
            state='failed';dispatchGeneration=++generation;current=null;
            ownerWorkers(owner).forEach(worker=>worker.disable());
            await writeState({version:1,generation,revision,state:'inactive',selected:active.selected}).catch(()=>undefined);
          }
          return current===owner&&state==='ready'&&expected===dispatchGeneration ? result : {...result,status:'disabled',interpretation:null};
        }
      };
      leases.set(key,{owner,delegate,proxy:guarded});return guarded;
    },
    async release(key) { const lease=leases.get(key);if(!lease||releasingLeases.has(key))return;releasingLeases.add(key);try{await lease.owner.workerSource?.release(key);if(leases.get(key)===lease)leases.delete(key);}finally{releasingLeases.delete(key);} },
    all() { return [...leases.values()].map(lease=>lease.proxy); },
  };

  async function start(signal: AbortSignal): Promise<void> {
    const {controller,token}=acquireAction();
    try {
    const persisted = await readState(statePath(options.dataDirectory));
    if (persisted === 'invalid' || (persisted?.state !== 'ready' && !(persisted === null && options.autoStartSubscription && active.selected === 'subscription'))) { releaseAction(token); return; }
    if (state === 'ready' && current !== null) { releaseAction(token); return; }
    {
      const combined = AbortSignal.any([signal, controller.signal]);
      try {
        if (active.selected === 'subscription') await readAccount(combined);
        if (active.selected === 'api') {
          await apiConsentStore.read();
          if (!active.api || !await keyConfigured(active) || !apiConsentStore.matches(await apiConsentScope(active.api))) return;
        }
        const owner = await selection.select(active, combined).then(() => selection.currentOwner());
        combined.throwIfAborted();
        if (owner === null) throw fixedFailure();
        current = owner as ProviderWorkerOwner;
        dispatchGeneration = ++generation;
        state = 'ready';
      } catch { current = null; state = 'inactive'; dispatchGeneration = ++generation; await drainSelection(); }
    }
    } finally { releaseAction(token); }
  }

  async function saveProviderSettings(input: ProviderMutation & {draft: unknown; secret?: string}, internalComposedStart = false): Promise<ProviderSettingsPublic> {
    checkMutation(input, internalComposedStart);
    const {token}=acquireAction();
    try {
    const parsed = providerDraft.safeParse(input.draft);
    if (!parsed.success) throw fixedFailure('PROVIDER_CONFIG_INVALID');
    const value = parsed.data;
    let next: ProviderConfig;
    if (value.selected === 'subscription') next = {version: 1, selected: 'subscription', api: null};
    else {
      const previous = draft.api;
      const validated = parseProviderConfig({version:1, selected:'api', api:{...value.api,keyRef:`pending-${randomUUID()}`}}).api!;
      const credentialEndpoint = (baseUrl: string): string => {
        const url = new URL(baseUrl); url.pathname = url.pathname.replace(/\/+$/, ''); return url.toString();
      };
      const sameScope = previous?.profileId === validated.profileId && credentialEndpoint(previous.baseUrl) === credentialEndpoint(validated.baseUrl);
      let keyRef = sameScope ? previous!.keyRef : validated.keyRef;
      if (input.secret !== undefined && input.secret.length > 0) keyRef = await secretStore.put(input.secret);
      next = parseProviderConfig({version: 1, selected: 'api', api: {...value.api, keyRef}});
    }
    await saveProviderConfig(draftPath(options.dataDirectory), next);
    draft = next; revision++;
    await writeState({version: 1, generation, revision, state: state === 'ready' ? 'ready' : 'inactive', selected: active.selected});
    return publicStatus();
    } finally { releaseAction(token); }
  }

  async function activateProvider(input: ProviderMutation & {selected?: ProviderConfig['selected']}, internalComposedStart = false): Promise<ProviderSettingsPublic> {
    checkMutation(input, internalComposedStart);
    const next = input.selected === 'subscription' ? initialConfig : draft;
    const {controller,token}=acquireAction();
    const nextGeneration = ++generation;
    dispatchGeneration = nextGeneration;
    state = 'switching'; current = null;
    try {
    await writeState({version: 1, generation, revision, state: 'switching', selected: next.selected});
    const hasKey = next.selected !== 'api' || await keyConfigured(next);
    if (!hasKey) {
      state = 'inactive'; dispatchGeneration = ++generation;
      await writeState({version: 1, generation, revision, state: 'inactive', selected: active.selected});
      throw fixedFailure('PROVIDER_KEY_UNAVAILABLE');
    }
    controller.signal.throwIfAborted();
        if(next.selected==='api') await grantApiConsent(next.api!);
        if (next.selected === 'subscription') await readAccount(controller.signal);
        await selection.select(next, controller.signal);
        controller.signal.throwIfAborted();
        const owner = selection.currentOwner();
        if (owner === null) throw fixedFailure();
        await saveProviderConfig(activePath(options.dataDirectory), next);
        controller.signal.throwIfAborted();
        active = next; revision++;
        controller.signal.throwIfAborted();
        await writeState({version: 1, generation, revision, state: 'ready', selected: active.selected});
        controller.signal.throwIfAborted();
        current = owner as ProviderWorkerOwner; state = 'ready'; dispatchGeneration = generation;
      } catch {
        current = null; state = 'inactive'; dispatchGeneration = ++generation;
        await writeState({version: 1, generation, revision, state: 'inactive', selected: active.selected});
        await drainSelection();
        throw fixedFailure('PROVIDER_ACTIVATION_FAILED');
      } finally { releaseAction(token); }
    return publicStatus();
  }

  function startProvider(input: ProviderMutation & {selected: ProviderConfig['selected']; consent: true; draft?: unknown; secret?: string}): Promise<ProviderSettingsPublic> {
    checkMutation(input);
    if (input.consent !== true) throw fixedFailure('PROVIDER_INLINE_CONSENT_REQUIRED');
    if (composedStartPromise !== undefined) throw fixedFailure('PROVIDER_ACTION_BUSY');
    composedStartBusy = true;
    const controller = new AbortController();
    composedStartController = controller;
    let owned!: Promise<ProviderSettingsPublic>;
    const operation = (async () => {
      if (input.selected === 'api') {
        controller.signal.throwIfAborted();
        const saved = await saveProviderSettings({generation: input.generation, revision: input.revision, draft: input.draft, ...(input.secret === undefined ? {} : {secret: input.secret})}, true);
        controller.signal.throwIfAborted();
        const result = await activateProvider({generation: saved.generation, revision: saved.revision, selected: 'api'}, true);
        controller.signal.throwIfAborted();
        return result;
      }
      const settings = options.subscriptionAccount;
      if (!settings) throw fixedFailure('OBSERVER_SUBSCRIPTION_ACCOUNT_UNAVAILABLE');
      let loginRequired = false;
      accountStatus='checking';
      try {
        const snapshot=await settings.inspect(controller.signal);
        controller.signal.throwIfAborted();
        account={label:snapshot.accountLabel,observedAt:snapshot.evidence.observedAt,expiresAt:snapshot.evidence.expiresAt};accountStatus='ready';
      }
      catch (error) {
        account=null;accountStatus=error instanceof Error && error.message==='OBSERVER_LOGIN_REQUIRED'?'signed_out':'unavailable';
        if (!(error instanceof Error) || error.message !== 'OBSERVER_LOGIN_REQUIRED') throw error;
        loginRequired = true;
      }
      controller.signal.throwIfAborted();
      if (loginRequired) {
        // A credential replacement must never overlap an active observer.
        if (current !== null) {
          const previous = current;
          dispatchGeneration = ++generation; state = 'inactive'; current = null;
          for (const worker of ownerWorkers(previous)) worker.disable();
          await drainSelection();
          controller.signal.throwIfAborted();
          await writeState({version: 1, generation, revision, state: 'inactive', selected: active.selected});
        }
        const outcome = await settings.login(controller.signal);
        controller.signal.throwIfAborted();
        if (outcome !== 'process_exited') throw fixedFailure('OBSERVER_LOGIN_FAILED');
      }
      controller.signal.throwIfAborted();
      const currentStatus = {generation, revision};
      inlineSubscriptionConsent = {kind: 'inline', generation: currentStatus.generation, revision: currentStatus.revision};
      const result = await activateProvider({generation: currentStatus.generation, revision: currentStatus.revision, selected: 'subscription'}, true);
      controller.signal.throwIfAborted();
      return result;
    })();
    owned = operation.finally(() => {
      inlineSubscriptionConsent = undefined;
      if (composedStartController === controller) composedStartController = undefined;
      if (composedStartPromise === owned) composedStartPromise = undefined;
      composedStartBusy = false;
    });
    composedStartPromise = owned;
    return owned;
  }

  async function checkProvider(input: ProviderMutation): Promise<{ok: boolean; stage: 'local' | 'network'; message: string}> {
    checkMutation(input);
    const {controller,token}=acquireAction(); let owner:ProviderWorkerOwner|undefined;
    try {
      if (draft.selected !== 'api' || !(await keyConfigured(draft))) return {ok: false, stage: 'local', message: '本地配置或密钥不可用'};
      if (options.openApi === undefined) return {ok: false, stage: 'local', message: 'API 提供方尚未就绪'};
      owner = await options.openApi(draft.api!, () => secretStore.read(draft.api!.keyRef), controller.signal, generation);
      controller.signal.throwIfAborted();
      const result=owner.check?await owner.check(controller.signal):await owner.inspect(controller.signal).then(()=>({ok:true,message:'本地配置有效，尚未运行推理'})); return {ok: result.ok, stage: owner.check ? 'network' : 'local', message: result.message}; }
    catch { return {ok: false, stage: 'network', message: '连接检查失败，估时保持停用'}; }
    finally { try { await closeAuxiliary(owner); } finally { releaseAction(token); } }
  }

  async function trialProvider(input: ProviderMutation): Promise<ProviderSettingsPublic> {
    checkMutation(input);
    const {controller,token}=acquireAction(); let owner:ProviderWorkerOwner|undefined;
    const previous = current;
    dispatchGeneration = ++generation; state = 'inactive'; current = null;
    try {
      await writeState({version:1,generation,revision,state:'inactive',selected:active.selected});
      for (const worker of ownerWorkers(previous)) worker.disable();
      await drainSelection(); controller.signal.throwIfAborted();
      if (draft.selected !== 'api' || !(await keyConfigured(draft))) throw fixedFailure('PROVIDER_KEY_UNAVAILABLE');
      if (options.openApi === undefined) throw fixedFailure('PROVIDER_API_UNAVAILABLE');
      await grantApiConsent(draft.api!); controller.signal.throwIfAborted(); owner = await options.openApi(draft.api!, () => secretStore.read(draft.api!.keyRef), controller.signal, generation); controller.signal.throwIfAborted(); if (!owner.trial) throw fixedFailure('PROVIDER_TRIAL_UNAVAILABLE'); await owner.trial(controller.signal); return publicStatus(); }
    finally { try { await closeAuxiliary(owner); } finally { releaseAction(token); } }
  }

  async function cancelProviderAction(): Promise<ProviderSettingsPublic> {
    composedStartController?.abort(); actionController?.abort();
    await Promise.all([action?.catch(() => undefined), composedStartPromise?.catch(() => undefined)]);
    action = undefined;
    return publicStatus();
  }

  async function replaceSubscriptionAccount(input: ProviderMutation & {action:'login'|'device-auth'|'logout'}, signal = new AbortController().signal): Promise<{outcome: string; account: ProviderAccountMetadata | null}> {
    checkMutation(input);
    const {controller,token}=acquireAction();
    const previous=current;
    dispatchGeneration=++generation; state='switching'; current=null;
    const settings = options.subscriptionAccount;
    try { await writeState({version:1,generation,revision,state:'switching',selected:active.selected});
      for(const worker of ownerWorkers(previous))worker.disable();
      await drainSelection(); controller.signal.throwIfAborted();
      if (!settings) throw fixedFailure('OBSERVER_SUBSCRIPTION_ACCOUNT_UNAVAILABLE');
      const kind=input.action; const outcome = kind === 'login' ? await settings.login(AbortSignal.any([signal,controller.signal])) : kind === 'device-auth' ? await settings.deviceAuth(AbortSignal.any([signal,controller.signal])) : await settings.logout(AbortSignal.any([signal,controller.signal]));
      if (outcome === 'process_exited' && kind !== 'logout') await readAccount(signal);
      if (kind === 'logout') {account = null; accountStatus=outcome==='process_exited'?'signed_out':'unknown';}
      state='inactive'; await writeState({version:1,generation,revision,state:'inactive',selected:active.selected});
      return {outcome, account};
    } catch(error) { state='inactive'; await writeState({version:1,generation,revision,state:'inactive',selected:active.selected}).catch(()=>undefined); throw error; }
    finally { releaseAction(token); }
  }

  async function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    const previous=current;
    dispatchGeneration=++generation; state='inactive';
    for(const worker of ownerWorkers(previous))worker.disable();
    composedStartController?.abort(); actionController?.abort();
    closing = (async () => { await Promise.all([action?.catch(() => undefined), composedStartPromise?.catch(() => undefined)]); await selection.close(); for (const owner of retained) await closeAuxiliary(owner); current = null; })().finally(() => { closing = undefined; });
    return closing;
  }
  return {workers, workerSource, status: () => ({
    generation, revision, state, selected: active.selected, active: toPublicProviderConfig(active, false), draft: toPublicProviderConfig(draft, false), keyConfigured: false, account, accountStatus,
    recipient: draft.selected==='api'&&draft.api?`${new URL(draft.api.baseUrl).origin}${new URL(draft.api.baseUrl).pathname} · ${draft.api.model}`:(options.recipient ?? 'Codex Progress HUD observer'), ...(options.proxyUrl === undefined ? {} : {proxyUrl: options.proxyUrl}),
  }), readProviderSettings: publicStatus, saveProviderSettings, checkProvider, trialProvider, activateProvider, startProvider, cancelProviderAction, providerConsentRequired, replaceSubscriptionAccount, start,
    disable: () => {dispatchGeneration = ++generation; state = 'inactive'; composedStartController?.abort(); actionController?.abort(); for(const worker of ownerWorkers(current)) worker.disable();}, close};
}
