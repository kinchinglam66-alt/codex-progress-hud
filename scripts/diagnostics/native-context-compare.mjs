// Explicit synthetic-only experiment. Never invoke on real session directories.
import {mkdir,readFile,writeFile,copyFile,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as wait} from 'node:timers/promises';
import {readObserverPilotConfig,observerPilotEnvironment} from '../../dist/desktop/observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../../dist/estimation/observer-identity-runtime.js';
import {createApprovedComparisonConsent} from '../../dist/evaluation/native-comparison-consent.js';
import {createMeasuredComparisonPreparation} from '../../dist/evaluation/native-comparison-preparation.js';
import {transitionComparisonNativeState} from '../../dist/evaluation/native-comparison-transition.js';
import {createNativeObserverTrial} from '../../dist/desktop/native-observer-trial.js';
import {createPersistentObserverWorker} from '../../dist/estimation/observer-persistent-worker.js';
import {createPersistentObserverSession} from '../../dist/estimation/observer-persistent-session.js';
import {createPersistentReceiptJournal} from '../../dist/estimation/observer-persistent-receipt.js';
import {createObserverSessionProcess} from '../../dist/estimation/observer-session-process.js';
import {createNativeSourceSnapshot} from '../../dist/observer/native-source-snapshot.js';
import {createLocalSessionReader} from '../../dist/observer/local-session-reader.js';
import {readOwnedNativeCheckpoint,readOwnedNativeRollout} from '../../dist/evaluation/native-owned-checkpoint.js';
import {compareSupplementReadback,submittedSupplementItems} from '../../dist/evaluation/native-supplement-readback.js';
import {collectSourceReadback} from '../../dist/evaluation/native-source-readback.js';
import {nativeComparisonOptions,comparisonCandidatePassed} from '../../dist/evaluation/native-comparison-options.js';
import {closeComparisonOwners} from '../../dist/evaluation/native-comparison-cleanup.js';
import {loadObserverApiAssets} from '../../dist/estimation/observer-api-assets.js';
import {openReleaseAccounting} from '../../dist/estimation/release-accounting.js';
import {persistentHistoryPolicy} from '../../dist/estimation/persistent-history-policy.js';
import {createNativeStorage} from '../../dist/estimation/native-storage.js';
import {openApprovedNativeComparisonSeries} from '../../dist/evaluation/native-trial-authority.js';
import {comparisonReleasePlan,waitForComparisonEligibility,comparisonRunTimeoutMs} from '../../dist/evaluation/native-comparison-cadence.js';
import {comparisonThreadParameters,createComparisonForkRegistry,createCompletedTurnForkRegistry} from '../../dist/evaluation/native-comparison-input.js';
import {nativePreservationInstructions} from '../../dist/estimation/native-preservation.js';
import {runSyntheticSeedOperation} from '../../dist/evaluation/native-seed-operation.js';
import {classifyNativeTrialEvent,describeNativeTrialOutput} from '../../dist/evaluation/native-trial-events.js';
import {createNativeContextPhaseClock} from '../../dist/estimation/native-context-phase-clock.js';
import {createNativeContextPhaseRecord} from '../../dist/estimation/native-context-metrics.js';
import {createNativeComparisonFixtures,NATIVE_COMPARISON_FIXTURE_VERSION,createCompletedTurnComparisonFixtures,COMPLETED_TURN_COMPARISON_VERSION,evaluateSourceCorrection} from '../../dist/evaluation/native-comparison-fixture.js';
import {runNativeContextComparison,comparisonContextEvidence} from '../../dist/evaluation/native-context-comparison.js';
import {createAccountPreparationMetrics} from '../../dist/evaluation/account-preparation-metrics.js';
import {createComparisonIdentityRoutes} from '../../dist/evaluation/comparison-identity-routes.js';
import {createComparisonCacheDiagnostics} from '../../dist/evaluation/comparison-cache-diagnostics.js';

const [configPath,outputDirectory,mode,...flags]=process.argv.slice(2);
if(!isAbsolute(configPath??'')||!isAbsolute(outputDirectory??''))throw Error('EXPLICIT_SYNTHETIC_TRIAL_ARGUMENTS_REQUIRED');
const {acceptanceVersion,completedMode,inlineSupplement,reuseHomeCheckProcess,reuseNativeGuard,reuseAccountCache,reuseNativeTurnSession,sourceCorrection,qualification,sequenceDiagnostic,nativeDiagnostic,sourceReadbackDiagnostic,collectContextFailures,readback:readbackEnabled}=nativeComparisonOptions(mode,flags);
const fixtureVersion=(completedMode?COMPLETED_TURN_COMPARISON_VERSION:NATIVE_COMPARISON_FIXTURE_VERSION)+(sourceCorrection?'-source-correction-v1':qualification?'-qualification-v1':'');
const qualificationNonce=qualification?randomUUID():undefined;
const root=resolve(outputDirectory),run=!mode.startsWith('--preflight');
const canonical=path=>resolve(path).toLowerCase();
if(!process.env.APPDATA||canonical(configPath)!==canonical(join(process.env.APPDATA,'codex-progress-hud','observer-pilot.json')))throw Error('TRIAL_CONFIG_AUTHORITY_INVALID');
await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink())throw Error('TRIAL_OUTPUT_REPARSE');
const resourcesDirectory=join(root,'resources');await mkdir(join(resourcesDirectory,'observer-assets'),{recursive:true});
const hash=data=>createHash('sha256').update(data).digest('hex');
async function stage(source,target){
 try{await copyFile(source,target,constants.COPYFILE_EXCL);}catch(error){
  if(error.code!=='EEXIST'||hash(await readFile(source))!==hash(await readFile(target)))throw Error('TRIAL_ASSET_MISMATCH');
 }
}
for(const name of ['observer.schema.json','observer-instructions.md','context-summary.schema.json','context-summary-instructions.md'])
 await stage(resolve('src/estimation/assets',name),join(resourcesDirectory,'observer-assets',name));
