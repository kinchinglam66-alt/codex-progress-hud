import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {mkdir, open as openFile, readFile} from 'node:fs/promises';
import {z} from 'zod';
import {readObserverPilotConfig,observerPilotEnvironment} from './observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../estimation/observer-identity-runtime.js';
import {openThreadedReleaseAccounting} from '../estimation/accounting-worker-owner.js';
import {createDesktopObserverRuntime, type ObserverInlineConsent} from './observer-runtime.js';
import {createPilotJournal} from '../evaluation/pilot-journal.js';
import {createResidualRuntime} from '../estimation/residual/runtime.js';
import {openResearchBounded,closeResearchBounded} from '../estimation/residual/availability.js';
import type {ObserverConsentDialog} from './observer-consent-dialog.js';
import {createObserverConsentStore,type ConsentProtection} from '../estimation/observer-consent-store.js';
import {createObserverAccountSettings} from './observer-account-settings.js';
import {createObserverProviderHost, type ProviderInlineConsent, type ProviderWorkerOwner} from './observer-provider-host.js';
import type {ObserverScheduler} from '../estimation/observer-scheduler.js';
import type {ObserverWorker, ObserverWorkerSource} from '../estimation/observer-scheduler.js';
import {createObserverApiProvider} from '../estimation/observer-api-provider.js';
import {createObserverApiCompressionAdapter} from '../estimation/observer-api-provider.js';
import {createObserverApiTransport} from './observer-api-transport.js';
import {createApiAccounting, type ApiAccounting} from '../estimation/observer-api-accounting.js';
import {resolveConfiguredCapacity, type ApiConfig, type ProviderConfig} from './observer-provider-config.js';
import {loadObserverApiAssets, loadObserverCompressionAssets} from '../estimation/observer-api-assets.js';
import type {ObserverInput} from '../estimation/observer-contract.js';
import {createContextSummaryCache} from '../estimation/context-preparation.js';
import {serializeCompressionTransport, serializeObserverTransport, serializeSubscriptionTransport, type CompressionRequest} from '../estimation/context-compression.js';
import {createSubscriptionCompressionSession} from '../estimation/subscription-session.js';
import {createOwnedProcessRunner} from '../estimation/owned-process.js';
import {randomUUID} from 'node:crypto';
import type {ContextCapacity, RequestSizer} from '../estimation/context-capacity.js';
import {withContextPreparation, type PreparationConfiguration, type PreparationScope} from '../estimation/context-worker.js';

