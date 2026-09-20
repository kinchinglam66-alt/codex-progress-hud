import {createHash} from 'node:crypto';
import {identityPreparationCode,identityPreparationError,type IdentityPreparationCode} from './identity-preparation-error.js';
import {spawn} from 'node:child_process';
import {observerReleaseFiles} from './observer-release-files.js';
import {observerHomeProfile,OBSERVER_HOME_SCRIPT_SHA256} from './observer-home-assets.js';
import {createObserverHomeManager} from './observer-home.js';
import {createReusableHomeCheck} from './reusable-home-check.js';
import {createOwnedProcessRunner,type Invocation} from './owned-process.js';
import {createObserverRuntimeProbe} from './codex-probe.js';
import {createRuntimePreflightCache} from './codex-preflight.js';
import {buildObserverSetupInvocation,buildObserverExternalInvocation,buildObserverCodexInvocation,buildObserverCompressionInvocation} from './codex-invocation.js';
import {createMainAccountMetadataReader} from './main-account-metadata.js';
import type {MainAccountSource} from './main-account-lease.js';
import type {MainAccountSessionTransport} from './main-account-session-transport.js';
import type {ObserverInput} from './observer-contract.js';
import {validateCompressionRequest, type CompressionRequest} from './context-compression.js';
import {createObserverAccountReader,type AccountReadDiagnostic} from './observer-account-reader.js';
import type {ObserverAttestation} from './observer-consent.js';
import type {ForecastVersions} from './forecast-record.js';
import {OBSERVER_INPUT_FACTS_VERSION} from './observer-input.js';
import {ObserverAccountTimeout,ObserverPreDispatchTransient} from './observer-call-failure.js';
import {AccountInspectionFailure} from './account-inspection-failure.js';
import {createSessionAccountReuseIssuer,type SessionAccountReuse} from './session-account-reuse.js';
import {captureObserverIdentityFiles} from './observer-identity-files.js';
import {createAccountAttestationCache,type AccountAttestationCacheDiagnostics,type AccountAttestationCacheValue,type SessionPreparationPolicy} from './account-attestation-cache.js';