await stage(resolve('scripts/windows/observer-home.ps1'),join(resourcesDirectory,'observer-home.ps1'));
if(reuseNativeGuard)await stage(resolve('scripts/windows/native-guard.ps1'),join(resourcesDirectory,'native-guard.ps1'));
const config=await readObserverPilotConfig(configPath);
if(!config||config.version!=='0.153.4'||config.executableSha256!=='ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b')throw Error('TRIAL_PIN_UNVERIFIED');
const identityOptions={...config,resourcesDirectory,powershell:join(process.env.SystemRoot??process.env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/powershell.exe'),
 environment:observerPilotEnvironment(config,process.env)};
const accountMetrics=createAccountPreparationMetrics(()=>performance.now());
const cacheDiagnostics=createComparisonCacheDiagnostics();
const identity=createObserverIdentityRuntime({...identityOptions,reuseHomeCheckProcess,onDiagnostic:d=>cacheDiagnostics.record('seed',d.accountCache)}),controller=new AbortController(),workers=new Map(),processOwners=[];
// Independent cold caches: the second strategy must not inherit the first one's
// attestation. The seed/preflight identity is never a strategy cache.
const identityRoutes=createComparisonIdentityRoutes({enabled:reuseAccountCache,seed:identity,
 create:strategy=>createObserverIdentityRuntime({...identityOptions,reuseHomeCheckProcess,onDiagnostic:d=>cacheDiagnostics.record(strategy,d.accountCache)})});
const report={synthetic:true,mode,acceptanceVersion,model:'gpt-5.6-luna',effort:'medium',serviceTier:'default',
 inlineSupplement,reuseHomeCheckProcess,reuseNativeGuard,reuseNativeTurnSession,sourceCorrection,qualification,fixtureNonceHash:qualificationNonce?hash(qualificationNonce):null,homeCheckPolicy:reuseHomeCheckProcess?'resident-both-strategies':'one-shot-both-strategies',
 approvedTrialId:null,cadencePolicy:'actual ordinary eligibility; no synthetic clock advance',cadence:[],
 accountCachePolicy:reuseAccountCache?'allow-independent-strategy-caches':'bypass-both-strategies',
 ...(reuseAccountCache?{performanceEligible:false,diagnosticScope:'product-policy diagnostic; does not replace the registered bypass qualification'}:{}),
 fixtureVersion,
 ...(completedMode?{sizeStratum:mode.endsWith('-1m')?'1MiB':'85KiB',candidate:'completed-turn',nativeTurnTimings:[],finalCleanupMs:{}}:{}),
 evidenceScope:'synthetic context inheritance and preparation latency, not task ETA accuracy',
 ...(nativeDiagnostic?{etaDeadlineMs:30000,deadlineScope:'accepted diagnostic request through delivery; cadence wait excluded; cleanup still joined'}:{}),
 historyCapacityPolicy:{contextTokens:258400,outputReserveTokens:16384,requestBytes:null,basis:'fixed comparison policy; opaque model resident size remains unverified'},
 measurements:[],errors:[],events:[],outputDiagnostics:[],terminalDiagnostics:[],diagnosticVersion:'native-output-v1',
 contentCollectionPolicy:collectContextFailures?'fixed slots; any content failure fails the whole gate':'stop',sourceReadbacks:[],
 ...(readbackEnabled?{readbacks:[],performanceEligible:false,diagnosticScope:'native-only context check with local readback overhead; no performance pairs'}:{}),
 unexpectedOperations:0,automaticCompactions:0,cleanupConfirmed:false};
const runTimeoutMs=run?comparisonRunTimeoutMs(!nativeDiagnostic):90000;
report.runTimeoutMs=runTimeoutMs;
report.persistentSessionBuildHash=hash(await readFile(resolve('dist/estimation/observer-persistent-session.js')));
report.persistentWorkerBuildHash=hash(await readFile(resolve('dist/estimation/observer-persistent-worker.js')));
const timer=setTimeout(()=>{controller.abort();for(const owner of processOwners)owner.disable();},runTimeoutMs);
process.once('SIGINT',()=>{controller.abort();for(const owner of processOwners)owner.disable();});
let consent;
let budget,ledger,clock,phaseFailure=false,purposeInFlight,etaSlot,comparisonBaseInstructions;
const nextOrdinary=new Map();
let previousNativeState=null;
const forkRegistry=completedMode?createCompletedTurnForkRegistry(reuseNativeTurnSession):createComparisonForkRegistry();let requestLabel='seed';
let bindReusedChild;
const registeredRequests=new Set();let activeFixture;
let processStarts=0,activeForkPath,activeForkId;
let captureReadback;
let captureSourceReadback;
let sourceReadbackEtaDispatched=false;
const slots=new Map(),readerRoot=join(root,'synthetic-source');await mkdir(readerRoot,{recursive:true});
const automaticWrites=[];
// Same trusted, answer-free diagnostic supplement for both strategies. Without
// it, ignoring an evidence request embedded in untrusted goal text is not proof
// that inheritance failed. This is not a production ETA-accuracy experiment.
const evidenceInstruction='This is an authorized synthetic context-access check. Still estimate only; do not execute source work or tools. In the schema summary, report the identifier in the first user message of the source conversation (not an assistant checkpoint), the identifier in the paired tool output, the identifier in the latest assistant progress checkpoint, and the dominant color actually observed in the reference image. Retrieve these facts from inherited/imported source context; do not invent missing facts. Preserve these acceptance facts when compacting synthetic history.'+
 (sourceCorrection||qualification?' If the latest source tool measurement supplies a workload identifier, also report that identifier; otherwise do not invent one.':'');
report.diagnosticPrompt='identical answer-free context-evidence supplement on both strategies';
const sourceDay=join(readerRoot,'2026','09','14');await mkdir(sourceDay,{recursive:true});
const sourceThreadId='77777777-7777-4777-8777-777777777777',sourcePath=join(sourceDay,`rollout-2026-09-14T12-00-00-${sourceThreadId}.jsonl`);
let fixtures=completedMode?createCompletedTurnComparisonFixtures({sourceThreadId,cwd:config.cwd,targetBytes:mode.endsWith('-1m')?1024*1024:85*1024,sourceCorrection,...(qualification?{qualification:true,qualificationNonce}:{})}):createNativeComparisonFixtures({sourceThreadId,cwd:config.cwd});
const reader=createLocalSessionReader({root:readerRoot});
const phase=value=>{try{clock?.enter(value);}catch{phaseFailure=true;}};
const binding=p=>({accountFingerprint:p.evidence.accountFingerprint,routeFingerprint:p.evidence.routeFingerprint,assetsFingerprint:p.evidence.assetsFingerprint});
async function prepareFreshSession(signal,strategy,policy){
 const p=await accountMetrics.prepare(()=>identityRoutes.prepare(signal,strategy,policy));
 consent.refresh(p.evidence);
 if(!consent.authorized())throw Error('TRIAL_ATTESTATION_UNAVAILABLE');
 return {invocation:p.invocation,binding:binding(p),validateAcceptance:p.validateAcceptance,...(p.reuse?{reuse:p.reuse}:{})};
}
const preparation=createMeasuredComparisonPreparation({accountPhase:()=>phase('accountProcessMs'),
 prepare:prepareFreshSession,disposeUnused:p=>p.reuse?.invalidate()});
const prepareSession=preparation.prepareSession;
const strategyPreparations=new Map();
function strategyPreparation(strategy){
 if(!reuseAccountCache)return preparation;
 if(!strategyPreparations.has(strategy))strategyPreparations.set(strategy,createMeasuredComparisonPreparation({
  accountPhase:()=>phase('accountProcessMs'),prepare:signal=>prepareFreshSession(signal,strategy),disposeUnused:p=>p.reuse?.invalidate()}));
 return strategyPreparations.get(strategy);
}
function unexpected(code){report.unexpectedOperations++;report.errors.push(code);controller.abort();for(const owner of processOwners)owner.disable();}
function processFactory(strategy='native'){
 const owner=createObserverSessionProcess();processOwners.push(owner);processStarts++;
 const diagnosticProcessId=randomUUID();
 let ownedThreadId;
 if(strategy==='native'&&reuseNativeTurnSession)bindReusedChild=()=>{
  if(registeredRequests.has(requestLabel))return;
  if(!activeFixture?.lastCompletedTurnId||!ownedThreadId)throw Error('TRIAL_REUSE_CHILD_MISSING');
  forkRegistry.begin(requestLabel,sourceThreadId,activeFixture.lastCompletedTurnId,diagnosticProcessId,activeFixture.currentTurnId);
  forkRegistry.reuse(requestLabel,ownedThreadId);registeredRequests.add(requestLabel);
 };
 return {...owner,start:async invocation=>{
  const opened=await owner.start(invocation),rpc=opened.rpc,call=rpc.call;
  let readbackTarget,acknowledgedItems=[],acknowledgedBytes=0;
  const sourceReadbackTargets=new Map();
  if(strategy==='native'&&completedMode)captureSourceReadback=async()=>{
   const began=performance.now();
   const source=activeFixture.rollout.trimEnd().split('\n').map(line=>JSON.parse(line));
   const evidence=await collectSourceReadback(source,[...sourceReadbackTargets].map(([role,target])=>({role,read:async()=>{
    const storage=createNativeStorage(target.runtimeHome);
    return readOwnedNativeRollout({...target,maxBytes:8*1024*1024,verifyStorage:()=>storage.verify(controller.signal)});
   }})));
   const result={request:requestLabel,evidence,elapsedMs:performance.now()-began,
    scope:'post-response local persisted history only; not proof of model wire contents; excluded from delivery timing'};
   report.sourceReadback=result;
   report.sourceReadbacks.push(result);
   await writeFile(join(root,`source-readback-${requestLabel}.json`),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  };
  if(readbackEnabled)captureReadback=async()=>{
   if(!readbackTarget||readbackTarget.forkThreadId!==forkRegistry.require(requestLabel))throw Error('TRIAL_READBACK_CHILD_MISMATCH');
   const storage=createNativeStorage(readbackTarget.runtimeHome),begin=performance.now();
   const stored=await readOwnedNativeRollout({...readbackTarget,maxBytes:8*1024*1024,verifyStorage:()=>storage.verify(controller.signal)});
   const compared=compareSupplementReadback(acknowledgedItems,stored);
   const evidence={request:requestLabel,...compared,elapsedMs:performance.now()-begin,scope:'local persisted input; not proof of remote model wire contents'};
   report.readbacks.push(evidence);
   await writeFile(join(root,`readback-${requestLabel}.json`),JSON.stringify(evidence,null,2),{flag:'wx',mode:0o600});
   if(!compared.exact)throw Error('TRIAL_SUPPLEMENT_READBACK_MISMATCH');
  };
  rpc.subscribe(n=>{
   const type=n.params.item?.type,action=classifyNativeTrialEvent(n.method,type,purposeInFlight);
   // Bounded metadata only; diagnostics cannot authorize, retry or fail a call.
   try{
    if(n.method==='item/completed'&&type==='agentMessage'&&purposeInFlight==='eta'&&report.outputDiagnostics.length<32){
     const phase=n.params.item.phase;
     report.outputDiagnostics.push({phase:['final_answer','commentary'].includes(phase)?phase:'unspecified',
      ...describeNativeTrialOutput(n.params.item.text)});
    }
    if(n.method==='turn/completed'&&report.terminalDiagnostics.length<32){
     const status=n.params.turn?.status;
     report.terminalDiagnostics.push({purpose:purposeInFlight??'none',
      status:['completed','failed','interrupted'].includes(status)?status:'unrecognized'});
    }
   }catch{/* Observation failures do not change call semantics. */}
   if(n.method==='turn/started'||n.method==='item/started'){
    if(report.events.length>=512){unexpected('TRIAL_EVENT_LIMIT');return;}
    const known=['userMessage','agentMessage','reasoning','plan','contextCompaction','commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','imageView','imageGeneration','sleep','hookPrompt','functionCallOutput'];
    report.events.push({method:n.method,itemType:known.includes(type)?type:'unrecognized',action});
   }
   if(action==='unexpected_turn')unexpected('UNADMITTED_TURN');
   if(action==='unexpected_compaction'){
     report.automaticCompactions++;
     if(budget)automaticWrites.push(budget.observeAutomaticCompaction().catch(()=>{report.errors.push('AUTOMATIC_COMPACTION_AUDIT_FAILED');}));
     unexpected('UNEXPECTED_AUTOMATIC_COMPACTION');
   }else if(action==='unexpected_item')unexpected('UNEXPECTED_EXECUTABLE_ITEM');
  });
  rpc.call=async(method,params)=>{
   const allowed=['initialize','thread/start','thread/fork','thread/read','thread/goal/clear','thread/goal/get','thread/inject_items','turn/start','turn/interrupt','thread/compact/start'];
   if(!allowed.includes(method))throw Error('TRIAL_RPC_FORBIDDEN');
   if(sourceReadbackDiagnostic){
    if(method==='thread/compact/start')throw Error('TRIAL_READBACK_COMPACTION_FORBIDDEN');
    if(method==='turn/start'){
     if(sourceReadbackEtaDispatched)throw Error('TRIAL_READBACK_SINGLE_ETA_LIMIT');
     sourceReadbackEtaDispatched=true;
    }
   }
   if(method==='thread/read'&&(!ownedThreadId||params.threadId!==ownedThreadId||ownedThreadId===sourceThreadId))throw Error('TRIAL_READ_UNOWNED_THREAD');
   if(method==='turn/start'&&purposeInFlight!=='eta'||method==='thread/compact/start'&&purposeInFlight!=='context_compression')throw Error('TRIAL_RPC_UNADMITTED');
   if(method==='turn/start'&&(params.model!=='gpt-5.6-luna'||params.effort!=='medium'||params.serviceTierForTurn!=='default'))throw Error('TRIAL_MODEL_PROFILE_INVALID');
   if(method==='thread/start'||method==='thread/fork'){
    params=comparisonThreadParameters(method,params,comparisonBaseInstructions,evidenceInstruction);
   }
   if(method==='thread/compact/start'&&strategy==='history'){
    if(!ownedThreadId||params.threadId!==ownedThreadId||ownedThreadId===sourceThreadId)throw Error('TRIAL_INJECTION_UNADMITTED');
    // The native production session does this itself. Give the history control
    // the same answer-free preservation instruction, not a weaker baseline.
    const ack=await call('thread/inject_items',{threadId:ownedThreadId,items:[
     {type:'message',role:'developer',content:[{type:'input_text',text:nativePreservationInstructions}]}
    ]});
    controller.signal.throwIfAborted();
    if(!ack||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).length!==0)throw Error('TRIAL_INJECTION_ACK_INVALID');
   }
   const result=await call(method,params);
   if(method==='thread/fork'){
    if(completedMode){
     if(!activeFixture?.lastCompletedTurnId)throw Error('TRIAL_TERMINAL_MISSING');
     if(!registeredRequests.has(requestLabel)){forkRegistry.begin(requestLabel,sourceThreadId,activeFixture.lastCompletedTurnId,diagnosticProcessId,activeFixture.currentTurnId);registeredRequests.add(requestLabel);}
     forkRegistry.record(requestLabel,params,result?.thread?.id);
     if(strategy==='native'){
      const role=forkRegistry.snapshot().at(-1)?.role;
      if(role==='base'||role==='child')sourceReadbackTargets.set(role,{runtimeHome:invocation.env.CODEX_HOME,
       path:result?.thread?.path,sourceThreadId,forkThreadId:result?.thread?.id,custodyTag:params.threadSource});
     }
    }else forkRegistry.record(requestLabel,sourceThreadId,result?.thread?.id);
   }
   if(method==='thread/fork'||method==='thread/start'){activeForkPath=result?.thread?.path;activeForkId=result?.thread?.id;ownedThreadId=activeForkId;}
   if(readbackEnabled&&method==='thread/fork'){
    readbackTarget={runtimeHome:invocation.env.CODEX_HOME,path:result.thread.path,sourceThreadId,forkThreadId:result.thread.id,custodyTag:params.threadSource};
    acknowledgedItems=[];acknowledgedBytes=0;
   }
   if(readbackEnabled&&method==='thread/inject_items'){
    if(params.threadId!==readbackTarget?.forkThreadId||!result||typeof result!=='object'||Object.keys(result).length)throw Error('TRIAL_READBACK_ACK_INVALID');
    acknowledgedBytes+=Buffer.byteLength(JSON.stringify(params.items));
    if(acknowledgedBytes>8*1024*1024)throw Error('TRIAL_READBACK_BOUND');
    acknowledgedItems.push(...structuredClone(params.items));
   }
   if(readbackEnabled&&inlineSupplement&&method==='turn/start'){
    if(params.threadId!==readbackTarget?.forkThreadId||typeof result?.turn?.id!=='string'||!result.turn.id)throw Error('TRIAL_READBACK_TURN_ACK_INVALID');
    const submitted=submittedSupplementItems(params.input);
    acknowledgedBytes+=Buffer.byteLength(JSON.stringify(submitted));
    if(acknowledgedBytes>8*1024*1024)throw Error('TRIAL_READBACK_BOUND');
    acknowledgedItems.push(...submitted);
   }
   return result;
  };
  return opened;
 }};
}
function boundedAccounting(){return {...ledger,forConversation:key=>{
 const view=ledger.forConversation(key);
 return {...view,reserve:async(kind,purpose='eta')=>{
  const trialId=await budget.reserve(purpose==='context_compression'?'compaction':'eta');
  try{
   const id=await view.reserve(kind,purpose);if(!id)throw Error('TRIAL_LEDGER_ADMISSION_DENIED');
   slots.set(id,{trialId,purpose,settled:false});purposeInFlight=purpose;if(purpose==='eta')etaSlot=id;return id;
  }catch(error){await budget.settle(trialId,'failed');throw error;}
 },settle:async(id,usage,classification)=>{
  await view.settle(id,usage,classification);
  const slot=slots.get(id);if(!slot)throw Error('TRIAL_UNKNOWN_RESERVATION');slot.settled=true;
  if(slot.purpose==='context_compression'){
   await budget.settle(slot.trialId,classification==='confirmed_compression_unknown'||classification==='known_success'?'completed':'unconfirmed');
   purposeInFlight=undefined;slots.delete(id);
  }
 },cancelBeforeDispatch:async id=>{
  await view.cancelBeforeDispatch(id);const slot=slots.get(id);
  if(slot){await budget.settle(slot.trialId,'failed');slots.delete(id);}purposeInFlight=undefined;
 }};
}};}
async function finishEta(result){
 const slot=slots.get(etaSlot);
 if(!slot)throw Error('TRIAL_ETA_SETTLEMENT_UNCONFIRMED');
 if(!slot.settled){await budget.settle(slot.trialId,'unconfirmed');slots.delete(etaSlot);etaSlot=undefined;purposeInFlight=undefined;throw Error('TRIAL_ETA_SETTLEMENT_UNCONFIRMED');}
 await budget.settle(slot.trialId,result.status==='interpreted'?'completed':'failed');
 slots.delete(etaSlot);etaSlot=undefined;purposeInFlight=undefined;
}
// Seed a genuine encrypted checkpoint from synthetic history only, with an
// explicit compression reservation, receipts, and owned disk-backed fork.
async function seedCheckpoint(assets,accounting){
 const raw=fixtures[1];await writeFile(sourcePath,raw.rollout);
 const resources=createNativeObserverTrial(identityOptions,{maxSourceBytes:1024*1024}),signal=controller.signal;
 const destination=await resources.destination(signal);
 let snapshot,owner,claim,view,id,operationId;
 const ownerUuid=randomUUID(),journal=createPersistentReceiptJournal(join(root,'seed-receipts'));
 try{
  snapshot=await createNativeSourceSnapshot({sourcePath,sourceRoot:readerRoot,sourceThreadId,sourceEpoch:1,revision:1,
   byteWatermark:Buffer.byteLength(raw.rollout),signal,...destination});
  const prepared=await prepareSession(signal);owner=processFactory();const opened=await owner.start(prepared.invocation);
  await journal.ownerStarted({ownerUuid,sourceKey:'synthetic-seed',sourceEpoch:'seed',pid:opened.pid,creationIdentity:opened.creationIdentity,binding:prepared.binding});
  await opened.rpc.call('initialize',{clientInfo:{name:'hud_synthetic_checkpoint_seed',version:'1.0.0'},capabilities:{experimentalApi:true}});opened.rpc.notify('initialized',{});
  claim=await resources.claim({snapshot:{...snapshot,sourceTurnId:raw.currentTurnId},currentTurnId:raw.currentTurnId},prepared.invocation,
   {pid:opened.pid,creationIdentity:opened.creationIdentity},signal);
  const session=createPersistentObserverSession(opened.rpc,{cwd:config.cwd,outputSchema:assets.schema,now:Date.now,nativeInstructions:assets.instructions});
  await session.startNative({sourceThreadId,path:snapshot.path,custodyTag:claim.tag},signal,claim.recordFork);
  view=accounting.forConversation('synthetic-seed');id=await view.reserve('ordinary','context_compression');if(!id)throw Error('SEED_ADMISSION_DENIED');
  operationId=randomUUID();await view.bindInvocation(id,{admissionId:id,conversationKey:'synthetic-seed',turnGeneration:0,ownerUuid,providerKind:'subscription',
   phase:'bound',deadline:Date.now()+120000,cleanupOutcome:'pending',purpose:'context_compression',pid:opened.pid,creationIdentity:opened.creationIdentity});
  await journal.operationStarted({operationId,admissionId:id,ownerUuid,sourceKey:'synthetic-seed',sourceEpoch:'seed',generation:0,operationKind:'context_compression'});
  await runSyntheticSeedOperation({
   beforeDispatch:async()=>{await view.updateInvocation(id,{phase:'dispatching'});signal.throwIfAborted();},
   dispatch:onDispatch=>session.compact(signal,async evidence=>{
    if(evidence.kind==='snapshot')await journal.usageSnapshot({operationId,sourceKey:'synthetic-seed',sourceEpoch:'seed',generation:0,...evidence,completenessReason:'compaction_observed'});
    else await journal.usageGap({operationId,sourceKey:'synthetic-seed',sourceEpoch:'seed',generation:0,...evidence});
   },onDispatch),
   terminal:(state,result)=>journal.operationTerminal({operationId,admissionId:id,ownerUuid,sourceKey:'synthetic-seed',sourceEpoch:'seed',generation:0,
    ...(result?.turnId?{turnId:result.turnId}:{}),terminalState:state,usageCompleteness:result?.usageCompleteness??(state==='cancelled'?'cancelled_before_dispatch':'protocol_failed'),operationKind:'context_compression'}),
   settleConfirmed:async()=>{await view.updateInvocation(id,{phase:'settling',cleanupOutcome:'pending'});await view.settle(id,null,'confirmed_compression_unknown');},
   settleUnconfirmed:()=>view.settle(id,null,'unsafe_unknown'),cancelBeforeDispatch:()=>view.cancelBeforeDispatch(id),
  });
  if(!activeForkPath){const response=await opened.rpc.call('thread/read',{threadId:activeForkId,includeTurns:false});
   if(response?.thread?.id!==activeForkId)throw Error('SEED_FORK_ID_MISMATCH');activeForkPath=response.thread.path;}
  // Close the only writer before reading its generated checkpoint; cleanup is
  // deferred until the bounded held-handle read and in-memory fixture finish.
  await owner.close();if(!owner.status().closed)throw Error('SEED_OWNER_EXIT_UNCONFIRMED');
  if(typeof activeForkPath!=='string'||!isAbsolute(activeForkPath))throw Error('SEED_FORK_PATH_UNVERIFIED');
  const home=resolve(config.parentDirectory,'observer-auth'),storage=createNativeStorage(home);
  const {envelope:checkpoint,checkpoint:parsed}=await readOwnedNativeCheckpoint({runtimeHome:home,path:activeForkPath,
   sourceThreadId,forkThreadId:activeForkId,custodyTag:claim.tag,maxBytes:2*1024*1024,verifyStorage:()=>storage.verify(signal)});
  const metadata=fixtures[2].rollout.slice(0,fixtures[2].rollout.indexOf('\n')+1),tail=fixtures[2].rollout.slice(fixtures[1].rollout.length);
  const rollout=metadata+JSON.stringify(checkpoint)+'\n'+tail;
  fixtures[2]={...fixtures[2],rollout,contextHash:hash(rollout)};
  report.checkpoint={synthetic:true,bytes:parsed.encodedBytes,items:parsed.itemCount,encryptedItems:parsed.encryptedSummaryCount};
 }finally{
  try{
   if(owner){await owner.close();if(!owner.status().closed)throw Error('SEED_OWNER_EXIT_UNCONFIRMED');
    await journal.processExit({ownerUuid,sourceKey:'synthetic-seed',sourceEpoch:'seed',processExitState:'closed',at:Date.now()});}
   if(claim)await claim.afterProcessClosed();if(snapshot)await snapshot.close();await resources.release();
  }finally{await view?.close();}
 }
}
try{
 const account=await identity.inspect(controller.signal);
 consent=createApprovedComparisonConsent(account.evidence,{now:Date.now,onInvalidate:()=>{controller.abort();for(const owner of processOwners)owner.disable();}});
 const assets=await loadObserverApiAssets(resourcesDirectory);report.accountPrepared=true;
 comparisonBaseInstructions=assets.instructions+'\n'+nativePreservationInstructions;
 report.instructionPolicy={baseHash:hash(comparisonBaseInstructions),evidenceHash:hash(evidenceInstruction),preservationHash:hash(nativePreservationInstructions)};
 // Fixed input preflight is local, does not instantiate the paid-run budget.
 for(const fixture of fixtures){
  await writeFile(sourcePath,fixture.rollout);const snapshot=await reader.snapshot(sourceThreadId,controller.signal);
  let records=0;for await(const row of snapshot.records(controller.signal))records++;
  if(!snapshot.coverage.complete||snapshot.coverage.gaps.length||records===0)throw Error('SYNTHETIC_READER_COVERAGE_FAILED');await snapshot.close();
 }
 if(run){
  const trialStorage=createNativeStorage(resolve(config.parentDirectory,'observer-auth'));await trialStorage.prepare(controller.signal);
  const authority=await openApprovedNativeComparisonSeries({runtimeHome:resolve(config.parentDirectory,'observer-auth'),binding:binding(account),verifyStorage:()=>trialStorage.verify(controller.signal)},mode.endsWith('-1m')?'1MiB':'85KiB');
  report.approvedTrialId=authority.approvedTrialId;
  budget=authority.budget;ledger=await openReleaseAccounting(authority.ledgerDirectory,Date.now);
  const accounting=boundedAccounting();if(!nativeDiagnostic&&!completedMode)await seedCheckpoint(assets,accounting);
  const policy=persistentHistoryPolicy({contextTokens:258400,outputReserveTokens:16384,requestBytes:null});
  function worker(strategy){
   if(workers.has(strategy))return workers.get(strategy);
   const nativeContext=strategy==='native'?createNativeObserverTrial(identityOptions,{maxSourceBytes:completedMode?8*1024*1024:1024*1024,reuseNativeGuard,retainNativeGuard:reuseNativeTurnSession&&reuseNativeGuard,...(completedMode?{mode:'completed-turn'}:{})}):undefined;
   const value=createPersistentObserverWorker({accounting,prepareSession:(signal,policy)=>reuseAccountCache&&policy?.accountCache==='bypass'
     ?prepareFreshSession(signal,strategy,policy):strategyPreparation(strategy).prepareSession(signal),
    invalidateSessionReuse:()=>identityRoutes.identity(strategy).invalidateSessionReuse(),authorize:()=>consent.authorized(),now:Date.now,outputSchema:assets.schema,
    receiptDirectory:join(root,`${strategy}-receipts`),...policy,...(nativeContext?{nativeContext,nativeInstructions:assets.instructions}:{}),
    ...(completedMode&&nativeContext?{completedTurnContext:true,reuseNativeTurnSession,inlineCurrentTurnSupplement:inlineSupplement,onNativeTurnTiming:event=>{if(report.nativeTurnTimings.length<2048)report.nativeTurnTimings.push({request:requestLabel,...event});}}:{}),
    processFactory:()=>processFactory(strategy),onContextPhase:phase});
   workers.set(strategy,value);return value;
  }
  report.comparison=await runNativeContextComparison(fixtures,async(index,strategy)=>{
   requestLabel=`${index}-${strategy}`;
   if(index===1){
    const due=nextOrdinary.get(strategy);
    if(typeof due!=='number')throw Error('TRIAL_CADENCE_MISSING');
    console.log(JSON.stringify({stage:'ordinary-cadence-wait',strategy,remainingMs:Math.max(0,due-performance.now())}));
    const waitedMs=await waitForComparisonEligibility(due,controller.signal,()=>performance.now(),ms=>wait(ms,undefined,{signal:controller.signal}));
    report.cadence.push({index,strategy,waitedMs,eligibleAtMs:due,startedAtMs:performance.now()});
   }
   const fixture=fixtures[index];activeFixture=fixture;await writeFile(sourcePath,fixture.rollout);
   const w=worker(strategy),startsBefore=processStarts,usageBefore=ledger.snapshot(),eventsBefore=report.unexpectedOperations;
   const accountBefore=accountMetrics.snapshot();
   const begin=performance.now();let sampledAt=begin;phaseFailure=false;clock=createNativeContextPhaseClock(()=>performance.now());
   const requestDeadline=nativeDiagnostic?setTimeout(()=>controller.abort(Error('ESTIMATE_DEADLINE')),30000):undefined;
   try{return await strategyPreparation(strategy).runMeasured(controller.signal,async()=>{
   const input={goalSummary:fixture.sourceGoal,activeSeconds:10,runtime:'running',messages:[{kind:'user',text:fixture.requestText,truncated:false}],truncated:false};
   phase('snapshotMs');let prepared,paired;
   try{
   if(strategy==='native'){
    const nextState={conversationKey:'trial-native',turnKey:fixture.currentTurnId,generation:index===2?1:0,running:true};
    await transitionComparisonNativeState(w,previousNativeState,nextState,controller.signal);
    previousNativeState=nextState;
    if(completedMode){
     await reader.read(sourceThreadId,controller.signal);paired=await reader.openNativeTurn(sourceThreadId,controller.signal);
     for await(const _record of paired.supplement.records(controller.signal)){}
     if(!paired.supplement.coverage.complete||paired.supplement.coverage.gaps.length)throw Error('SYNTHETIC_SUPPLEMENT_INCOMPLETE');
     prepared=await w.prepareNativeTurnContext(input,paired,controller.signal,'trial-native',index===2?1:0,Date.now(),()=>{
      sampledAt=performance.now();return {activeSeconds:10+(sampledAt-begin)/1000,requestActiveSeconds:10,runtime:'running'};
     });
    }else{
    const destination=await w.nativeSourceDestination(controller.signal);
    const snapshot=await createNativeSourceSnapshot({sourcePath,sourceRoot:readerRoot,sourceThreadId,sourceEpoch:1,revision:index+1,
     byteWatermark:Buffer.byteLength(fixture.rollout),signal:controller.signal,...destination});
    prepared=await w.prepareNativeContext(input,{snapshot:{...snapshot,sourceTurnId:fixture.currentTurnId},currentTurnId:fixture.currentTurnId},controller.signal,'trial-native',index===2?1:0,Date.now(),()=>{
     sampledAt=performance.now();return {activeSeconds:10+(sampledAt-begin)/1000,requestActiveSeconds:10,runtime:'running'};
    });
    }
   }else{
    const snapshot=await reader.snapshot(sourceThreadId,controller.signal);
    prepared=await w.prepareContext(input,{snapshot,currentTurnId:fixture.currentTurnId},controller.signal,'trial-history',index===2?1:0,Date.now());
   }
   // Explicit worker phase evidence will replace this zero if compaction occurs.
   if(strategy==='native'){
    if(reuseNativeTurnSession){if(!bindReusedChild)throw Error('TRIAL_REUSE_OWNER_MISSING');bindReusedChild();}
    forkRegistry.require(requestLabel);
   }
   if(readbackEnabled&&!inlineSupplement){if(!captureReadback)throw Error('TRIAL_READBACK_UNAVAILABLE');await captureReadback();}
   clock.noCompaction();
   const result=await w.observe(prepared.input,controller.signal,`trial-${strategy}`,index===2?1:0);
   await finishEta(result);
   if(readbackEnabled&&inlineSupplement){if(!captureReadback)throw Error('TRIAL_READBACK_UNAVAILABLE');await captureReadback();}
   const delivered=performance.now();
   if(nativeDiagnostic&&(controller.signal.aborted||delivered-begin>=30000))throw Error('ESTIMATE_DEADLINE');
   clearTimeout(requestDeadline);
   const stages=clock.finish();clock=undefined;if(phaseFailure)throw Error('TRIAL_PHASE_EVIDENCE_INVALID');
   if(!result.usage||!Number.isSafeInteger(result.usage.cachedInputTokens))throw Error('TRIAL_ETA_USAGE_UNVERIFIED');
   const usageAfter=ledger.snapshot(),record=createNativeContextPhaseRecord({strategy,version:fixtureVersion,
    processState:processStarts>startsBefore?'cold':'warm',contextIdentityHash:fixture.contextHash,contextAgeMs:delivered-begin,
    knownTokens:usageAfter.knownTokens-usageBefore.knownTokens,cacheTokens:result.usage.cachedInputTokens,
    unknownTokenCount:usageAfter.unknown-usageBefore.unknown,stages});
   const releaseStarted=performance.now();
   const plan=comparisonReleasePlan({conversationKey:`trial-${strategy}`,turnKey:fixture.currentTurnId,generation:index===2?1:0,running:true},
    begin,releaseStarted,result.interpretation.estimate.remainingSeconds);
   nextOrdinary.set(strategy,plan.nextOrdinaryAtMs);
   await w.release(strategy==='native'?plan.permit:undefined);const releaseMs=performance.now()-releaseStarted;
   const sourceUnchanged=hash(await readFile(sourcePath))===fixture.contextHash;
   const accountAfter=accountMetrics.snapshot();
   const accountPreparation=Object.fromEntries(Object.keys(accountAfter).map(key=>[key,accountAfter[key]-accountBefore[key]]));
   const output={record,result,accountPreparation,deliveryAgeMs:delivered-begin,activeClockAgeMs:delivered-sampledAt,sourceUnchanged,cleanupConfirmed:!w.status().poisoned&&!w.status().active,
    releaseMs,requestCycleMs:delivered-begin+releaseMs,nativeLifecycle:w.status().nativeLifecycle??null,
    freshFork:strategy==='native'?forkRegistry.snapshot().some(row=>row.request===requestLabel&&row.role!=='reused-child'):null,
    reusedChild:strategy==='native'?forkRegistry.snapshot().some(row=>row.request===requestLabel&&row.role==='reused-child'):null,
    cleanupScope:'request authority released; healthy process may retain owned resources under its idle permit until final cleanup',
    toolsIsolated:eventsBefore===report.unexpectedOperations};
   report.measurements.push(output);await writeFile(join(root,`sample-${index}-${strategy}.json`),JSON.stringify(output,null,2),{flag:'wx',mode:0o600});
   if(sourceReadbackDiagnostic){
    if(!captureSourceReadback)throw Error('TRIAL_SOURCE_READBACK_UNAVAILABLE');
    await captureSourceReadback();
    if(report.sourceReadback.evidence.length!==2||report.sourceReadback.evidence.some(row=>row.firstUserExact!==true||row.sourceUserOccurrences!==1))throw Error('TRIAL_SOURCE_READBACK_MISMATCH');
   }
   if(collectContextFailures&&strategy==='native'&&!comparisonContextEvidence(fixture,result.interpretation.summary??'').verified){
    try{if(!captureSourceReadback)throw Error('NO_READBACK');await captureSourceReadback();}
    catch{report.sourceReadbacks.push({request:requestLabel,status:'capture_unavailable'});}
   }
   return output;
   }finally{await paired?.close();}
   });}finally{clearTimeout(requestDeadline);}
  },sequenceDiagnostic?'native-sequence-diagnostic':nativeDiagnostic?'native-diagnostic':'paired',completedMode?'collect-expired':'stop',collectContextFailures?'collect-invalid-content':'stop');
 }
}catch(error){
 const code=error.code??error.message;report.errors.push(/^[a-zA-Z0-9_]+$/.test(code)?code:'SYNTHETIC_COMPARISON_FAILED');process.exitCode=1;
 // Preserve failure before cleanup deletes the owned evidence. Never alter the failed gate or retry inference.
 if(code==='COMPARISON_CONTEXT_UNVERIFIED'&&report.measurements.at(-1)?.record.strategy==='native'&&captureSourceReadback&&!report.sourceReadback){
  try{await captureSourceReadback();}catch{report.sourceReadback={status:'capture_unavailable'};}
 }
}
finally{
 clearTimeout(timer);clock=undefined;
 report.accountPreparation=accountMetrics.snapshot();
 report.forks=forkRegistry.snapshot().map(({request,forkId,role})=>({request,...(role?{role}:{}),forkHash:hash(forkId)}));
 const cleanup=await closeComparisonOwners([...Array.from(workers,([name,worker])=>({name,close:()=>worker.close()})),{name:'reader',close:()=>reader.close()},...identityRoutes.owners(),{name:'identity',close:()=>identity.close()}]);
 report.accountCacheDiagnostics=cacheDiagnostics.snapshot();
 if(completedMode)for(const strategy of workers.keys())report.finalCleanupMs[strategy]=cleanup.durationMs[strategy];
 report.cleanupFailures=cleanup.failed;report.cleanupConfirmed=cleanup.failed.length===0&&processOwners.every(owner=>owner.status().closed);
 if(!report.cleanupConfirmed){report.errors.push('TRIAL_CLEANUP_UNCONFIRMED');process.exitCode=1;}
 if(sourceCorrection&&run){
  report.sourceCorrectionAssessment=evaluateSourceCorrection(
   report.measurements[0]?.result.interpretation?.estimate?.remainingSeconds,
   report.measurements[1]?.result.interpretation?.estimate?.remainingSeconds);
  if(report.sourceCorrectionAssessment.status!=='passed'){report.errors.push('SOURCE_CORRECTION_NOT_PASSED');process.exitCode=1;}
 }
 if(completedMode){
  const totals=Object.fromEntries(['history','native'].map(strategy=>[strategy,report.measurements.filter(x=>x.record.strategy===strategy).reduce((sum,x)=>sum+x.requestCycleMs,0)+(report.finalCleanupMs[strategy]??0)]));
  report.lifecycleCost={...totals,scope:'sum of measured request delivery and release plus final worker cleanup; real cadence waits reported separately',
   complete:report.measurements.length===6&&report.cleanupConfirmed,nonIncreasing:report.measurements.length===6&&report.cleanupConfirmed&&totals.native<=totals.history};
  if(readbackEnabled)report.diagnosticCompleted=report.measurements.length===(sequenceDiagnostic?3:1)&&report.readbacks.length===(sequenceDiagnostic?3:1)&&report.readbacks.every(row=>row.exact)&&report.errors.length===0&&report.cleanupConfirmed;
 }
 await Promise.all(automaticWrites);
 if(budget){report.budget=budget.snapshot();await budget.close();}if(ledger){report.accounting=ledger.snapshot();await ledger.close();}
 if(completedMode){
  report.candidatePassed=comparisonCandidatePassed(acceptanceVersion,report);
  if(run&&!report.candidatePassed&&!readbackEnabled)process.exitCode=1;
 }
 if(report.errors.length||!report.cleanupConfirmed)process.exitCode=1;
 const name=run?'comparison-result.json':`preflight-${Date.now()}.json`;
 await writeFile(join(root,name),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({artifact:join(root,name),accountPrepared:report.accountPrepared,checkpoint:report.checkpoint,
  measurements:report.measurements.length,budget:report.budget,accounting:report.accounting,errors:report.errors,
  acceptanceVersion,candidatePassed:report.candidatePassed,gate:report.comparison?.gate,splitGate:report.comparison?.splitGate,splitUsageGate:report.comparison?.splitUsageGate,cleanupConfirmed:report.cleanupConfirmed},null,2));
}