const rootOwnerSchema=z.object({version:z.literal(1),ownerFingerprint:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const rootOwnerPath=(dataDirectory:string):string=>resolve(dataDirectory,'observer-accounting-root-owner.json');
const SUBSCRIPTION_MODEL='gpt-5.6-luna';
const conservativeByteSizer:RequestSizer={kind:'conservative',count:value=>Buffer.byteLength(value,'utf8')};
// The identity runtime owns the actual argv. This is only a deliberately
// bounded framing policy for planning, never a claim about invocation args.
const SUBSCRIPTION_COMMAND_FRAMING_MAX_BYTES=16_384;
const subscriptionFramingPolicy=JSON.stringify({policy:'trusted-subscription-framing-v1',maxBytes:SUBSCRIPTION_COMMAND_FRAMING_MAX_BYTES});

function subscriptionSizer(assets:{instructions:string;schema:unknown},compressionAssets:{instructions:string;schema:unknown},input:unknown,compression:boolean):string {
  const serialized=serializeSubscriptionTransport(input,{instructions:compression?compressionAssets.instructions:assets.instructions,
    schema:compression?compressionAssets.schema:assets.schema,commandEnvelope:subscriptionFramingPolicy,compression});
  const framingUpperBound=subscriptionFramingPolicy.padEnd(SUBSCRIPTION_COMMAND_FRAMING_MAX_BYTES,' ');
  return [serialized.stdin,serialized.instructions,serialized.schema,framingUpperBound].join('\n');
}

function subscriptionCapacity(contextCapacity: ProviderConfig['contextCapacity']): ContextCapacity|null {
  if (!contextCapacity || !Number.isSafeInteger(contextCapacity.outputReserveTokens) || contextCapacity.outputReserveTokens <= 0) return null;
  return resolveConfiguredCapacity({version:1,selected:'subscription',api:null,
    contextCapacity},SUBSCRIPTION_MODEL,contextCapacity.outputReserveTokens);
}

function inputBudgetBytes(capacity: ContextCapacity|null): number|undefined {
  if (!capacity) return undefined;
  return capacity.requestBytes ?? capacity.contextTokens - capacity.outputReserveTokens;
}

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
  const openSubscription=async(signal:AbortSignal, inlineConsent?:ProviderInlineConsent, contextCapacity?:ProviderConfig['contextCapacity']):Promise<ProviderWorkerOwner>=>{
    if(identityOptions===undefined||accountSettings===undefined)throw Error('OBSERVER_SUBSCRIPTION_UNAVAILABLE');
    const [assets,compressionAssets]=await Promise.all([
      loadObserverApiAssets(options.resourcesDirectory), loadObserverCompressionAssets(options.resourcesDirectory),
    ]);
    const rootOwnerFingerprint=await ensureSubscriptionRootOwner(options.dataDirectory,()=>consentStore.read());
    const account=await accountSettings.inspect(signal);
    const accountingDirectory=subscriptionAccountingDirectory(options.dataDirectory,account.evidence.accountFingerprint,rootOwnerFingerprint);
    const summaryCache=createContextSummaryCache();
    const capacity=subscriptionCapacity(contextCapacity);
    const preparedInputBudgetBytes=inputBudgetBytes(capacity);
    const cacheScope=JSON.stringify(['subscription',account.evidence.accountFingerprint,SUBSCRIPTION_MODEL,
      identityOptions.version,identityOptions.executableSha256??null,identityOptions.proxyUrl]);
    const runtime=createDesktopObserverRuntime({identity:createObserverIdentityRuntime(identityOptions),dialog:options.dialog,
      openAccounting:()=>openThreadedReleaseAccounting(accountingDirectory,Date.now),consentStore,
      contextPreparation:{...(preparedInputBudgetBytes === undefined ? {} : {inputBudgetBytes:preparedInputBudgetBytes}),configure:async(scope,prepareCompression,authorize,owner)=>{
        const runner=createOwnedProcessRunner({...(preparedInputBudgetBytes === undefined ? {} : {inputBudgetBytes:preparedInputBudgetBytes})});
        const view=owner.forConversation(scope.conversationKey);
        const session=createSubscriptionCompressionSession({
          ledger:view,runner,authorize,prepare:async(request,prepareSignal)=>(await prepareCompression(request,prepareSignal)).invocation,
          invocationRecord:admissionId=>({admissionId,conversationKey:scope.conversationKey,turnGeneration:scope.turnGeneration,
            ownerUuid:randomUUID(),providerKind:'subscription',phase:'bound',deadline:Date.now()+60_000,cleanupOutcome:'pending'}),
        });
        return {
          capacity,sizer:conservativeByteSizer,
          serialize:input=>subscriptionSizer(assets,compressionAssets,input,false),
          serializeCompression:request=>subscriptionSizer(assets,compressionAssets,request,true),
          compressor:{summarize:async(request,compressionSignal)=>(await session.summarize(request,compressionSignal)).summary},
          summaryCache,cacheScope,
          close:async()=>{await session.close();},
        };
      }} });
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
  const openApi=async(apiConfig:ApiConfig,readKey:()=>Promise<string|null>,signal:AbortSignal,generation:number, contextCapacity?:ProviderConfig['contextCapacity']):Promise<ProviderWorkerOwner>=>{
    const [assets,compressionAssets]=await Promise.all([
      loadObserverApiAssets(options.resourcesDirectory), loadObserverCompressionAssets(options.resourcesDirectory),
    ]);
    apiAccounting??=createApiAccounting(resolve(options.dataDirectory,'observer-api-accounting.db'),Date.now);
    const transport=createObserverApiTransport(config===null?{}:{proxyUrl:config.proxyUrl});
    const summaryCache=createContextSummaryCache();
    const capacity=resolveConfiguredCapacity({version:1,selected:'api',api:apiConfig,
      ...(contextCapacity===undefined?{}:{contextCapacity})},apiConfig.model,apiConfig.maxOutputTokens);
    const cacheScope=JSON.stringify(['api',apiConfig.profileId,apiConfig.keyRef,apiConfig.baseUrl,apiConfig.model,
      apiConfig.reasoningEffort??null,apiConfig.maxOutputTokens,generation]);
    const make=(retry=true)=>{
      const provider=createObserverApiProvider({config:apiConfig,generation,readKey,transport,accounting:apiAccounting!,instructions:assets.instructions,schema:assets.schema,maxAutoRetries:retry?1:0,retry});
      return withContextPreparation(provider,async(scope)=>{
        const compressor=createObserverApiCompressionAdapter({config:apiConfig,generation,readKey,transport,accounting:apiAccounting!,
          instructions:compressionAssets.instructions,schema:compressionAssets.schema,conversationKey:scope.conversationKey,
          turnGeneration:scope.turnGeneration,sourceEpoch:scope.sourceEpoch,authorize:()=>true});
        const serialize=(input:unknown)=>serializeObserverTransport(input,{model:apiConfig.model,instructions:assets.instructions,
          schema:assets.schema,maxOutputTokens:apiConfig.maxOutputTokens,reasoningEffort:apiConfig.reasoningEffort});
        const serializeCompression=(request:CompressionRequest)=>serializeCompressionTransport(request,{model:apiConfig.model,
          instructions:compressionAssets.instructions,schema:compressionAssets.schema,maxOutputTokens:apiConfig.maxOutputTokens,
          reasoningEffort:apiConfig.reasoningEffort});
        return {capacity,sizer:conservativeByteSizer,serialize,serializeCompression,
          compressor:{summarize:async(request,compressionSignal)=>(await compressor.summarize(request,compressionSignal))},summaryCache,cacheScope,
          close:async()=>{}} satisfies PreparationConfiguration;
      });
    };
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
  const residualResearch=await openResearchBounded(()=>createResidualRuntime(resolve(options.dataDirectory,'residual-research')));
  return {workers:host.workers,workerSource:host.workerSource,onObservation:journal.record,
    ...(residualResearch?{residualResearch}:{}),
    schedulerRecovery:{attachScheduler(scheduler:Pick<ObserverScheduler,'prepareRecovery'|'restoreRecovery'>){attachedScheduler=scheduler;currentRuntime?.schedulerRecovery.attachScheduler(scheduler);}},
    recovery:{status:()=>currentRuntime?.recovery.status()??{state:'unauthorized' as const,revision:0,knownTokens:0,unknown:0,recoveryAllowed:false},preflight:()=>currentRuntime?.recovery.preflight()??Promise.resolve({state:'unauthorized' as const,revision:0,knownTokens:0,unknown:0,recoveryAllowed:false,allowed:false}),confirm:(revision:number)=>currentRuntime?.recovery.confirm(revision)??Promise.reject(new Error('OBSERVER_RECOVERY_UNAVAILABLE')),binding:()=>currentRuntime?.recovery.binding()},
    start:host.start,disable:()=>{host.disable();currentRuntime?.disable();},revokeConsent:async()=>{await currentRuntime?.revokeConsent();},
    providerSettings:host,accountSettings,
    async close(){try{await host.close();await Promise.all([...runtimes].map(runtime=>runtime.close().catch(()=>undefined)));await accountSettings?.close();await apiAccounting?.close();}finally{try{await journal.close();}finally{await closeResearchBounded(residualResearch);}}}};
}
