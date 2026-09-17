// Synthetic and auth-free. Exercise REAL Windows storage, process identity,
// raw-copy custody and fork cleanup; no login, turn/start or compaction RPC.
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {createNativeStorage} from '../../dist/estimation/native-storage.js';
import {createNativeWorkerResources} from '../../dist/estimation/native-worker-resources.js';
import {createNativeSourceSnapshot} from '../../dist/observer/native-source-snapshot.js';
import {createObserverSessionProcess} from '../../dist/estimation/observer-session-process.js';
import {forkObserverThread} from '../../dist/estimation/observer-native-fork.js';
import {buildObserverSetupInvocation} from '../../dist/estimation/codex-invocation.js';
import {resolveTrustedPowerShellPath} from '../../dist/estimation/recovery-boot-boundary.js';
import {createNativeComparisonFixtures} from '../../dist/evaluation/native-comparison-fixture.js';

const [executable,outputRoot,fixtureOption]=process.argv.slice(2);
if(!executable||!outputRoot||process.argv.length>5||(fixtureOption!==undefined&&!/^--comparison-fixture=[012]$/.test(fixtureOption)))throw Error('EXPLICIT_EXECUTABLE_AND_OUTPUT_REQUIRED');
const hash=value=>createHash('sha256').update(value).digest('hex');
if(hash(await readFile(executable))!=='ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b')throw Error('RUNTIME_PIN_MISMATCH');
const root=await mkdtemp(join(resolve(outputRoot),'resource-auth-free-')),runtimeHome=join(root,'observer-auth'),cwd=join(root,'empty');
await mkdir(cwd);
await promisify(execFile)(resolveTrustedPowerShellPath(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
 '-File',resolve('scripts/windows/observer-home.ps1'),'-ParentDirectory',root],{windowsHide:true,timeout:10000});
const profile={executable:resolve(executable),cwd,version:'0.153.4',schemaPath:resolve('src/estimation/assets/observer.schema.json'),
 instructionsPath:resolve('src/estimation/assets/observer-instructions.md'),features:[
 'plugins','hooks','apps','remote_plugin','multi_agent','shell_tool','unified_exec','shell_snapshot','browser_use',
 'browser_use_external','browser_use_full_cdp_access','computer_use','image_generation','view_image','skill_search',
 'workspace_dependencies','code_mode_host','memories','sleep_tool','in_app_browser','skip_host_skill_discovery','respect_system_proxy']};
