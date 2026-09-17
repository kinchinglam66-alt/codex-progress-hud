// Explicit local account-metadata check only. No model, login, source history,
// credential-content reads, budget reset, or change to the installed HUD.
import {join,resolve,isAbsolute} from 'node:path';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {readObserverPilotConfig,observerPilotEnvironment} from '../../dist/desktop/observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../../dist/estimation/observer-identity-runtime.js';
import {createAccountPreparationMetrics} from '../../dist/evaluation/account-preparation-metrics.js';

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
const result={mode:'account-metadata-only',inferenceCalls:0,fullChecks:0,issued:false,claimed:false,validated:false,
 fullPrepareMs:null,claimMs:null,finalGuardMs:null,totalMs:null,cleanupConfirmed:false,error:null};
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
const accountMetrics=createAccountPreparationMetrics(()=>performance.now());
const identity=createObserverIdentityRuntime({...config,resourcesDirectory,
 powershell:join(process.env.SystemRoot??process.env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/powershell.exe'),
 environment:observerPilotEnvironment(config,process.env),
 onDiagnostic:entry=>{if(entry.stage==='account-read'&&entry.outcome==='passed')result.fullChecks++;},
});
const started=performance.now();
try{
 const first=await accountMetrics.prepare(()=>identity.prepareSession(controller.signal));result.fullPrepareMs=performance.now()-started;
 result.issued=first.reuse!==undefined;
 const claimStart=performance.now(),proof=await first.reuse?.claim(controller.signal);
 result.claimMs=performance.now()-claimStart;result.claimed=proof!==undefined&&proof!==null;
 const guardStart=performance.now();result.validated=proof?await proof.validate(controller.signal)&&proof.valid():false;
 result.finalGuardMs=performance.now()-guardStart;
 first.reuse?.invalidate();
 if(!result.validated)result.error='REUSE_NOT_VERIFIED';
}catch{result.error=controller.signal.aborted?'PREFLIGHT_ABORTED':'PREFLIGHT_FAILED';}
finally{
 result.accountPreparation=accountMetrics.snapshot();
 try{await identity.close();result.cleanupConfirmed=true;}catch{result.error='PREFLIGHT_CLEANUP_UNCONFIRMED';}
 clearTimeout(timer);result.totalMs=performance.now()-started;
 await writeFile(join(root,'account-reuse-preflight.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(result,null,2));
 if(result.error)process.exitCode=1;
}
