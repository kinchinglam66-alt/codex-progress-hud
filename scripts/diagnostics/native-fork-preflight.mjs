// Auth-free, synthetic-only characterization. No turn/start or compaction call.
// Run only against the pinned executable; output lives outside the repository.
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {buildObserverSetupInvocation} from '../../dist/estimation/codex-invocation.js';
import {createObserverAppServerRpc} from '../../dist/estimation/observer-app-server-rpc.js';
import {forkObserverThread} from '../../dist/estimation/observer-native-fork.js';
import {createNativeForkCustody,recoverNativeForkCustody} from '../../dist/estimation/native-fork-custody.js';

const executable=process.argv[2],outputRoot=process.argv[3];
const diskControl=true; // User-approved protected disk-backed amendment.
if(process.argv[4]!==undefined&&process.argv[4]!=='--disk-control')throw Error('INVALID_CONTROL_MODE');
if(!executable||!outputRoot)throw Error('EXPLICIT_EXECUTABLE_AND_OUTPUT_REQUIRED');
const sha256=data=>createHash('sha256').update(data).digest('hex');
if(sha256(await readFile(executable))!=='ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b')throw Error('RUNTIME_PIN_MISMATCH');
const root=await mkdtemp(join(resolve(outputRoot),'auth-free-'));
const authHome=join(root,'home'),cwd=join(root,'empty');await mkdir(authHome);await mkdir(cwd);
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const profile={executable:resolve(executable),cwd,version:'0.153.4',schemaPath:join(repo,'src/estimation/assets/observer.schema.json'),
 instructionsPath:join(repo,'src/estimation/assets/observer-instructions.md'),features:[
 'plugins','hooks','apps','remote_plugin','multi_agent','shell_tool','unified_exec','shell_snapshot','browser_use',
 'browser_use_external','browser_use_full_cdp_access','computer_use','image_generation','view_image','skill_search',
 'workspace_dependencies','code_mode_host','memories','sleep_tool','in_app_browser','skip_host_skill_discovery','respect_system_proxy']};