type SetupAction='login'|'device-auth'|'logout';
type PreparationStage='home-prepare'|'runtime-preflight'|'account-read'|'home-recheck'|'binding'|'ready';
export interface PreparationDiagnostic {stage:PreparationStage;outcome:'passed'|'failed'|'reader';elapsedMs:number;reader?:AccountReadDiagnostic;accountCache?:AccountAttestationCacheDiagnostics}
interface Options {
  mainAccountSource?:MainAccountSource;
  reuseHomeCheckProcess?:boolean;
  resourcesDirectory:string;parentDirectory:string;powershell:string;
  executable:string;cwd:string;version:string;executableSha256?:string|undefined;environment?:NodeJS.ProcessEnv;now?:()=>number;monotonicNow?:()=>number;
  onDiagnostic?:(value:PreparationDiagnostic)=>void;
}
interface Snapshot {accountLabel:string;evidence:ObserverAttestation}
interface PreparedEstimate extends Snapshot {invocation:Invocation;mainAccountSession?:MainAccountSessionTransport;provenance?:ForecastVersions;reuse?:SessionAccountReuse;validateAcceptance?:(signal:AbortSignal)=>Promise<boolean>}
interface CachedSession extends AccountAttestationCacheValue {
  snapshot:Snapshot;
  invocation:Invocation;
  authHome:string;
  identityFiles:string;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copyInvocation=(value:Invocation):Invocation=>({...value,args:[...value.args],env:{...value.env}});

/** Desktop-private composition. Reads only isolated configuration/account metadata;
 * no login, model dispatch or consent grant is implicit in inspection. */
export function createObserverIdentityRuntime(options:Options) {
  const config=Object.freeze({...options});
  const env={...(options.environment??process.env)};
  const now=options.now??Date.now;
  const monotonicNow=options.monotonicNow??(()=>performance.now());
  const files=observerReleaseFiles(config.resourcesDirectory,config.executable,config.cwd,config.version,config.executableSha256);
  const runtimeCache=createRuntimePreflightCache(files);
  const homeConfig=observerHomeProfile(config.resourcesDirectory,config.parentDirectory,config.powershell);
  const assetsFingerprint=digest(['observer-assets-v1',files.executableSha256,files.schemaSha256,files.instructionsSha256,
    files.compressionSchemaSha256,files.compressionInstructionsSha256,OBSERVER_HOME_SCRIPT_SHA256]);
  const reuseIssuer=createSessionAccountReuseIssuer({now,monotonicNow});
  const accountCache=createAccountAttestationCache<CachedSession>({now,monotonicNow});
  let lastIdentity:{accountFingerprint:string;routeFingerprint:string;assetsFingerprint:string}|undefined;
  let preparationEpoch=0;
  let disabled=false,poisoned=false,pending:Promise<Snapshot|Invocation|PreparedEstimate>|undefined,closing:Promise<void>|undefined;
  let cancel:(()=>void)|undefined,owned:(()=>boolean)|undefined;
  let localValidationPending:Promise<boolean>|undefined,localValidationCancel:(()=>void)|undefined;
  const sharedHome=config.reuseHomeCheckProcess===true?createReusableHomeCheck(homeConfig):undefined;
  let homeRetirement:Promise<void>|undefined;
  const retireHome=():Promise<void>=>{
    if(!sharedHome)return Promise.resolve();
    if(homeRetirement)return homeRetirement;
    const retirement=sharedHome.retire().catch(()=>{poisoned=true;}).finally(()=>{
      if(homeRetirement===retirement)homeRetirement=undefined;
    });
    homeRetirement=retirement;return retirement;
  };
  // A lease ending is not a process ending. Cancellation/invalidation retires
  // the shared owner explicitly; successful local checks release only activity.
  const homeLease=()=>sharedHome?{
    prepare:(verifyOnly:boolean,signal:AbortSignal)=>sharedHome.check(verifyOnly,signal),
    disable(){},
    status(){const status=sharedHome.status();return {active:status.checking||status.closing,poisoned:status.poisoned};},
  }:createObserverHomeManager(homeConfig);
  const fail=()=>Error('OBSERVER_IDENTITY_UNAVAILABLE');
  const invalidateSessionReuse=()=>{preparationEpoch++;reuseIssuer.invalidate();accountCache.invalidate('explicit');localValidationCancel?.();cancel?.();void retireHome();};
  const invalidateAttestation=(reason:'explicit'|'local-guard-failed'|'cancelled'='explicit')=>{reuseIssuer.invalidate();accountCache.invalidate(reason);};
  const disable=()=>{disabled=true;runtimeCache.invalidate();invalidateSessionReuse();localValidationCancel?.();cancel?.();};
  const validateLocalIdentity=(expected:{authHome:string;identityFiles:string},localSignal:AbortSignal,mode:'request'|'cache'='request'):Promise<boolean>=>{
    if(disabled||localSignal.aborted||(mode==='request'&&(pending!==undefined||localValidationPending!==undefined)))return Promise.resolve(false);
    const guardController=new AbortController();
    const combinedGuard=AbortSignal.any([localSignal,guardController.signal]);
    const guardHome=homeLease();
    const guardRunner=createOwnedProcessRunner({timeoutMs:5000});
    let guardProbe:ReturnType<typeof createObserverRuntimeProbe>|undefined;
    const cancelGuard=()=>{guardController.abort();guardProbe?.disable();guardHome.disable();guardRunner.disable();void retireHome();};
    localValidationCancel=cancelGuard;
    let operation!:Promise<boolean>;
    operation=(async()=>{
      let valid=false;
      try {
        await homeRetirement;
        if(poisoned||combinedGuard.aborted)throw Error();
        const guardAuthHome=await guardHome.prepare(false,combinedGuard);
        if(guardAuthHome!==expected.authHome||combinedGuard.aborted)throw Error();
        if(await captureObserverIdentityFiles(guardAuthHome)!==expected.identityFiles)throw Error();
        guardProbe=createObserverRuntimeProbe(env,guardAuthHome,guardRunner);
        const guardProfile=await runtimeCache.check(guardProbe.probe);
        if(guardProfile.version!==config.version)throw Error();
        const verifiedHome=await guardHome.prepare(true,combinedGuard);
        if(verifiedHome!==expected.authHome||combinedGuard.aborted)throw Error();
        if(await captureObserverIdentityFiles(verifiedHome)!==expected.identityFiles)throw Error();
        const homeStatus=guardHome.status(),runnerStatus=guardRunner.status();
        valid=!disabled&&!combinedGuard.aborted&&!homeStatus.active&&!homeStatus.poisoned&&
          !runnerStatus.active&&!runnerStatus.poisoned;
      } catch { valid=false; }
      finally {
        if(!valid)await retireHome();
        const homeStatus=guardHome.status(),runnerStatus=guardRunner.status();
        if(homeStatus.poisoned||runnerStatus.poisoned)poisoned=true;
        guardProbe?.disable();guardHome.disable();guardRunner.disable();
        if(localValidationPending===operation)localValidationPending=undefined;
        if(localValidationCancel===cancelGuard)localValidationCancel=undefined;
      }
      return valid;
    })();
    localValidationPending=operation;
    return operation.then(valid=>{
      if(!valid){
        reuseIssuer.invalidate();
        if(mode==='request')accountCache.invalidate(localSignal.aborted?'cancelled':'local-guard-failed');
      }
      return valid;
    });
  };
  const acceptanceGuard=(expected:{authHome:string;identityFiles:string})=>{
    const epoch=preparationEpoch,identityBinding=JSON.stringify(lastIdentity);
    const bindingValid=()=>lastIdentity!==undefined&&JSON.stringify(lastIdentity)===identityBinding;
    return async(signal:AbortSignal):Promise<boolean>=>{
      if(disabled||poisoned||signal.aborted||epoch!==preparationEpoch||!bindingValid())return false;
      const valid=await validateLocalIdentity(expected,signal);
      return valid&&!disabled&&!poisoned&&!signal.aborted&&epoch===preparationEpoch&&bindingValid();
    };
  };
    function perform(signal:AbortSignal,mode:'inspect'|'session'|'cleanup'|SetupAction|ObserverInput|CompressionRequest,policy?:SessionPreparationPolicy):Promise<Snapshot|Invocation|PreparedEstimate> {
      const setupMode=mode==='login'||mode==='device-auth'||mode==='logout';
      if(config.mainAccountSource&&(setupMode||typeof mode==='object'))return Promise.reject(Error(setupMode?'MAIN_ACCOUNT_MANAGED_BY_CODEX':'MAIN_ACCOUNT_REQUIRES_PERSISTENT_SESSION'));
      const loginMode=mode==='login'||mode==='device-auth';
      const allowAccountCache=!config.mainAccountSource&&mode==='session'&&policy?.accountCache==='allow';
      if(disabled || poisoned || pending || localValidationPending || signal.aborted) return Promise.reject(fail());
      const preparationEpochAtStart=preparationEpoch;
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      const home=homeLease();
      const runner=createOwnedProcessRunner({timeoutMs:5000});
      let reader:ReturnType<typeof createObserverAccountReader>|undefined;
      let mainReader:ReturnType<typeof createMainAccountMetadataReader>|undefined;
      const cancelOwners=(retireShared=true)=>{controller.abort();home.disable();runner.disable();reader?.disable();mainReader?.disable();if(retireShared)void retireHome();};
      const ownersBusy=()=>home.status().active || home.status().poisoned || runner.status().active || runner.status().poisoned || (reader!==undefined && reader.ownership()!=='idle') || (mainReader!==undefined&&mainReader.ownership()!=='idle');
      cancel=cancelOwners;owned=ownersBusy;
      const abort=()=>{home.disable();runner.disable();reader?.disable();mainReader?.disable();void retireHome();};
      combined.addEventListener('abort',abort,{once:true});
      const check=()=>{if(disabled || poisoned || combined.aborted)throw fail();};
      if(setupMode)invalidateAttestation('explicit');
      pending=Promise.resolve().then(async()=>{
        let identityWorkStarted=false;
        let cachePublicationGeneration=accountCache.generation();
        let stage:PreparationStage='home-prepare';
        let accountAttempts=0;
        let readerDiagnostic:import('./account-inspection-failure.js').AccountInspectionDiagnostic['reader'];
        const startedAt=performance.now();
        const checkPreparationEpoch=()=>{check();if(preparationEpoch!==preparationEpochAtStart)throw fail();};
        const emit=(outcome:PreparationDiagnostic['outcome'],detail?:AccountReadDiagnostic,checkEpoch=true)=>{
          try{config.onDiagnostic?.({stage,outcome,elapsedMs:Math.round(performance.now()-startedAt),accountCache:accountCache.diagnostics(),...(detail?{reader:detail}:{})});}catch{/* No diagnostic can authorize or reject work. */}
          if(checkEpoch)checkPreparationEpoch();
        };
        try {
          await homeRetirement;
          if(setupMode)await retireHome();
          if(poisoned)throw fail();
          check();const observedAt=now(),observedMonotonic=monotonicNow();
          if(!Number.isSafeInteger(observedAt) || observedAt<0 || !Number.isSafeInteger(observedAt+300000))throw fail();
          if(allowAccountCache){
            const hit=await accountCache.acquire(combined,(cached,localSignal)=>validateLocalIdentity({authHome:cached.authHome,identityFiles:cached.identityFiles},localSignal,'cache'));
            checkPreparationEpoch();
            if(hit){
              if(combined.aborted||accountCache.generation()!==hit.generation)throw fail();
              const cached=hit.value;
              const snapshot=Object.freeze({accountLabel:cached.snapshot.accountLabel,evidence:Object.freeze({...cached.snapshot.evidence})});
              emit('passed');stage='ready';emit('passed');
              checkPreparationEpoch();
              const reuse=reuseIssuer.issue({observedAt:hit.observedAt,observedMonotonic:hit.observedMonotonic,expiresAt:hit.expiresAt,
                validateLocal:localSignal=>validateLocalIdentity({authHome:cached.authHome,identityFiles:cached.identityFiles},localSignal)});
              checkPreparationEpoch();
              return {...snapshot,invocation:copyInvocation(cached.invocation),reuse,
                validateAcceptance:acceptanceGuard({authHome:cached.authHome,identityFiles:cached.identityFiles})};
            }
            const missReason=accountCache.diagnostics().lastMissReason;
            if(missReason!=='generation-fenced'&&missReason!=='cancelled'&&missReason!=='explicit')
              cachePublicationGeneration=accountCache.generation();
          }
          const authHome=await home.prepare(false,combined);checkPreparationEpoch();
          emit('passed');stage='runtime-preflight';
          const probe=createObserverRuntimeProbe(env,authHome,runner);
          const profile=await runtimeCache.check(probe.probe);checkPreparationEpoch();
          if(profile.version!==config.version)throw fail();
          emit('passed');stage=mode==='cleanup'?'home-recheck':'account-read';
          let account;
          let mainFingerprint:string|undefined;
          let mainAccountSession:MainAccountSessionTransport|undefined;
          let identityFilesBefore:string|null=null;
          let identityFilesAfter:string|null=null;
          if(mode!=='logout'&&mode!=='cleanup') {
            identityWorkStarted=true;
            if(mode==='session'){identityFilesBefore=await captureObserverIdentityFiles(authHome);checkPreparationEpoch();}
            if(config.mainAccountSource){
              accountAttempts++;
              mainReader=createMainAccountMetadataReader({invocation:buildObserverExternalInvocation(profile,env,authHome),source:config.mainAccountSource,
                ...(mode==='session'&&policy?.openMainAccountSession?{openMainAccountSession:policy.openMainAccountSession}:{})});
              const metadata=await mainReader.read(combined);checkPreparationEpoch();
              mainAccountSession=metadata.mainAccountSession;
              mainFingerprint=metadata.accountFingerprint;
              account={accountId:metadata.accountFingerprint,email:metadata.accountLabel,planType:'unknown',routeFingerprint:metadata.routeFingerprint};
            }else{
            const setupInvocation=buildObserverSetupInvocation(profile,'metadata',env,authHome);
            for (;;) {
              check();accountAttempts++;readerDiagnostic=undefined;
              reader=createObserverAccountReader(()=>spawn(setupInvocation.executable,setupInvocation.args,{cwd:setupInvocation.cwd,env:setupInvocation.env,windowsHide:true,stdio:['pipe','pipe','pipe']}),undefined,detail=>{
                if(['passed','login_required','timeout','cancelled','rpc_error','read_failed'].includes(detail.reason)&&
                  Number.isInteger(detail.phase)&&detail.phase>=0&&detail.phase<=11)
                  readerDiagnostic=Object.freeze({reason:detail.reason,phase:detail.phase});
                emit('reader',detail);
              });
              try {account=await reader.read(combined);checkPreparationEpoch();break;}
              catch(error) {
                if(loginMode && error instanceof Error && error.message==='OBSERVER_LOGIN_REQUIRED')break;
                // Only metadata inspection can retry here. A trusted timeout is
                // emitted by the reader only after its child has actually closed.
                if(mode!=='inspect'||!(error instanceof ObserverAccountTimeout)||accountAttempts>=3||
                  disabled||combined.aborted||ownersBusy())throw error;
                await new Promise<void>((resolve,reject)=>{
                  const cancelled=()=>{clearTimeout(timer);combined.removeEventListener('abort',cancelled);reject(fail());};
                  const timer=setTimeout(()=>{combined.removeEventListener('abort',cancelled);resolve();},accountAttempts===1?1000:3000);
                  combined.addEventListener('abort',cancelled,{once:true});
                  if(combined.aborted)cancelled();
                });
                checkPreparationEpoch();
              }
            }
            }
            if(mode==='session'&&account){identityFilesAfter=await captureObserverIdentityFiles(authHome);checkPreparationEpoch();}
          }
          checkPreparationEpoch();
          if(mode!=='cleanup')emit('passed');stage='home-recheck';
          await home.prepare(true,combined);checkPreparationEpoch();
          if(mode==='session'&&identityFilesAfter!==null){
            const finalIdentityFiles=await captureObserverIdentityFiles(authHome);checkPreparationEpoch();
            if(identityFilesAfter!==finalIdentityFiles)identityFilesAfter=null;
          }
          emit('passed');stage='binding';
          const completedAt=now();checkPreparationEpoch();
          if(!Number.isSafeInteger(completedAt) || completedAt<observedAt || completedAt>=observedAt+300000 || ownersBusy())throw fail();
          stage='ready';emit('passed');
          if(setupMode)return buildObserverSetupInvocation(profile,mode,env,authHome);
          if(mode==='cleanup'){
            const invocation=buildObserverSetupInvocation(profile,'metadata',env,authHome);
            return {...invocation,args:[...invocation.args,'-c','features.goals=false','-c','features.tool_suggest=false',
              '-c','features.in_app_local_automation=false']};
          }
          if(!account)throw fail();
          const snapshot:Snapshot={accountLabel:account.email && account.email.length<=256?account.email:`ChatGPT (${account.planType})`,
            evidence:{accountFingerprint:mainFingerprint??digest(['observer-account-v1',account.accountId]),routeFingerprint:account.routeFingerprint,
              assetsFingerprint,observedAt,expiresAt:observedAt+300000}};
          const identityChanged=lastIdentity!==undefined &&
            (lastIdentity.accountFingerprint!==snapshot.evidence.accountFingerprint||
              lastIdentity.routeFingerprint!==snapshot.evidence.routeFingerprint||
              lastIdentity.assetsFingerprint!==snapshot.evidence.assetsFingerprint);
          if(identityChanged){invalidateAttestation('explicit');cachePublicationGeneration=accountCache.generation();await retireHome();checkPreparationEpoch();}
          lastIdentity={accountFingerprint:snapshot.evidence.accountFingerprint,
            routeFingerprint:snapshot.evidence.routeFingerprint,assetsFingerprint:snapshot.evidence.assetsFingerprint};
          if(mode==='session') {
            const sessionInvocation=mainAccountSession?.invocation??(config.mainAccountSource?buildObserverExternalInvocation(profile,env,authHome):buildObserverSetupInvocation(profile,'metadata',env,authHome));
            if(config.mainAccountSource){
              const source=config.mainAccountSource,expected=mainFingerprint;
              const guard=identityFilesBefore!==null&&identityFilesBefore===identityFilesAfter?acceptanceGuard({authHome,identityFiles:identityFilesBefore}):undefined;
              const validateAcceptance=async(acceptanceSignal:AbortSignal)=>{
                try{return !!guard&&await guard(acceptanceSignal)&&(await source.inspect(acceptanceSignal)).accountFingerprint===expected&&!acceptanceSignal.aborted;}
                catch{return false;}
              };
              // Same-request proof only: never publish main-account evidence to
              // the cross-request cache. Each claim/dispatch still checks the
              // current source identity and the isolated runtime custody.
              const reuse=guard?reuseIssuer.issue({observedAt,observedMonotonic,expiresAt:snapshot.evidence.expiresAt,
                validateLocal:validateAcceptance}):undefined;
              return {...snapshot,invocation:sessionInvocation,validateAcceptance,...(reuse?{reuse}:{}),...(mainAccountSession?{mainAccountSession}:{})};
            }
            let reuse:SessionAccountReuse|undefined;
            if(identityFilesBefore!==null&&identityFilesBefore===identityFilesAfter) {
              const expectedIdentityFiles=identityFilesAfter;
              if(allowAccountCache){
                const cachedValue:CachedSession={snapshot:Object.freeze({accountLabel:snapshot.accountLabel,evidence:Object.freeze({...snapshot.evidence})}),
                  invocation:copyInvocation(sessionInvocation),authHome,identityFiles:expectedIdentityFiles,
                  accountFingerprint:snapshot.evidence.accountFingerprint,routeFingerprint:snapshot.evidence.routeFingerprint,
                  assetsFingerprint:snapshot.evidence.assetsFingerprint};
                accountCache.publish({value:cachedValue,observedAt,observedMonotonic,expiresAt:snapshot.evidence.expiresAt,
                  binding:JSON.stringify([snapshot.evidence.accountFingerprint,snapshot.evidence.routeFingerprint,snapshot.evidence.assetsFingerprint]),
                  metadata:expectedIdentityFiles},cachePublicationGeneration);
              }
              checkPreparationEpoch();
              reuse=reuseIssuer.issue({observedAt,observedMonotonic,expiresAt:snapshot.evidence.expiresAt,
                validateLocal:localSignal=>validateLocalIdentity({authHome,identityFiles:expectedIdentityFiles},localSignal)});
              checkPreparationEpoch();
            }
            checkPreparationEpoch();
            return {...snapshot,invocation:sessionInvocation,...(reuse?{reuse}:{}),
              ...(identityFilesBefore!==null&&identityFilesBefore===identityFilesAfter?
                {validateAcceptance:acceptanceGuard({authHome,identityFiles:identityFilesBefore})}:{})};
          }
          if(typeof mode!=='object')return snapshot;
          const invocation = typeof mode === 'object' && 'text' in mode
            ? buildObserverCompressionInvocation(profile, JSON.stringify(validateCompressionRequest(mode)), env, authHome)
            : buildObserverCodexInvocation(profile,mode,env,authHome);
          const modelIndex=invocation.args.indexOf('--model');
          const model=modelIndex>=0?invocation.args[modelIndex+1]:undefined;
          const effortArg=invocation.args.find(arg=>arg.startsWith('model_reasoning_effort='));
          let effort:string|undefined;
          if(effortArg){try{const value=JSON.parse(effortArg.slice('model_reasoning_effort='.length));if(typeof value==='string')effort=value;}catch{/* Missing effort omits research provenance. */}}
          const modelVersion=typeof model==='string'&&typeof effort==='string'?`${model}-${effort}`:undefined;
          return {...snapshot,invocation,...(typeof modelVersion==='string'&&modelVersion.length<=128?{provenance:{
            input:OBSERVER_INPUT_FACTS_VERSION,prompt:files.instructionsSha256,model:modelVersion,algorithm:'pace-v1'}}:{} )};
        } catch(error) {
          await retireHome();
          runtimeCache.invalidate();
          if(identityWorkStarted)invalidateAttestation('explicit');
          emit('failed',undefined,false);
          if(!combined.aborted && !disabled && !ownersBusy() && error instanceof Error && error.message==='OBSERVER_LOGIN_REQUIRED')throw error;
          if(typeof mode==='object' && stage==='account-read' && !combined.aborted && !disabled && !ownersBusy()
            && error instanceof ObserverAccountTimeout)throw new ObserverPreDispatchTransient();
          if(mode==='inspect')throw new AccountInspectionFailure({stage,attempts:accountAttempts,
            ...(readerDiagnostic?{reader:readerDiagnostic}:{}),
            reason:ownersBusy()?'ownership_unconfirmed':combined.aborted||disabled?'cancelled':
              error instanceof ObserverAccountTimeout?'timeout':'check_failed'});
          if(mode==='session'){
            const stageCodes:Record<PreparationStage,IdentityPreparationCode>={
              'home-prepare':'IDENTITY_HOME_PREPARE_FAILED','runtime-preflight':'IDENTITY_RUNTIME_PREFLIGHT_FAILED',
              'account-read':'IDENTITY_ACCOUNT_READ_FAILED','home-recheck':'IDENTITY_HOME_RECHECK_FAILED',
              binding:'IDENTITY_BINDING_FAILED',ready:'IDENTITY_READY_FAILED'};
            throw identityPreparationError('OBSERVER_IDENTITY_UNAVAILABLE',ownersBusy()?'IDENTITY_OWNERSHIP_UNCONFIRMED':
              combined.aborted||disabled?'IDENTITY_CANCELLED':identityPreparationCode(error)??stageCodes[stage]);
          }
          throw fail();
        } finally {
          combined.removeEventListener('abort',abort);
          cancelOwners(false);
          if(setupMode)await retireHome();
          if(ownersBusy())poisoned=true;
          else {cancel=undefined;owned=undefined;}
          // A prepared invocation is not usable until its required transition
          // drain is confirmed. A swallowed retirement error must never escape
          // as successful login/logout/session preparation.
          if(sharedHome&&poisoned)throw mode==='session'?
            identityPreparationError('OBSERVER_IDENTITY_UNAVAILABLE','IDENTITY_OWNERSHIP_UNCONFIRMED'):fail();
        }
      }).finally(()=>{pending=undefined;});
      return pending;
    }
    return {
      inspect:(signal:AbortSignal)=>perform(signal,'inspect') as Promise<Snapshot>,
      // Attestation and invocation preparation only: the caller must separately
      // authorize, own and account for every model operation in this server.
      prepareSession:(signal:AbortSignal,policy?:SessionPreparationPolicy)=>perform(signal,'session',policy) as Promise<PreparedEstimate>,
      // No account evidence or model authority is returned. The custody owner
      // may use this separately attested local server only for owned cleanup.
      prepareCleanupServer:(signal:AbortSignal)=>perform(signal,'cleanup') as Promise<Invocation>,
      prepareLogin:(signal:AbortSignal)=>perform(signal,'login') as Promise<Invocation>,
      prepareDeviceLogin:(signal:AbortSignal)=>perform(signal,'device-auth') as Promise<Invocation>,
    prepareDeviceAuth:(signal:AbortSignal)=>perform(signal,'device-auth') as Promise<Invocation>,
      prepareLogout:(signal:AbortSignal)=>perform(signal,'logout') as Promise<Invocation>,
    invalidateSessionReuse,
    prepareEstimate:(input:ObserverInput,signal:AbortSignal)=>perform(signal,input) as Promise<PreparedEstimate>,
      prepareCompression:(input:CompressionRequest,signal:AbortSignal)=>perform(signal,input) as Promise<PreparedEstimate>,
    disable,
    close():Promise<void> {
      if(closing)return closing;
      disable();const operation=pending,localValidation=localValidationPending;
      closing=(async()=>{await operation?.catch(()=>undefined);await localValidation?.catch(()=>undefined);
        await homeRetirement;
        try{await sharedHome?.close();}catch{poisoned=true;}
        if(poisoned || owned?.() || localValidationPending)throw Error('OBSERVER_IDENTITY_CLOSE_UNCONFIRMED');})();
      return closing;
    },
  };
}
