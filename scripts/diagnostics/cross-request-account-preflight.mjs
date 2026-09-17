// Three metadata-only requests: cold, warm, invalidated. Never runs inference.
import {join,resolve,isAbsolute} from 'node:path';
import {mkdir,open,lstat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {readObserverPilotConfig,observerPilotEnvironment} from '../../dist/desktop/observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../../dist/estimation/observer-identity-runtime.js';
import {createAccountPreparationMetrics,readAccountCacheDiagnostic} from '../../dist/evaluation/account-preparation-metrics.js';

const [configPath,resourcesDirectory,outputDirectory]=process.argv.slice(2);
if(process.argv.length!==5||![configPath,resourcesDirectory,outputDirectory].every(p=>typeof p==='string'&&isAbsolute(p)))
 throw Error('EXPLICIT_PREFLIGHT_ARGUMENTS_REQUIRED');
const canonical=p=>resolve(p).toLowerCase();
if(!process.env.APPDATA||canonical(configPath)!==canonical(join(process.env.APPDATA,'codex-progress-hud','observer-pilot.json')))
 throw Error('PREFLIGHT_CONFIG_AUTHORITY_INVALID');
const config=await readObserverPilotConfig(configPath);
if(!config||config.version!=='0.153.4'||config.executableSha256!=='ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b')
 throw Error('PREFLIGHT_PIN_UNVERIFIED');
const root=resolve(outputDirectory);
await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink())throw Error('PREFLIGHT_OUTPUT_REPARSE');
// Reserve before touching the account; re-running a spent output cannot repeat work.
const output=await open(join(root,'cross-request-account-preflight.json'),'wx');
const result={mode:'cross-request-account-metadata-only',inferenceCalls:0,fullChecks:0,
 requests:[],originalEvidencePreserved:false,independentHandles:false,postInvalidationEvidenceChanged:false,
 cleanupConfirmed:false,error:null};
const metrics=createAccountPreparationMetrics(()=>performance.now());
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
let identity;
const started=performance.now();
try{
 identity=createObserverIdentityRuntime({...config,resourcesDirectory,
  powershell:join(process.env.SystemRoot??process.env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/powershell.exe'),
  environment:observerPilotEnvironment(config,process.env),
  onDiagnostic:entry=>{
   if(entry.stage==='account-read'&&entry.outcome==='passed')result.fullChecks++;
   if(['home-prepare','runtime-preflight','account-read','home-recheck','binding','ready'].includes(entry.stage)&&
    ['passed','failed','reader'].includes(entry.outcome)&&Number.isFinite(entry.elapsedMs)&&entry.elapsedMs>=0)
    result.lastPreparation={stage:entry.stage,outcome:entry.outcome,elapsedMs:entry.elapsedMs};
   const cache=readAccountCacheDiagnostic(entry.accountCache);
   if(cache)result.accountCache=cache;
  },
 });
 let firstEvidence,firstHandle;
 for(const mode of ['cold','warm','invalidated']){
  if(mode==='invalidated')identity.invalidateSessionReuse();
  const fullBefore=result.fullChecks,before=performance.now();
  let rawHandle;
  const prepared=await metrics.prepare(async()=>{
   const value=await identity.prepareSession(controller.signal,{accountCache:'allow'});
   rawHandle=value.reuse;return value;
  });
  const row={mode,prepareMs:performance.now()-before,fullChecks:result.fullChecks-fullBefore,
   accountCache:result.accountCache??null,claimed:false,validated:false};
  result.requests.push(row);
  if(mode==='cold'){firstEvidence=JSON.stringify(prepared.evidence);firstHandle=rawHandle;}
  if(mode==='warm'){
   result.originalEvidencePreserved=JSON.stringify(prepared.evidence)===firstEvidence;
   // Compare the raw handles before the metrics adapter creates wrappers.
   result.independentHandles=rawHandle!==undefined&&rawHandle!==firstHandle;
  }
  if(mode==='invalidated')result.postInvalidationEvidenceChanged=JSON.stringify(prepared.evidence)!==firstEvidence;
  const proof=await prepared.reuse?.claim(controller.signal);row.claimed=!!proof;
  row.validated=!!proof&&await proof.validate(controller.signal)&&proof.valid();
  prepared.reuse?.invalidate();
  if(!row.validated)throw Error('PREFLIGHT_PROOF_UNVERIFIED');
 }
 if(result.fullChecks!==2||result.requests[1].fullChecks!==0||result.accountCache?.hitCount!==1||!result.originalEvidencePreserved||
  !result.independentHandles||!result.postInvalidationEvidenceChanged)result.error='CACHE_BEHAVIOR_NOT_VERIFIED';
}catch{result.error=controller.signal.aborted?'PREFLIGHT_ABORTED':'PREFLIGHT_FAILED';}
finally{
 try{if(identity)await identity.close();result.cleanupConfirmed=true;}catch{result.error='PREFLIGHT_CLEANUP_UNCONFIRMED';}
 clearTimeout(timer);result.totalMs=performance.now()-started;result.accountPreparation=metrics.snapshot();
 try{await output.writeFile(JSON.stringify(result,null,2)+'\n');}finally{await output.close();}
 console.log(JSON.stringify(result,null,2));if(result.error)process.exitCode=1;
}
