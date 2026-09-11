import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {mkdir, open as openFile, readFile} from 'node:fs/promises';
import {z} from 'zod';
import {readObserverPilotConfig,observerPilotEnvironment} from './observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../estimation/observer-identity-runtime.js';
import {openThreadedReleaseAccounting} from '../estimation/accounting-worker-owner.js';
import {createDesktopObserverRuntime, type ObserverInlineConsent} from './observer-runtime.js';
import {createPilotJournal} from '../evaluation/pilot-journal.js';
import type {ObserverConsentDialog} from './observer-consent-dialog.js';
import {createObserverConsentStore,type ConsentProtection} from '../estimation/observer-consent-store.js';
import {createObserverAccountSettings} from './observer-account-settings.js';
import {createObserverProviderHost, type ProviderInlineConsent, type ProviderWorkerOwner} from './observer-provider-host.js';
import type {ObserverScheduler} from '../estimation/observer-scheduler.js';
import type {ObserverWorker, ObserverWorkerSource} from '../estimation/observer-scheduler.js';
import {createObserverApiProvider} from '../estimation/observer-api-provider.js';
import {createObserverApiTransport} from './observer-api-transport.js';
import {createApiAccounting, type ApiAccounting} from '../estimation/observer-api-accounting.js';
import type {ApiConfig} from './observer-provider-config.js';
import {loadObserverApiAssets} from '../estimation/observer-api-assets.js';
import type {ObserverInput} from '../estimation/observer-contract.js';

