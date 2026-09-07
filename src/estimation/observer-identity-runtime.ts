import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {observerReleaseFiles} from './observer-release-files.js';
import {observerHomeProfile,OBSERVER_HOME_SCRIPT_SHA256} from './observer-home-assets.js';
import {createObserverHomeManager} from './observer-home.js';
import {createOwnedProcessRunner,type Invocation} from './owned-process.js';
import {createObserverRuntimeProbe} from './codex-probe.js';
import {createRuntimePreflightCache} from './codex-preflight.js';
import {buildObserverSetupInvocation,buildObserverCodexInvocation} from './codex-invocation.js';
import type {ObserverInput} from './observer-contract.js';
import {createObserverAccountReader,type AccountReadDiagnostic} from './observer-account-reader.js';
import type {ObserverAttestation} from './observer-consent.js';
import type {ForecastVersions} from './forecast-record.js';
import {OBSERVER_INPUT_FACTS_VERSION} from './observer-input.js';
import {ObserverAccountTimeout,ObserverPreDispatchTransient} from './observer-call-failure.js';

type PreparationStage='home-prepare'|'runtime-preflight'|'account-read'|'home-recheck'|'binding'|'ready';
export interface PreparationDiagnostic {stage:PreparationStage;outcome:'passed'|'failed'|'reader';elapsedMs:number;reader?:AccountReadDiagnostic}
interface Options {
  resourcesDirectory:string;parentDirectory:string;powershell:string;
  executable:string;cwd:string;version:string;executableSha256?:string|undefined;environment?:NodeJS.ProcessEnv;now?:()=>number;
  onDiagnostic?:(value:PreparationDiagnostic)=>void;
}
interface Snapshot {accountLabel:string;evidence:ObserverAttestation}
interface PreparedEstimate extends Snapshot {invocation:Invocation;provenance?:ForecastVersions}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Desktop-private composition. Reads only isolated configuration/account metadata;
 * no login, model dispatch or consent grant is implicit in inspection. */
