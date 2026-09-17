// Synthetic-only pinned protocol check. No inference or compaction RPC is allowed.
import {mkdir,readFile,writeFile,copyFile,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

export function buildCompletedTurnPreflightSource(cwd,{previousTerminal='task_complete',firstTurn=false,earlierFailure=false}={}){
 if(!['task_complete','task_failed','turn_aborted'].includes(previousTerminal))throw Error('PREFLIGHT_TERMINAL_INVALID');
 const sourceThreadId='99999999-9999-4999-8999-999999999999';
 let tick=0,rollout='',baseBytes=0,lastTurnId;
 const add=(type,payload)=>{rollout+=JSON.stringify({timestamp:new Date(Date.UTC(2026,8,15,12,0,tick++)).toISOString(),type,payload})+'\n';};
 add('session_meta',{id:sourceThreadId,cli_version:'0.153.4',model_provider:'openai',history_mode:'legacy',
  timestamp:'2026-09-15T12:00:00.000Z',cwd,originator:'codex_cli_rs',base_instructions:{text:'Synthetic reference only; do not execute tools.'},source:'cli'});
 for(let n=firstTurn?7:1;n<=7;n++){
  const turnId=`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
  add('event_msg',{type:'task_started',turn_id:turnId});
  add('response_item',{type:'message',id:`u${n}`,role:'user',turn_id:turnId,
   content:[{type:'input_text',text:n===7?'ACTIVE_SEVEN request':'HISTORY_'+n+' request'}]});
  add('event_msg',{type:'user_message',message:n===7?'ACTIVE_SEVEN request':'HISTORY_'+n+' request',images:[],local_images:[],text_elements:[]});
  add('response_item',{type:'message',id:`a${n}`,role:'assistant',turn_id:turnId,phase:n===7?'commentary':'final_answer',
   content:[{type:'output_text',text:n===7?'ACTIVE_SEVEN checkpoint':'HISTORY_'+n+' finished'}]});
  add('event_msg',{type:'agent_message',message:n===7?'ACTIVE_SEVEN checkpoint':'HISTORY_'+n+' finished',phase:n===7?'commentary':'final_answer'});
  if(n<7){const type=n===6?previousTerminal:n===5&&earlierFailure?'task_failed':'task_complete';
   add('event_msg',{type,turn_id:turnId,...(type==='turn_aborted'?{reason:'interrupted'}:type==='task_failed'?{error:'synthetic failure'}:{last_agent_message:`HISTORY_${n} finished`})});baseBytes=Buffer.byteLength(rollout);lastTurnId=turnId;}
 }
 return {sourceThreadId,rollout,baseBytes,lastTurnId};
}

/** Synthetic fixture variant only: preserve every other serialized source line. */
export function withCurrentTurnImage(rollout){
 const lines=rollout.trimEnd().split('\n'),rows=lines.map(line=>JSON.parse(line));
 const matches=rows.flatMap((row,index)=>row.type==='response_item'&&row.payload?.id==='current-request'&&row.payload.role==='user'?[index]:[]);
 const image=rows.find(row=>row.type==='response_item'&&row.payload?.id==='past-reference-image')?.payload?.content?.find(part=>part.type==='input_image');
 const active=rows.filter(row=>row.type==='event_msg'&&row.payload?.type==='task_started').at(-1)?.payload?.turn_id;
 if(matches.length!==1||!image||!/^data:image\/png;base64,/.test(image.image_url))throw Error('MIXED_FIXTURE_INVALID');
 const index=matches[0],row=rows[index];
 if(row.payload.turn_id!==active||!Array.isArray(row.payload.content)||row.payload.content.some(part=>part.type!=='input_text'))throw Error('MIXED_FIXTURE_INVALID');
 row.payload.content.push({...image});lines[index]=JSON.stringify(row);
 return lines.join('\n')+'\n';
}

export function createNoModelForkGuard(call,rootId){
 let expected,baseId,cleanExpected=false;const owned=new Set();let childCount=0,cleanCount=0;
 return {
  expectClean(){if(expected||cleanExpected||baseId)throw Error('PREFLIGHT_CLEAN_UNEXPECTED');cleanExpected=true;},
  expectFork(value){
   if(expected||cleanExpected||cleanCount)throw Error('PREFLIGHT_FORK_PENDING');
   if(!value.lastTurnId||!['base','child'].includes(value.role)||
    (value.role==='base'?(baseId||value.threadId!==rootId||!value.path):(!baseId||value.threadId!==baseId||Object.hasOwn(value,'path'))))throw Error('PREFLIGHT_FORK_PARENT');
   expected={...value};
  },
  async call(method,params){
   if(!['initialize','thread/start','thread/fork','thread/read','thread/goal/clear','thread/goal/get'].includes(method))throw Error('PREFLIGHT_RPC_FORBIDDEN');
   if(method==='initialize')return call(method,params);
   if(method==='thread/start'){
    const permitted=cleanExpected;cleanExpected=false;
    if(!permitted||params?.ephemeral!==true)throw Error('PREFLIGHT_CLEAN_UNEXPECTED');
    const response=await call(method,params),id=response?.thread?.id;
    if(typeof id!=='string'||!id||id===rootId||owned.has(id))throw Error('PREFLIGHT_FORK_ID');
    owned.add(id);cleanCount++;return response;
   }
   if(method!=='thread/fork'){
    if(!owned.has(params?.threadId))throw Error('PREFLIGHT_UNOWNED_THREAD');
    return call(method,params);
   }
   const entry=expected;expected=undefined;
   if(!entry||params?.threadId!==entry.threadId||params?.path!==entry.path||params?.lastTurnId!==entry.lastTurnId)throw Error('PREFLIGHT_FORK_UNEXPECTED');
   const response=await call(method,params),id=response?.thread?.id;
   if(typeof id!=='string'||!id||id===rootId||owned.has(id))throw Error('PREFLIGHT_FORK_ID');
   owned.add(id);if(entry.role==='base')baseId=id;else childCount++;
   return response;
  },
  summary:()=>({baseCount:baseId?1:0,childCount,...(cleanCount?{cleanCount}:{}),modelCalls:0}),
 };
}

export function createNoModelPreparationGuard(call,rootId,lastTurnId){
 const guard=createNoModelForkGuard(call,rootId),children=new Set();let baseId;
 return {
  get baseId(){return baseId;},get childIds(){return [...children];},summary:guard.summary,
  async call(method,params){
   if(method==='thread/inject_items'){
    if(!children.has(params?.threadId))throw Error('PREFLIGHT_UNOWNED_INJECTION');
    return call(method,params);
   }
   if(method==='thread/fork'){
    const role=baseId?'child':'base';
    guard.expectFork({role,threadId:role==='base'?rootId:baseId,lastTurnId,...(role==='base'?{path:params?.path}:{})});
    const response=await guard.call(method,params);
    if(role==='base')baseId=response.thread.id;else children.add(response.thread.id);
    return response;
   }
   return guard.call(method,params);
  },
 };
}

async function main(){
 const [configPath,outputDirectory,mode]=process.argv.slice(2);
 if(process.argv.length!==5||!isAbsolute(configPath??'')||!isAbsolute(outputDirectory??'')||!['--preflight','--preflight-failed','--preflight-aborted','--preflight-first','--preflight-earlier-failed','--preflight-worker','--preflight-worker-large-readback','--preflight-worker-qualification-readback','--preflight-worker-mixed-readback','--preflight-worker-resource-profile','--preflight-worker-resource-idle-profile','--preflight-worker-resource-retained-profile'].includes(mode))throw Error('EXPLICIT_PREFLIGHT_ARGUMENTS_REQUIRED');
 const retainNativeGuard=mode==='--preflight-worker-resource-retained-profile';
 const resourceIdleProfile=retainNativeGuard||mode==='--preflight-worker-resource-idle-profile';
 const resourceProfile=resourceIdleProfile||mode==='--preflight-worker-resource-profile';
 const mixedReadback=mode==='--preflight-worker-mixed-readback';
 const qualificationReadback=resourceProfile||mixedReadback||mode==='--preflight-worker-qualification-readback';
 const largeWorker=qualificationReadback||mode==='--preflight-worker-large-readback';
 const canonical=p=>resolve(p).toLowerCase();
 if(!process.env.APPDATA||canonical(configPath)!==canonical(join(process.env.APPDATA,'codex-progress-hud','observer-pilot.json')))throw Error('TRIAL_CONFIG_AUTHORITY_INVALID');
 const root=resolve(outputDirectory);
 // New audit directory only: never overwrite an earlier failed experiment.
 await mkdir(root);if((await lstat(root)).isSymbolicLink())throw Error('TRIAL_OUTPUT_REPARSE');
 const resourcesDirectory=join(root,'resources');await mkdir(join(resourcesDirectory,'observer-assets'),{recursive:true});
 const hash=x=>createHash('sha256').update(x).digest('hex');
 for(const name of ['observer.schema.json','observer-instructions.md','context-summary.schema.json','context-summary-instructions.md'])
  await copyFile(resolve('src/estimation/assets',name),join(resourcesDirectory,'observer-assets',name),constants.COPYFILE_EXCL);
 await copyFile(resolve('scripts/windows/observer-home.ps1'),join(resourcesDirectory,'observer-home.ps1'),constants.COPYFILE_EXCL);
 if(resourceProfile)await copyFile(resolve('scripts/windows/native-guard.ps1'),join(resourcesDirectory,'native-guard.ps1'),constants.COPYFILE_EXCL);
 const {readObserverPilotConfig,observerPilotEnvironment}=await import('../../dist/desktop/observer-pilot-config.js');
 const {createObserverIdentityRuntime}=await import('../../dist/estimation/observer-identity-runtime.js');
 const {createNativeObserverTrial}=await import('../../dist/desktop/native-observer-trial.js');
 const {createObserverSessionProcess}=await import('../../dist/estimation/observer-session-process.js');
 const {createPersistentObserverSession}=await import('../../dist/estimation/observer-persistent-session.js');
 const {createPersistentReceiptJournal}=await import('../../dist/estimation/observer-persistent-receipt.js');
 const {createLocalSessionReader}=await import('../../dist/observer/local-session-reader.js');
 const config=await readObserverPilotConfig(configPath);
 if(!config||config.version!=='0.153.4'||config.executableSha256!=='ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b')throw Error('TRIAL_PIN_UNVERIFIED');
 const options={...config,resourcesDirectory,powershell:join(process.env.SystemRoot??process.env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/powershell.exe'),environment:observerPilotEnvironment(config,process.env)};
 const remoteErrors=[];
 const identity=createObserverIdentityRuntime(options),owner=createObserverSessionProcess({onRemoteError:error=>{
  if(remoteErrors.length>=8)return;
  // Bounded categories only. Never retain a remote error message or its paths.
  remoteErrors.push({code:error.code,subjects:['turn','thread','rollout','path','sandbox','config','model','goal','history','instruction'].filter(x=>error.message.toLowerCase().includes(x)),
   reasons:['not found','unknown','invalid','unsupported','not supported','deserialize','parse','missing','failed','permission','read-only','not loaded','in progress'].filter(x=>error.message.toLowerCase().includes(x))});
 }}),controller=new AbortController();
 // The large fixture has a 1MiB historical body plus envelopes and turn 7/8.
 // Match the existing comparison's 2MiB synthetic bound, not production limits.
 const resources=createNativeObserverTrial(options,{maxSourceBytes:(largeWorker?2:1)*1024*1024,mode:'completed-turn',retainNativeGuard,...(resourceProfile?{reuseNativeGuard:true}:{})});
 const sourceRoot=join(root,'synthetic-source'),sourceDay=join(sourceRoot,'2026','09','15');await mkdir(sourceDay,{recursive:true});
 const previousTerminal=mode==='--preflight-failed'?'task_failed':mode==='--preflight-aborted'?'turn_aborted':'task_complete';
 const firstTurn=mode==='--preflight-first';
 let source=buildCompletedTurnPreflightSource(config.cwd,{previousTerminal,firstTurn,earlierFailure:mode==='--preflight-earlier-failed'});
 if(largeWorker){
  const {createCompletedTurnComparisonFixtures}=await import('../../dist/evaluation/native-comparison-fixture.js');
  const fixture=createCompletedTurnComparisonFixtures({sourceThreadId:source.sourceThreadId,cwd:config.cwd,targetBytes:1024*1024,
   ...(qualificationReadback?{qualification:true,qualificationNonce:randomUUID()}:{})})[qualificationReadback?0:2];
  source={sourceThreadId:fixture.sourceThreadId,rollout:fixture.rollout,lastTurnId:fixture.lastCompletedTurnId};
  if(mixedReadback)source.rollout=withCurrentTurnImage(source.rollout);
 }
 const sourcePath=join(sourceDay,`rollout-2026-09-15-${source.sourceThreadId}.jsonl`);
 await writeFile(sourcePath,source.rollout,{flag:'wx'});
 const reader=createLocalSessionReader({root:sourceRoot}),journal=createPersistentReceiptJournal(join(root,'receipts'));
 const ownerUuid=randomUUID(),sourceKey='completed-turn-preflight',sourceEpoch='synthetic-only';
 const report={synthetic:true,mode,previousTerminal,runId:ownerUuid,pinnedVersion:config.version,modelCalls:0,compactions:0,
  scope:'native cutoff/fork/custody protocol only; not model context access, latency gate or ETA accuracy',checks:[],phases:[],rpcTimings:[],nativeTurnTimings:[],errors:[],remoteErrors,cleanupConfirmed:false};
 let active='setup',pair,snapshot,ownerRecorded=false,guard,worker,workerLedger;
 const claims=[];
 const phase=async(name,work)=>{active=name;const start=performance.now();try{return await work();}finally{report.phases.push({name,elapsedMs:performance.now()-start});}};
 const timer=setTimeout(()=>{controller.abort();owner.disable();},90000);
 const onInterrupt=()=>{controller.abort();owner.disable();};process.once('SIGINT',onInterrupt);
 try{
  await phase('source_read',()=>reader.read(source.sourceThreadId,controller.signal));
  pair=await reader.openNativeTurn(source.sourceThreadId,controller.signal);
  if(mode==='--preflight-worker'||largeWorker){
   const {createPersistentObserverWorker}=await import('../../dist/estimation/observer-persistent-worker.js');
   const {openReleaseAccounting}=await import('../../dist/estimation/release-accounting.js');
   await mkdir(join(root,'worker-ledger'));workerLedger=await openReleaseAccounting(join(root,'worker-ledger'),Date.now);
   const accounting={...workerLedger,forConversation:key=>({...workerLedger.forConversation(key),reserve:async()=>{throw Error('PREFLIGHT_MODEL_ADMISSION_FORBIDDEN');}})};
   let readbackTarget,baseReadbackTarget,acknowledgedCalls=0;const acknowledgedItems=[];
   const processFactory=()=>({...owner,start:async invocation=>{
    const opened=await owner.start(invocation);guard=createNoModelPreparationGuard(opened.rpc.call,source.sourceThreadId,source.lastTurnId);
    opened.rpc.call=async(method,params)=>{
     const rpcStart=performance.now();let result;
     try{result=await guard.call(method,params);}
     finally{if(report.rpcTimings.length<100)report.rpcTimings.push({method,elapsedMs:performance.now()-rpcStart});}
     if(method==='thread/fork'&&guard.childIds.includes(result?.thread?.id)){
      readbackTarget={runtimeHome:invocation.env.CODEX_HOME,path:result.thread.path,
       sourceThreadId:source.sourceThreadId,forkThreadId:result.thread.id,custodyTag:params.threadSource};
     }
     if(method==='thread/fork'&&guard.baseId===result?.thread?.id){
      baseReadbackTarget={runtimeHome:invocation.env.CODEX_HOME,path:result.thread.path,
       sourceThreadId:source.sourceThreadId,forkThreadId:result.thread.id,custodyTag:params.threadSource};
     }
     if(method==='thread/inject_items'&&guard.childIds.includes(params.threadId)&&result&&Object.keys(result).length===0){
      acknowledgedCalls++;
      acknowledgedItems.push(...structuredClone(params.items));
     }
     return result;
    };return opened;
   }});
   worker=createPersistentObserverWorker({accounting,nativeContext:resources,completedTurnContext:true,reuseNativeTurnSession:qualificationReadback,
    onNativeTurnTiming:event=>{if(report.nativeTurnTimings.length<100)report.nativeTurnTimings.push(event);},
    processFactory,prepareSession:async signal=>{
     const p=await identity.prepareSession(signal,{accountCache:'bypass'});
     return {invocation:p.invocation,validateAcceptance:p.validateAcceptance,reuse:p.reuse,binding:{accountFingerprint:p.evidence.accountFingerprint,routeFingerprint:p.evidence.routeFingerprint,assetsFingerprint:p.evidence.assetsFingerprint}};
    },authorize:()=>!controller.signal.aborted,now:Date.now,outputSchema:{type:'object'},receiptDirectory:join(root,'worker-receipts'),nativeInstructions:'Synthetic reference only; no tools or model work in this preflight.'});
   const prepared=await phase('worker_preparation',()=>worker.prepareNativeTurnContext({goalSummary:'Synthetic active seventh',runtime:'running',activeSeconds:10,messages:[{kind:'user',text:'ACTIVE_SEVEN request',truncated:false}],truncated:false},pair,controller.signal,'synthetic-preflight',0,0));
   if(!prepared.representation.sourceComplete||guard.childIds.length!==1)throw Error('PREFLIGHT_WORKER_INCOMPLETE');
   report.checks.push({label:'worker',sourceComplete:prepared.representation.sourceComplete,importedRecords:prepared.representation.importedRecords,baseCount:guard.summary().baseCount,childCount:guard.childIds.length});
   if(!readbackTarget)throw Error('PREFLIGHT_READBACK_TARGET_MISSING');
   const {readOwnedNativeRollout}=await import('../../dist/evaluation/native-owned-checkpoint.js');
   const {compareSupplementReadback}=await import('../../dist/evaluation/native-supplement-readback.js');
   const {createNativeStorage}=await import('../../dist/estimation/native-storage.js');
   const storage=createNativeStorage(readbackTarget.runtimeHome);
   const stored=await phase('worker_supplement_readback',()=>readOwnedNativeRollout({...readbackTarget,maxBytes:2*1024*1024,verifyStorage:()=>storage.verify(controller.signal)}));
   const comparison=compareSupplementReadback(acknowledgedItems,stored);
   report.checks.push({label:'worker_supplement_readback',acknowledgedCalls,...comparison});
   if(!comparison.exact)throw Error('PREFLIGHT_SUPPLEMENT_READBACK_MISMATCH');
   if(mixedReadback){
    const imageParts=acknowledgedItems.flatMap(item=>item.content??[]).filter(part=>part.type==='input_image').length;
    report.checks.push({label:'mixed_supplement',imageParts,acknowledgedCalls});
    if(imageParts!==1||acknowledgedCalls!==1)throw Error('PREFLIGHT_MIXED_BATCH_MISMATCH');
   }
   if(qualificationReadback){
    const {collectSourceReadback}=await import('../../dist/evaluation/native-source-readback.js');
    if(!baseReadbackTarget)throw Error('PREFLIGHT_READBACK_TARGET_MISSING');
    const evidence=await collectSourceReadback(source.rollout.trimEnd().split('\n').map(line=>JSON.parse(line)),[
     {role:'base',read:()=>readOwnedNativeRollout({...baseReadbackTarget,maxBytes:2*1024*1024,verifyStorage:()=>storage.verify(controller.signal)})},
     {role:'child',read:async()=>stored}
    ]);
    report.checks.push({label:'first_source_user_readback',scope:'local persisted history; not remote model visibility',evidence});
    if(evidence.some(row=>row.firstUserExact!==true||row.sourceUserOccurrences!==1))throw Error('PREFLIGHT_FIRST_SOURCE_USER_MISMATCH');
   }
   if(resourceProfile){
    for(const label of ['resource_usage_first','resource_usage_cached']){
     const usage=await phase(label,()=>resources.usage());
     report.checks.push({label,...usage});
    }
    if(resourceIdleProfile){
     await phase('resource_idle_wait',()=>new Promise(resolve=>setTimeout(resolve,31000)));
     controller.signal.throwIfAborted();
     report.checks.push({label:'resource_usage_after_idle',...await phase('resource_usage_after_idle',()=>resources.usage())});
    }
   }
   await pair.validate(controller.signal);report.forks=guard.summary();
   return;
  }
  if(firstTurn){if(pair.boundary.completed!==null)throw Error('PREFLIGHT_SOURCE_BOUNDARY');}
  else{
  if(pair.boundary.completed?.turnId!==source.lastTurnId||pair.boundary.completed?.endOffset!==source.baseBytes)throw Error('PREFLIGHT_SOURCE_BOUNDARY');
  const destination=await phase('storage',()=>resources.destination(controller.signal,'base'));
  snapshot=await phase('base_copy',()=>pair.openBase(destination,controller.signal));
  if(!snapshot||snapshot.byteLength!==source.baseBytes)throw Error('PREFLIGHT_BASE_BOUNDARY');
  }
  // Use the estimator's real invocation profile. Cleanup-only servers disable
  // goal APIs and cannot validate the fork's goal-clear/goal-get contract.
  // Account metadata inspection does not admit a model operation.
  const prepared=await phase('account_runtime_attestation',()=>identity.prepareSession(controller.signal,{accountCache:'bypass'}));
  const invocation=prepared.invocation;
  const opened=await phase('process_start',()=>owner.start(invocation));
  await phase('owner_receipt',()=>journal.ownerStarted({ownerUuid,sourceKey,sourceEpoch,pid:opened.pid,creationIdentity:opened.creationIdentity,
   binding:{accountFingerprint:prepared.evidence.accountFingerprint,routeFingerprint:prepared.evidence.routeFingerprint,assetsFingerprint:prepared.evidence.assetsFingerprint}}));ownerRecorded=true;
  guard=createNoModelForkGuard(opened.rpc.call,source.sourceThreadId);opened.rpc.call=guard.call;
  opened.rpc.subscribe(n=>{if(['turn/started','item/started'].includes(n.method)){report.errors.push('PREFLIGHT_UNEXPECTED_ACTIVITY');controller.abort();owner.disable();}});
  await phase('initialize',()=>opened.rpc.call('initialize',{clientInfo:{name:'hud_completed_turn_preflight',version:'1.0.0'},capabilities:{experimentalApi:true}}));opened.rpc.notify('initialized',{});
  const processIdentity={pid:opened.pid,creationIdentity:opened.creationIdentity};
  const makeSession=()=>createPersistentObserverSession(opened.rpc,{cwd:config.cwd,outputSchema:{type:'object'},now:Date.now,nativeInstructions:'Synthetic protocol check. No model work or tools.'});
  if(firstTurn){
   for(let index=1;index<=2;index++){
    const session=makeSession();guard.expectClean();await phase(`clean_${index}_start`,()=>session.start());
    if(!session.status().threadId||session.status().nativeFork)throw Error('PREFLIGHT_CLEAN_INVALID');
   }
   let records=0;for await(const _row of pair.supplement.records(controller.signal))records++;
   if(!pair.supplement.coverage.complete||!records)throw Error('PREFLIGHT_FIRST_CONTEXT_INCOMPLETE');
   report.checks.push({label:'first_turn',historicalBase:false,wholeSupplement:true,records});
  }else{
  const baseClaim=await phase('base_claim',()=>resources.claim({snapshot,currentTurnId:pair.currentTurnId},invocation,processIdentity,controller.signal));claims.push(baseClaim);
  const baseSession=makeSession();
  guard.expectFork({role:'base',threadId:source.sourceThreadId,path:snapshot.path,lastTurnId:source.lastTurnId});
  let baseId;
  await phase('base_fork',()=>baseSession.startNative({kind:'snapshot',sourceThreadId:source.sourceThreadId,path:snapshot.path,lastTurnId:source.lastTurnId,custodyTag:baseClaim.tag},controller.signal,async id=>{await baseClaim.recordFork(id);baseId=id;}));
  const readCheck=async(id,label)=>{
   const result=await opened.rpc.call('thread/read',{threadId:id,includeTurns:true});
   const turns=result?.thread?.turns,text=JSON.stringify(turns);
   report.checks.push({label,turnCount:Array.isArray(turns)?turns.length:null,
    terminalCount:Array.isArray(turns)?turns.filter(t=>t.status==='completed').length:null,
    itemCount:Array.isArray(turns)?turns.reduce((n,t)=>n+(Array.isArray(t.items)?t.items.length:0),0):null,
    lastTurnIdPresent:Array.isArray(turns)&&turns.some(t=>t.id===source.lastTurnId),
    historyMarkerPresent:typeof text==='string'&&text.includes('HISTORY_6'),activeMarkerPresent:typeof text==='string'&&text.includes('ACTIVE_SEVEN')});
   if(!Array.isArray(turns)||turns.length!==6||!text.includes('HISTORY_6')||text.includes('ACTIVE_SEVEN'))throw Error('PREFLIGHT_INHERITED_TURNS');
   report.checks.push({label,terminalTurns:turns.length,excludedCurrent:true});return hash(text);
  };
  const before=await readCheck(baseId,'base');
  for(let index=1;index<=2;index++){
   const claim=await resources.claimChild({baseThreadId:baseId,rootSourceThreadId:source.sourceThreadId},invocation,processIdentity,controller.signal);claims.push(claim);
   const child=makeSession();guard.expectFork({role:'child',threadId:baseId,lastTurnId:source.lastTurnId});let childId;
   await phase(`child_${index}_fork`,()=>child.startNative({kind:'owned-base',sourceThreadId:baseId,rootSourceThreadId:source.sourceThreadId,lastTurnId:source.lastTurnId,custodyTag:claim.tag},controller.signal,async id=>{await claim.recordFork(id);childId=id;}));
   await readCheck(childId,`child_${index}`);
  }
  if(await readCheck(baseId,'base_after_children')!==before)throw Error('PREFLIGHT_BASE_CHANGED');
  }
  await pair.validate(controller.signal);
  if(hash(await readFile(sourcePath))!==hash(source.rollout))throw Error('PREFLIGHT_SOURCE_CHANGED');
  report.resourcesBeforeCleanup=await resources.usage();report.forks=guard.summary();
 }catch(error){report.errors.push({phase:active,code:typeof error?.code==='string'?error.code:error instanceof Error&&/^[A-Z_a-z0-9]+$/.test(error.message)?error.message:'PREFLIGHT_OPERATION_FAILED'});}
 finally{
  clearTimeout(timer);process.removeListener('SIGINT',onInterrupt);
  try{
   if(worker)await phase('worker_close',()=>worker.close());
   await phase('owner_exit',()=>owner.close());if(!owner.status().closed)throw Error('PREFLIGHT_EXIT_UNCONFIRMED');
   if(ownerRecorded)await journal.processExit({ownerUuid,sourceKey,sourceEpoch,processExitState:'closed',at:Date.now()});
   await phase('custody_cleanup',async()=>{for(const claim of claims)await claim.afterProcessClosed();await snapshot?.close();await resources.release();});
   report.cleanupConfirmed=true;
  }catch{report.errors.push({phase:active,code:'PREFLIGHT_CLEANUP_UNCONFIRMED'});}
  if(workerLedger){report.accounting=workerLedger.snapshot();await workerLedger.close();}
  try{await pair?.close();await reader.close();await identity.close();}catch{report.cleanupConfirmed=false;report.errors.push('PREFLIGHT_LOCAL_CLOSE_UNCONFIRMED');}
  await writeFile(join(root,'preflight.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report,null,2));if(report.errors.length||!report.cleanupConfirmed)process.exitCode=1;
 }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