const rootOwnerSchema=z.object({version:z.literal(1),ownerFingerprint:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const rootOwnerPath=(dataDirectory:string):string=>resolve(dataDirectory,'observer-accounting-root-owner.json');

/**
 * The legacy accounting root has one immutable owner. A current consent grant
 * is intentionally not used as the mapping after initialization because
 * account replacement rewrites that grant for the new account.
 */
export async function ensureSubscriptionRootOwner(dataDirectory:string,readGrant:()=>Promise<{scope:{billingMode:string;accountFingerprint?:string}}|null>):Promise<string|null>{
  await mkdir(dataDirectory,{recursive:true});
  const path=rootOwnerPath(dataDirectory);
  try{
    const raw=await readFile(path,'utf8');
    if(Buffer.byteLength(raw,'utf8')>1024)throw Error('OBSERVER_ACCOUNTING_ROOT_OWNER_INVALID');
    const parsed=rootOwnerSchema.safeParse(JSON.parse(raw));
    if(!parsed.success)throw Error('OBSERVER_ACCOUNTING_ROOT_OWNER_INVALID');
    return parsed.data.ownerFingerprint;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  const grant=await readGrant().catch(()=>null);
  const owner=grant?.scope.billingMode==='subscription'&&typeof grant.scope.accountFingerprint==='string'&&/^[a-f0-9]{64}$/.test(grant.scope.accountFingerprint)?grant.scope.accountFingerprint:null;
  let handle;
  try{handle=await openFile(path,'wx');}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const raw=await readFile(path,'utf8');
    const parsed=rootOwnerSchema.safeParse(JSON.parse(raw));
    if(!parsed.success)throw Error('OBSERVER_ACCOUNTING_ROOT_OWNER_INVALID');
    return parsed.data.ownerFingerprint;
  }
  try{await handle.writeFile(JSON.stringify({version:1,ownerFingerprint:owner}),{encoding:'utf8'});}
  finally{await handle.close();}
  return owner;
}

export function subscriptionAccountingDirectory(dataDirectory:string,accountFingerprint:string,rootOwnerFingerprint:string|null):string{
  return rootOwnerFingerprint!==null&&rootOwnerFingerprint===accountFingerprint
    ? resolve(dataDirectory,'observer-accounting')
    : resolve(dataDirectory,'observer-accounting','accounts',accountFingerprint);
}

/** Explicit local pilot opt-in, never configuration taken from a chat/HTTP request.
 * Construction reads settings only. Account/process work begins after HUD readiness. */
export async function loadDesktopObserverPilot(options:{dataDirectory:string;resourcesDirectory:string;dialog:ObserverConsentDialog;environment:NodeJS.ProcessEnv;consentProtection:ConsentProtection}) {
  let config: Awaited<ReturnType<typeof readObserverPilotConfig>>;
  try {
    config=await readObserverPilotConfig(resolve(options.dataDirectory,'observer-pilot.json'));
  } catch (error) {
    // A broken subscription-runtime pin must not prevent API-only setup. The
    // API path has its own config, secret, consent, and transport lifecycle.
    if (!(error instanceof Error) || error.message !== 'OBSERVER_PILOT_CONFIG_INVALID') throw error;
    config=null;
  }
  const systemRoot=options.environment.SystemRoot??options.environment.SYSTEMROOT;
  const identityOptions=config&&systemRoot?{...config,resourcesDirectory:options.resourcesDirectory,
    powershell:resolve(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    environment:observerPilotEnvironment(config,options.environment)}:undefined;
  const accountSettings=identityOptions===undefined?undefined:createObserverAccountSettings({identity:createObserverIdentityRuntime(identityOptions),onDeviceAuth:event=>{
    if(!/^https:\/\/auth\.openai\.com\/codex\/device$/u.test(event.url)||!/^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,2}$/u.test(event.code))return;
    void options.dialog.showMessageBox({type:'question',title:'订阅设备登录',message:'请在浏览器完成订阅设备登录。',detail:`打开 ${event.url}，输入一次性代码 ${event.code}。此代码不会写入估时设置或日志。`,buttons:['知道了'],defaultId:0,cancelId:0,noLink:true});
  }});
  const journal=createPilotJournal(resolve(options.dataDirectory,'pilot-observations'));
  const consentStore=createObserverConsentStore(resolve(options.dataDirectory,'observer-consent.json'),options.consentProtection);
  const runtimes=new Set<ReturnType<typeof createDesktopObserverRuntime>>();
  let attachedScheduler: Pick<ObserverScheduler,'prepareRecovery'|'restoreRecovery'>|undefined;
  let currentRuntime: ReturnType<typeof createDesktopObserverRuntime>|undefined;
  const openSubscription=async(signal:AbortSignal, inlineConsent?:ProviderInlineConsent):Promise<ProviderWorkerOwner>=>{
    if(identityOptions===undefined||accountSettings===undefined)throw Error('OBSERVER_SUBSCRIPTION_UNAVAILABLE');
    const rootOwnerFingerprint=await ensureSubscriptionRootOwner(options.dataDirectory,()=>consentStore.read());
    const account=await accountSettings.inspect(signal);
    const accountingDirectory=subscriptionAccountingDirectory(options.dataDirectory,account.evidence.accountFingerprint,rootOwnerFingerprint);
    const runtime=createDesktopObserverRuntime({identity:createObserverIdentityRuntime(identityOptions),dialog:options.dialog,
      openAccounting:()=>openThreadedReleaseAccounting(accountingDirectory,Date.now),consentStore});
    runtimes.add(runtime);
    try{
      await runtime.start(signal, inlineConsent === undefined ? undefined : {
        kind: 'inline', accountFingerprint: account.evidence.accountFingerprint,
        generation: inlineConsent.generation, revision: inlineConsent.revision,
      } satisfies ObserverInlineConsent);
      if(attachedScheduler)runtime.schedulerRecovery.attachScheduler(attachedScheduler);
      currentRuntime=runtime;
      return {workers:runtime.workers, workerSource:runtime.workerSource, close:async()=>{runtime.disable();await runtime.close();runtimes.delete(runtime);if(currentRuntime===runtime)currentRuntime=undefined;},
        inspect:async inspectSignal=>{const snapshot=await accountSettings.inspect(inspectSignal);return {label:snapshot.accountLabel,fingerprint:snapshot.evidence.accountFingerprint};}};
    }catch(error){runtimes.delete(runtime);await runtime.close().catch(()=>undefined);throw error;}
  };
  let apiAccounting: ApiAccounting|undefined;
  const openApi=async(apiConfig:ApiConfig,readKey:()=>Promise<string|null>,signal:AbortSignal,generation:number):Promise<ProviderWorkerOwner>=>{
    const assets=await loadObserverApiAssets(options.resourcesDirectory);
    apiAccounting??=createApiAccounting(resolve(options.dataDirectory,'observer-api-accounting.db'),Date.now);
    const transport=createObserverApiTransport(config===null?{}:{proxyUrl:config.proxyUrl});
    const make=(retry=true)=>createObserverApiProvider({config:apiConfig,generation,readKey,transport,accounting:apiAccounting!,instructions:assets.instructions,schema:assets.schema,maxAutoRetries:retry?1:0,retry});
    const ownedWorkers = new Set<ObserverWorker>();
    const byConversation = new Map<string, ObserverWorker>();
    const releasing=new Set<string>();
    const workerSource: ObserverWorkerSource = {
      acquire(key) { if(releasing.has(key))throw Error('OBSERVER_WORKER_CLOSING');const existing=byConversation.get(key); if(existing)return existing; const worker=make(); byConversation.set(key,worker); ownedWorkers.add(worker); return worker; },
      async release(key) { const worker=byConversation.get(key); if(!worker||releasing.has(key))return;releasing.add(key);try{await worker.close();if(worker.status().active)throw Error('OBSERVER_WORKER_CLOSE_UNCONFIRMED');if(byConversation.get(key)===worker)byConversation.delete(key);ownedWorkers.delete(worker);}finally{releasing.delete(key);} },
      all() { return [...byConversation.values()]; },
    };
    const fingerprint=createHash('sha256').update(JSON.stringify({profileId:apiConfig.profileId,baseUrl:apiConfig.baseUrl,model:apiConfig.model})).digest('hex');
    const trialInput:ObserverInput={goalSummary:'Synthetic provider trial. Do not use any real conversation context.',activeSeconds:0,runtime:'waiting',messages:[{kind:'user',text:'Return one valid observer response for this synthetic provider trial.',truncated:false}],truncated:false};
    return {workers:workerSource.all(), workerSource, inspect:async inspectSignal=>{inspectSignal.throwIfAborted();return {label:apiConfig.name,fingerprint};},
      check:async checkSignal=>{const key=await readKey();if(!key)return {ok:false,message:'API 密钥不可用'};const response=await transport(apiConfig.baseUrl,{method:'GET',redirect:'error',signal:AbortSignal.any([checkSignal,AbortSignal.timeout(15_000)]),headers:{authorization:`Bearer ${key}`}});await response.body?.cancel().catch(()=>undefined);if(response.status===401||response.status===403)return {ok:false,message:'API 凭据被拒绝，请更新配置'};if(response.status>=500)return {ok:false,message:'API 服务不可用'};return {ok:true,message:`网络已到达（HTTP ${response.status}）；未验证 API 身份或运行推理`};},
      trial:async trialSignal=>{const worker=make(false);ownedWorkers.add(worker);const result=await worker.observe(trialInput,trialSignal,'__provider_trial__');if(result.status!=='interpreted'||result.interpretation===null)throw Error('PROVIDER_TRIAL_FAILED');return result;},
      close:async()=>{ownedWorkers.forEach(worker=>worker.disable());await Promise.all([...ownedWorkers].map(worker=>worker.close()));await transport.close();}};
  };
  const host=await createObserverProviderHost({dataDirectory:options.dataDirectory,consentProtection:options.consentProtection,
    openSubscription,openApi,autoStartSubscription:config!==null, ...(config?.proxyUrl===undefined?{}:{proxyUrl:config.proxyUrl}),
    ...(accountSettings===undefined?{}:{subscriptionAccount:accountSettings,readSubscriptionAccount:async signal=>{const snapshot=await accountSettings.inspect(signal);return {label:snapshot.accountLabel,observedAt:snapshot.evidence.observedAt,expiresAt:snapshot.evidence.expiresAt};}})});
  return {workers:host.workers,workerSource:host.workerSource,onObservation:journal.record,
    schedulerRecovery:{attachScheduler(scheduler:Pick<ObserverScheduler,'prepareRecovery'|'restoreRecovery'>){attachedScheduler=scheduler;currentRuntime?.schedulerRecovery.attachScheduler(scheduler);}},
    recovery:{status:()=>currentRuntime?.recovery.status()??{state:'unauthorized' as const,revision:0,knownTokens:0,unknown:0,recoveryAllowed:false},preflight:()=>currentRuntime?.recovery.preflight()??Promise.resolve({state:'unauthorized' as const,revision:0,knownTokens:0,unknown:0,recoveryAllowed:false,allowed:false}),confirm:(revision:number)=>currentRuntime?.recovery.confirm(revision)??Promise.reject(new Error('OBSERVER_RECOVERY_UNAVAILABLE')),binding:()=>currentRuntime?.recovery.binding()},
    start:host.start,disable:()=>{host.disable();currentRuntime?.disable();},revokeConsent:async()=>{await currentRuntime?.revokeConsent();},
    providerSettings:host,accountSettings,
    async close(){try{await host.close();await Promise.all([...runtimes].map(runtime=>runtime.close().catch(()=>undefined)));await accountSettings?.close();await apiAccounting?.close();}finally{await journal.close();}}};
}