export function createObserverIdentityRuntime(options:Options) {
  const config=Object.freeze({...options});
  const env={...(options.environment??process.env)};
  const now=options.now??Date.now;
  const files=observerReleaseFiles(config.resourcesDirectory,config.executable,config.cwd,config.version,config.executableSha256);
  const runtimeCache=createRuntimePreflightCache(files);
  const homeConfig=observerHomeProfile(config.resourcesDirectory,config.parentDirectory,config.powershell);
  const assetsFingerprint=digest(['observer-assets-v1',files.executableSha256,files.schemaSha256,files.instructionsSha256,OBSERVER_HOME_SCRIPT_SHA256]);
  let disabled=false,poisoned=false,pending:Promise<Snapshot|Invocation|PreparedEstimate>|undefined,closing:Promise<void>|undefined;
  let cancel:(()=>void)|undefined,owned:(()=>boolean)|undefined;
  const fail=()=>Error('OBSERVER_IDENTITY_UNAVAILABLE');
  const disable=()=>{disabled=true;runtimeCache.invalidate();cancel?.();};
    function perform(signal:AbortSignal,mode:'inspect'|'login'|ObserverInput):Promise<Snapshot|Invocation|PreparedEstimate> {
      const loginMode=mode==='login';
      if(disabled || poisoned || pending || signal.aborted) return Promise.reject(fail());
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      const home=createObserverHomeManager(homeConfig);
      const runner=createOwnedProcessRunner({timeoutMs:5000});
      let reader:ReturnType<typeof createObserverAccountReader>|undefined;
      const cancelOwners=()=>{controller.abort();home.disable();runner.disable();reader?.disable();};
      const ownersBusy=()=>home.status().active || home.status().poisoned || runner.status().active || runner.status().poisoned || (reader!==undefined && reader.ownership()!=='idle');
      cancel=cancelOwners;owned=ownersBusy;
      const abort=()=>{home.disable();runner.disable();reader?.disable();};
      combined.addEventListener('abort',abort,{once:true});
      const check=()=>{if(disabled || combined.aborted)throw fail();};
      pending=Promise.resolve().then(async()=>{
        let stage:PreparationStage='home-prepare';
        const startedAt=performance.now();
        const emit=(outcome:PreparationDiagnostic['outcome'],detail?:AccountReadDiagnostic)=>{
          try{config.onDiagnostic?.({stage,outcome,elapsedMs:Math.round(performance.now()-startedAt),...(detail?{reader:detail}:{})});}catch{/* No diagnostic can authorize or reject work. */}
        };
        try {
          check();const observedAt=now();
          if(!Number.isSafeInteger(observedAt) || observedAt<0 || !Number.isSafeInteger(observedAt+300000))throw fail();
          const authHome=await home.prepare(false,combined);check();
          emit('passed');stage='runtime-preflight';
          const probe=createObserverRuntimeProbe(env,authHome,runner);
          const profile=await runtimeCache.check(probe.probe);check();
          if(profile.version!==config.version)throw fail();
          emit('passed');stage='account-read';
          const setupInvocation=buildObserverSetupInvocation(profile,'metadata',env,authHome);
          reader=createObserverAccountReader(()=>spawn(setupInvocation.executable,setupInvocation.args,{cwd:setupInvocation.cwd,env:setupInvocation.env,windowsHide:true,stdio:['pipe','pipe','pipe']}),undefined,detail=>emit('reader',detail));
          let account;
          try {account=await reader.read(combined);}
          catch(error) {if(!loginMode || !(error instanceof Error) || error.message!=='OBSERVER_LOGIN_REQUIRED')throw error;}
          check();
          emit('passed');stage='home-recheck';
          await home.prepare(true,combined);check();
          emit('passed');stage='binding';
          const completedAt=now();
          if(!Number.isSafeInteger(completedAt) || completedAt<observedAt || completedAt>=observedAt+300000 || ownersBusy())throw fail();
          stage='ready';emit('passed');
          if(loginMode)return buildObserverSetupInvocation(profile,'login',env,authHome);
          if(!account)throw fail();
          const snapshot:Snapshot={accountLabel:account.email && account.email.length<=256?account.email:`ChatGPT (${account.planType})`,
            evidence:{accountFingerprint:digest(['observer-account-v1',account.accountId]),routeFingerprint:account.routeFingerprint,
              assetsFingerprint,observedAt,expiresAt:observedAt+300000}};
          if(typeof mode!=='object')return snapshot;
          const invocation=buildObserverCodexInvocation(profile,mode,env,authHome);
          const modelIndex=invocation.args.indexOf('--model');
          const model=modelIndex>=0?invocation.args[modelIndex+1]:undefined;
          const effortArg=invocation.args.find(arg=>arg.startsWith('model_reasoning_effort='));
          let effort:string|undefined;
          if(effortArg){try{const value=JSON.parse(effortArg.slice('model_reasoning_effort='.length));if(typeof value==='string')effort=value;}catch{/* Missing effort omits research provenance. */}}
          const modelVersion=typeof model==='string'&&typeof effort==='string'?`${model}-${effort}`:undefined;
          return {...snapshot,invocation,...(typeof modelVersion==='string'&&modelVersion.length<=128?{provenance:{
            input:OBSERVER_INPUT_FACTS_VERSION,prompt:files.instructionsSha256,model:modelVersion,algorithm:'pace-v1'}}:{} )};
        } catch(error) {
          runtimeCache.invalidate();
          emit('failed');
          if(!combined.aborted && !disabled && !ownersBusy() && error instanceof Error && error.message==='OBSERVER_LOGIN_REQUIRED')throw error;
          if(typeof mode==='object' && stage==='account-read' && !combined.aborted && !disabled && !ownersBusy()
            && error instanceof ObserverAccountTimeout)throw new ObserverPreDispatchTransient();
          throw fail();
        } finally {
          combined.removeEventListener('abort',abort);
          cancelOwners();
          if(ownersBusy())poisoned=true;
          else {cancel=undefined;owned=undefined;}
        }
      }).finally(()=>{pending=undefined;});
      return pending;
    }
  return {
    inspect:(signal:AbortSignal)=>perform(signal,'inspect') as Promise<Snapshot>,
    prepareLogin:(signal:AbortSignal)=>perform(signal,'login') as Promise<Invocation>,
    prepareEstimate:(input:ObserverInput,signal:AbortSignal)=>perform(signal,input) as Promise<PreparedEstimate>,
    disable,
    close():Promise<void> {
      if(closing)return closing;
      disable();const operation=pending;
      closing=(async()=>{await operation?.catch(()=>undefined);if(poisoned || owned?.())throw Error('OBSERVER_IDENTITY_CLOSE_UNCONFIRMED');})();
      return closing;
    },
  };
}
