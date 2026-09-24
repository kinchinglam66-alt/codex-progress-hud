import {expect,it as test,vi} from 'vitest';
// Real durable process ownership uses the Windows-only StartTime/handle probe.
const it = test.skipIf(process.platform !== 'win32');
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

// Only OS deployment/preflight and the external server are substituted. The
// identity, metadata, consent wrapper, worker and durable ledger stay real.
const fixture=vi.hoisted(()=>({script:''}));
vi.mock('../../src/estimation/observer-home.js',()=>({createObserverHomeManager:()=>({prepare:async()=>resolve('synthetic-home'),disable(){},status:()=>({active:false,poisoned:false})})}));
vi.mock('../../src/estimation/observer-identity-files.js',()=>({captureObserverIdentityFiles:async()=> 'stable-synthetic-files'}));
vi.mock('../../src/estimation/codex-probe.js',()=>({createObserverRuntimeProbe:()=>({probe:async()=>({version:'codex-cli 0.153.4',features:''}),disable(){}})}));
vi.mock('../../src/estimation/codex-preflight.js',()=>({createRuntimePreflightCache:()=>({check:async()=>({version:'0.153.4'}),invalidate(){}})}));
vi.mock('../../src/estimation/codex-invocation.js',async original=>({...await original<object>(),buildObserverExternalInvocation:()=>({executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',fixture.script],input:''})}));

import {createObserverIdentityRuntime} from '../../src/estimation/observer-identity-runtime.js';
import {createDesktopObserverRuntime} from '../../src/desktop/observer-runtime.js';
import {createPersistentObserverWorker} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';

fixture.script=`let b='',init=0,login=0,turns=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!m.id)continue;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let result={};
if(m.method==='initialize'&&++init>1||m.method==='account/login/start'&&++login>1){send({id:m.id,error:{code:-1,message:'duplicate setup'}});continue;}
if(m.method==='config/read')result={config:{model_provider:'openai',forced_login_method:'chatgpt',cli_auth_credentials_store:'ephemeral',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{}}};
if(m.method==='account/login/start'){result={type:'chatgptAuthTokens'};send({method:'account/login/completed',params:{loginId:null,success:true,error:null}});}
if(m.method==='account/rateLimits/read')result={accountId:'a',rateLimits:{}};
if(m.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'synthetic@example.invalid'}};
if(m.method==='thread/start')result={thread:{id:'t'}};
if(m.method==='turn/start'){turns++;const turnId='r'+turns;send({id:m.id,result:{turn:{id:turnId}}});send({method:'item/completed',params:{threadId:'t',turnId,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'synthetic',estimate:{remainingSeconds:60,errorPercent:50}})}}});send({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId,tokenUsage:{total:{inputTokens:100*turns,outputTokens:10*turns,totalTokens:110*turns,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});send({method:'turn/completed',params:{threadId:'t',turn:{id:turnId,status:'completed'}}});continue;}
send({id:m.id,result});}});process.stdin.on('end',()=>process.exit(0));`;

it.each(['success','revoke-after-attestation'] as const)('runs the full main-account consent and transport chain (%s)',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'hud-main-chain-'));await mkdir(join(root,'ledger'));
 const accounting=await openReleaseAccounting(join(root,'ledger'),Date.now);
 const source={inspect:async()=>({accountFingerprint:'a'.repeat(64),expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const identity=createObserverIdentityRuntime({resourcesDirectory:resolve('resources'),parentDirectory:root,powershell:resolve('synthetic-powershell.exe'),executable:process.execPath,cwd:process.cwd(),version:'0.153.4',mainAccountSource:source});
 const transports:unknown[]=[],methods:string[]=[],children:ReturnType<typeof createObserverSessionProcess>[]=[];
 let runtime:ReturnType<typeof createDesktopObserverRuntime>;
 runtime=createDesktopObserverRuntime({subscriptionAccountSource:'main',identity:{...identity,prepareSession:async(signal,policy)=>{
  const prepared=await identity.prepareSession(signal,policy);transports.push(prepared.mainAccountSession);
  if(mode==='revoke-after-attestation')await runtime.revokeConsent();
  return prepared;
 }},openAccounting:async()=>accounting,dialog:{showMessageBox:async()=>({response:0})},persistentReceiptDirectory:join(root,'receipts'),
 persistentWorkerFactory:options=>createPersistentObserverWorker({...options,mainAccount:{source,accountFingerprint:'a'.repeat(64)},outputSchema:{type:'object'},processFactory:config=>{
  const child=createObserverSessionProcess(config);children.push(child);return {...child,start:async invocation=>{
   const opened=await child.start(invocation),call=opened.rpc.call;opened.rpc.call=(method,params)=>{methods.push(method);return call(method,params);};return opened;
  }};
 }})});
 const input:ObserverInput={goalSummary:'synthetic',runtime:'running',activeSeconds:1,messages:[{kind:'user',text:'synthetic',truncated:false}],truncated:false};
 const signal=new AbortController().signal;
 try{
  await runtime.start(signal);
  const worker=runtime.workerSource.acquire('source');
  const prepare=()=>worker.prepareContext!(input,{currentTurnId:'turn',snapshot:{identity:'synthetic',sourceEpoch:0,revision:0,coverage:{complete:true,gaps:[]},async *records(){},close:async()=>{}}},signal,'source',0,0);
  if(mode==='success'){
   const first=await prepare();expect((await worker.observe(first.input,signal,'source',0)).status).toBe('interpreted');
   expect(children).toHaveLength(1);expect(transports[0]).toBeDefined();
   await worker.release!();
   // A healthy same-source owner follows ordinary validation without adoption.
   const retained=await prepare();expect((await worker.observe(retained.input,signal,'source',0)).status).toBe('interpreted');
   expect(children).toHaveLength(1);expect(transports[1]).toBeUndefined();
   await children[0]!.close();
   const cold=await prepare();expect((await worker.observe(cold.input,signal,'source',0)).status).toBe('interpreted');
   expect(children).toHaveLength(2);expect(transports[2]).toBeDefined();expect(transports[2]).not.toBe(transports[0]);
   expect(methods.filter(m=>m==='initialize')).toHaveLength(2);
   expect(methods.filter(m=>m==='account/login/start')).toHaveLength(2);
   expect(methods.filter(m=>m==='account/rateLimits/read')).toHaveLength(2);
   expect(accounting.snapshot()).toMatchObject({starts:3,knownTokens:330,unknown:0,unresolved:0});
  }else{
   await expect(prepare()).rejects.toThrow();expect(transports[0]).toBeDefined();expect(children).toHaveLength(1);
   expect(methods).not.toContain('thread/start');expect(methods).not.toContain('turn/start');
   expect(children[0]!.status().closed).toBe(true);expect(accounting.snapshot()).toMatchObject({starts:0,unknown:0,unresolved:0});
  }
 }finally{try{await runtime.close();}finally{await Promise.all(children.map(child=>child.close()));await accounting.close();await rm(root,{recursive:true,force:true});}}
 expect(children.every(child=>child.status().closed)).toBe(true);
});