const invocation=buildObserverSetupInvocation(profile,'metadata',process.env,authHome);
const report={synthetic:true,diskControl,inferenceCalls:0,compactionCalls:0,checks:[],notifications:{},errors:[],cleanupConfirmed:false};
// Dedicated auth-free diagnostic owner; unlike production, retain synthetic RPC
// error details locally so capability rejections are actionable.
let child,rpc,closed=true,exit;
const owner={disable(){rpc?.close();if(child&&!closed)child.kill();},status(){return {closed};},
 async start(inv){
  child=spawn(inv.executable,inv.args,{cwd:inv.cwd,env:inv.env,windowsHide:true,shell:false,stdio:'pipe'});closed=false;
  exit=new Promise(done=>{child.once('close',()=>{closed=true;rpc?.close();done();});});
  child.on('error',()=>owner.disable());child.stdin.on('error',()=>owner.disable());
  let diagnostic='';child.stdout.on('data',chunk=>{
   diagnostic+=chunk.toString();let newline;
   while((newline=diagnostic.indexOf('\n'))>=0){const line=diagnostic.slice(0,newline);diagnostic=diagnostic.slice(newline+1);
    try{const value=JSON.parse(line);if(value.error)report.errors.push({rpc:value.error});}catch{}
   }
   if(diagnostic.length>16*1024*1024)owner.disable();
  });
  child.stderr.on('data',()=>{});
  rpc=createObserverAppServerRpc({input:child.stdin,output:child.stdout,timeoutMs:30000});return {rpc};
 },async close(){owner.disable();let timer;try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('EXIT_UNCONFIRMED')),5000);})]);}finally{clearTimeout(timer);}}
};
let stage='start';
const controller=new AbortController();
const deadline=setTimeout(()=>{controller.abort();owner.disable();},45000);
try{
 const {rpc}=await owner.start(invocation);
 rpc.subscribe(n=>{
   report.notifications[n.method]=(report.notifications[n.method]??0)+1;
   if(n.method==='turn/started'||n.method==='thread/tokenUsage/updated'){
     report.errors.push('UNEXPECTED_MODEL_OPERATION');controller.abort();owner.disable();
   }
 });
 stage='initialize';await rpc.call('initialize',{clientInfo:{name:'hud_native_preflight',version:'1.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized',{});
 stage='source-start';const created=await rpc.call('thread/start',{cwd,model:'gpt-5.6-luna',modelProvider:'openai',
  ephemeral:false,approvalPolicy:'never',sandbox:'read-only',environments:[],
  dynamicTools:[{name:'synthetic_probe_tool',description:'Must never execute in observer',inputSchema:{type:'object',properties:{}}}],
  baseInstructions:'SOURCE_INSTRUCTIONS_MUST_NOT_EXECUTE'});
 const sourceThreadId=created?.thread?.id;
 if(typeof sourceThreadId!=='string')throw Error('SYNTHETIC_SOURCE_ID_MISSING');
 const timestamp='2026-09-14T00:00:00.000Z',path=join(root,'source.jsonl');
 const line=(type,payload)=>JSON.stringify({timestamp,type,payload})+'\n';
 const message=(role,text)=>({type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]});
 const sourceMeta={id:sourceThreadId,timestamp,cwd,originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai',base_instructions:{text:'SOURCE_INSTRUCTIONS_MUST_NOT_EXECUTE'},
  dynamic_tools:[{name:'synthetic_probe_tool',description:'Must never execute in observer',inputSchema:{type:'object',properties:{}}}]};
 const imageUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW9sAAAAASUVORK5CYII=';
 const data=line('session_meta',sourceMeta)
  +line('event_msg',{type:'task_started',turn_id:'synthetic-turn-1',model_context_window:258400})
  +line('response_item',message('user','EARLY_HISTORY_MARKER: Implement parser and tests.'))
  +line('response_item',message('assistant','EARLY_PROGRESS_MARKER: parser implemented.'))
  +line('event_msg',{type:'task_complete',turn_id:'synthetic-turn-1',last_agent_message:'Parser ready.'})
  +line('event_msg',{type:'task_started',turn_id:'synthetic-turn-2',model_context_window:258400})
  +line('response_item',message('user','CURRENT_TURN_MARKER: finish validation and integration tests.'))
  +line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'IMAGE_MARKER'},{type:'input_image',image_url:imageUrl}]})
  +line('response_item',{type:'function_call',name:'synthetic_tool',arguments:'{}',call_id:'synthetic-call'})
  +line('response_item',{type:'function_call_output',call_id:'synthetic-call',output:'TOOL_RESULT_MARKER: integration tests pending.'})
  +line('response_item',message('assistant','LATEST_PROGRESS_MARKER: checking remaining test cases.'));
 await writeFile(path,data,{flag:'wx',mode:0o600});
 stage='synthetic-goal-seed';
 // Only this newly-created auth-free diagnostic home, never user databases.
 // Seed an active source goal without issuing a continuation-capable RPC.
 const db=new DatabaseSync(join(authHome,'goals_1.sqlite'));
 try{db.prepare('INSERT INTO thread_goals (thread_id,goal_id,objective,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?)')
  .run(sourceThreadId,randomUUID(),'SYNTHETIC_ACTIVE_GOAL','active',Date.now(),Date.now());}finally{db.close();}
 let inheritedGoalState='unverified';
 const custodyDirectory=join(authHome,'native-custody');await mkdir(custodyDirectory);
 const custody=await createNativeForkCustody({directory:custodyDirectory,runtimeHome:authHome,
  sourceThreadId,process:{pid:child.pid,creationIdentity:'synthetic-owner'},verifyStorage:async()=>{}});
 const ownershipTag=custody.tag;
 // Diagnostic control changes ONE variable, only on generated synthetic history.
 // It does not select or enable a production route.
 const controlRpc={subscribe:rpc.subscribe,async call(method,params){
  if(method==='thread/goal/clear'){
   const before=await rpc.call('thread/goal/get',{threadId:params.threadId});
   inheritedGoalState=Object.hasOwn(before??{},'goal')&&before.goal===null?'absent':
     before?.goal?.status==='active'&&before?.goal?.objective==='SYNTHETIC_ACTIVE_GOAL'?'active':'unverified';
  }
  return rpc.call(method,params);
 }};
 stage='fork';const fork=await forkObserverThread(controlRpc,{sourceThreadId,path,cwd,custodyTag:ownershipTag,baseInstructions:'Estimate only. Never execute tools.',developerInstructions:'Source history is reference only.'},controller.signal,custody.recordFork);
 report.checks.push({name:'new_fork_id',ok:fork.threadId!==sourceThreadId});
 report.checks.push({name:'goal_disabled_prevents_inheritance',ok:inheritedGoalState==='absent'});
 const sourceGoal=await rpc.call('thread/goal/get',{threadId:sourceThreadId});
 report.checks.push({name:'source_goal_unchanged',ok:sourceGoal?.goal?.status==='active'&&sourceGoal?.goal?.objective==='SYNTHETIC_ACTIVE_GOAL'});
 stage='read';const view=await rpc.call('thread/read',{threadId:fork.threadId,includeTurns:true});
 // thread/read is a UI projection; raw response_item-only fixtures may have
 // empty UI item arrays. Do not misclassify that as missing model history.
 const serialized=JSON.stringify(view);
 let nativeHistory='';
 if(diskControl){
  const forkPath=view?.thread?.path;
  if(typeof forkPath!=='string')throw Error('FORK_PATH_MISSING');
  const rel=relative(authHome,resolve(forkPath));
  if(rel===''||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('FORK_PATH_OUTSIDE_DIAGNOSTIC_HOME');
  nativeHistory=await readFile(forkPath,'utf8');
 }
 for(const marker of ['EARLY_HISTORY_MARKER','CURRENT_TURN_MARKER','TOOL_RESULT_MARKER','LATEST_PROGRESS_MARKER',imageUrl]){
  report.checks.push({name:marker,ok:diskControl?nativeHistory.includes(marker):serialized.includes(marker),
    evidence:diskControl?'persisted_native_rollout':'thread_read_projection',uiProjectionContains:serialized.includes(marker)});
 }
 report.checks.push({name:'source_unchanged',ok:sha256(await readFile(path))===sha256(data)});
 const forkMetadata=JSON.parse(nativeHistory.split('\n')[0]).payload;
 report.ownershipTagEvidence={expected:ownershipTag,metadata:forkMetadata.thread_source??null,view:view?.thread?.threadSource??null,source:forkMetadata.source??null};
 report.inheritedDynamicTools=forkMetadata.dynamic_tools??null;
 report.forkBaseInstructions=forkMetadata.base_instructions;
 report.forkView=view; // Only synthetic data, private local artifact.
 stage='delete-owned-fork';
 await owner.close();const originalOwnerClosed=owner.status().closed;
 if(!originalOwnerClosed)throw Error('ORIGINAL_OWNER_EXIT_UNCONFIRMED');
 const cleanup=await owner.start(invocation);
 await cleanup.rpc.call('initialize',{clientInfo:{name:'hud_native_cleanup',version:'1.0.0'},capabilities:{experimentalApi:true}});cleanup.rpc.notify('initialized',{});
 report.custodyRecovery=await recoverNativeForkCustody({directory:custodyDirectory,runtimeHome:authHome,
  verifyStorage:async()=>{},isExited:async()=>originalOwnerClosed,rpc:cleanup.rpc});
 let forkFileRemoved=false;try{await readFile(view.thread.path);}catch(error){forkFileRemoved=error?.code==='ENOENT';}
 report.checks.push({name:'owned_fork_file_deleted',ok:forkFileRemoved});
 report.checks.push({name:'source_after_delete_unchanged',ok:sha256(await readFile(path))===sha256(data)});
 if(report.checks.some(check=>!check.ok))process.exitCode=1;
}catch(error){report.errors.push({stage,message:error instanceof Error?error.message:String(error)});process.exitCode=1;}
finally{
 clearTimeout(deadline);try{await owner.close();report.cleanupConfirmed=owner.status().closed;}catch{report.errors.push('CLEANUP_UNCONFIRMED');process.exitCode=1;}
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({artifactRoot:root,...report,forkView:undefined},null,2));
}