const setup=buildObserverSetupInvocation(profile,'metadata',process.env,runtimeHome);
// Match the estimate owner's setup. Goal suppression belongs to thread/fork;
// globally disabling goals can also disable its clear/get verification RPCs.
const invocation=setup;
const cleanupInvocation={...setup,args:[...setup.args,'-c','features.goals=false','-c','features.tool_suggest=false','-c','features.in_app_local_automation=false']};
const sourceThreadId=randomUUID(),sourcePath=join(root,'synthetic.jsonl'),timestamp='2026-09-14T00:00:00.000Z';
const line=(type,payload)=>JSON.stringify({timestamp,type,payload})+'\n';
const comparisonFixture=fixtureOption===undefined?undefined:createNativeComparisonFixtures({sourceThreadId,cwd})[Number(fixtureOption.at(-1))];
const currentTurnId=comparisonFixture?.currentTurnId??'synthetic-turn';
const data=comparisonFixture?.rollout??line('session_meta',{id:sourceThreadId,timestamp,cwd,originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai'})
 +line('event_msg',{type:'task_started',turn_id:'synthetic-turn',model_context_window:258400})
 +Array.from({length:512},(_,i)=>line('response_item',{type:'message',role:i%2?'assistant':'user',
 content:[{type:i%2?'output_text':'input_text',text:`SYNTHETIC_${i}: ${'parser validation integration test facts. '.repeat(5)}`}]})).join('');
await writeFile(sourcePath,data,{flag:'wx',mode:0o600});
const report={synthetic:true,authenticated:false,inferenceCalls:0,compactionCalls:0,sourceBytes:Buffer.byteLength(data),fixtureIndex:comparisonFixture?.index,
 phases:{},storageChecks:0,storageCheckMs:0,checks:[],errors:[],cleanupConfirmed:false};
const measure=async(name,work)=>{const start=performance.now();try{return await work();}finally{report.phases[name]=(report.phases[name]??0)+performance.now()-start;}};
const storage=createNativeStorage(runtimeHome);
const measuredStorage={prepare:signal=>storage.prepare(signal),verify:async signal=>{
 const start=performance.now();report.storageChecks++;try{await storage.verify(signal);}finally{report.storageCheckMs+=performance.now()-start;}
}};
const resources=createNativeWorkerResources({runtimeHome,maxSourceBytes:1024*1024,storage:measuredStorage,
 prepareCleanupInvocation:async()=>cleanupInvocation});
const owner=createObserverSessionProcess(),controller=new AbortController();
const deadline=setTimeout(()=>{controller.abort();owner.disable();},120000);
let snapshot,claim,unsubscribe;
try{
 const destination=await measure('destinationMs',()=>resources.destination(controller.signal));
 snapshot=await measure('snapshotMs',()=>createNativeSourceSnapshot({sourcePath,sourceRoot:root,sourceThreadId,sourceEpoch:1,revision:1,
  byteWatermark:Buffer.byteLength(data),signal:controller.signal,...destination}));
 const opened=await measure('processMs',()=>owner.start(invocation));
 unsubscribe=opened.rpc.subscribe(n=>{
  if(['turn/started','thread/tokenUsage/updated','item/started'].includes(n.method)){
   report.errors.push('UNEXPECTED_MODEL_OPERATION');controller.abort();owner.disable();
  }
 });
 await measure('initializeMs',async()=>{
  await opened.rpc.call('initialize',{clientInfo:{name:'hud_resource_preflight',version:'1.0.0'},capabilities:{experimentalApi:true}});
  opened.rpc.notify('initialized',{});
 });
 claim=await measure('claimMs',()=>resources.claim({snapshot:{...snapshot,sourceTurnId:currentTurnId},currentTurnId},
  invocation,{pid:opened.pid,creationIdentity:opened.creationIdentity},controller.signal));
 await measure('forkMs',()=>forkObserverThread(opened.rpc,{sourceThreadId,path:snapshot.path,cwd,custodyTag:claim.tag,
  baseInstructions:'Estimate only; never execute tools.',developerInstructions:'Synthetic reference only.'},controller.signal,claim.recordFork));
 await measure('processCloseMs',()=>owner.close());
 await measure('forkCleanupMs',()=>claim.afterProcessClosed());claim=undefined;
 await measure('snapshotCloseMs',()=>snapshot.close());snapshot=undefined;
 await measure('resourceReleaseMs',()=>resources.release());
 report.checks.push({name:'source_unchanged',ok:hash(await readFile(sourcePath))===hash(data)});
 report.checks.push({name:'snapshot_custody_empty',ok:(await readdir(join(runtimeHome,'hud-native','snapshots'))).length===0});
 report.checks.push({name:'fork_custody_empty',ok:(await readdir(join(runtimeHome,'hud-native','custody'))).length===0});
 report.cleanupConfirmed=owner.status().closed&&report.checks.every(c=>c.ok);
}catch(error){report.errors.push(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally{
 clearTimeout(deadline);unsubscribe?.();
 try{await owner.close();}catch{report.errors.push('PROCESS_EXIT_UNCONFIRMED');}
 // On failure retain custody for a separate explicit diagnostic; no hidden retry.
 if(report.errors.length||!report.cleanupConfirmed)process.exitCode=1;
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({artifactRoot:root,...report},null,2));
}
