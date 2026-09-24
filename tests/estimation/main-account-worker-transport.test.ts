import {expect,it as test} from 'vitest';
// Real durable process ownership uses the Windows-only StartTime/handle probe.
const it = test.skipIf(process.platform !== 'win32');
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPersistentObserverWorker} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createMainAccountMetadataReader} from '../../src/estimation/main-account-metadata.js';
import {createSessionAccountReuseIssuer} from '../../src/estimation/session-account-reuse.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import {createPersistentReceiptJournal} from '../../src/estimation/observer-persistent-receipt.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';

const input:ObserverInput={goalSummary:'synthetic',runtime:'running',activeSeconds:1,messages:[{kind:'user',text:'synthetic',truncated:false}],truncated:false};
const route={model_provider:'openai',forced_login_method:'chatgpt',cli_auth_credentials_store:'ephemeral',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{}};
const script=`let b='',initializations=0,logins=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!m.id)continue;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let result={};
if(m.method==='initialize'&&++initializations>1||m.method==='account/login/start'&&++logins>1){send({id:m.id,error:{code:-1,message:'duplicate setup'}});continue;}
if(m.method==='config/read')result={config:${JSON.stringify(route)}};
else if(m.method==='account/login/start')result={type:'chatgptAuthTokens'};
else if(m.method==='account/rateLimits/read')result={accountId:'a',rateLimits:{}};
else if(m.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'synthetic@example.invalid'}};
else if(m.method==='thread/start')result={thread:{id:'t'}};
else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'r'}}});send({method:'item/completed',params:{threadId:'t',turnId:'r',item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'synthetic',estimate:{remainingSeconds:60,errorPercent:50}})}}});send({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:'r',tokenUsage:{total:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});send({method:'turn/completed',params:{threadId:'t',turn:{id:'r',status:'completed'}}});continue;}
send({id:m.id,result});}});process.stdin.on('end',()=>process.exit(0));`;

it.each(['success','account-change','consent-change','cancel','wrong-attestation','missing-attestation','route-change','unexpected','receipt-failure','close-failure'] as const)('owns one attested main-account process through preparation and cleanup (%s)',async(mode)=>{
 const root=await mkdtemp(join(tmpdir(),'hud-main-transport-'));
 await mkdir(join(root,'ledger'));
 const accounting=await openReleaseAccounting(join(root,'ledger'),Date.now);
 const controller=new AbortController(),methods:string[]=[];
 let current='a'.repeat(64),authorized=true,starts=0,preparations=0;
 const source={inspect:async()=>({accountFingerprint:current,expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const issuer=createSessionAccountReuseIssuer({now:Date.now,monotonicNow:()=>performance.now()});
 let child:ReturnType<typeof createObserverSessionProcess>|undefined;
 const worker=createPersistentObserverWorker({mainAccount:{source,accountFingerprint:current},accounting,authorize:()=>authorized,now:Date.now,outputSchema:{type:'object'},receiptDirectory:join(root,'receipts'),
  ...(mode==='receipt-failure'?{receiptJournalFactory:(directory:string)=>({...createPersistentReceiptJournal(directory),ownerStarted:async()=>{throw Error('synthetic receipt failure');}})}:{}),
  prepareSession:async(signal,policy)=>{
   preparations++;
   if(!policy?.openMainAccountSession)throw Error('SHARED_TRANSPORT_REQUIRED');
   const childScript=mode==='route-change'?script.replace("if(m.method==='config/read')result=", "if(m.method==='config/read')result=").replace('send({id:m.id,result});','if(m.method===\'config/read\'&&logins)result.config.chatgpt_base_url=\'https://relay.invalid\';send({id:m.id,result});'):
    mode==='unexpected'?script.replace('send({id:m.id,result});',"if(m.method==='config/read')send({method:'turn/started',params:{threadId:'unadmitted',turn:{id:'unexpected'}}});send({id:m.id,result});"):script;
   const invocation={executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',childScript],input:''};
   const reader=createMainAccountMetadataReader({invocation,source,openMainAccountSession:policy.openMainAccountSession,processFactory:()=>{throw Error('DUPLICATE_PROCESS');}});
   const metadata=await reader.read(signal);reader.disable();
   if(mode==='account-change'||mode==='close-failure')current='b'.repeat(64);
   if(mode==='consent-change')authorized=false;
   if(mode==='cancel')controller.abort();
   const validateAcceptance=async()=>current===metadata.accountFingerprint&&authorized;
   const reuse=issuer.issue({observedAt:Date.now(),observedMonotonic:performance.now(),expiresAt:Date.now()+300000,validateLocal:validateAcceptance});
   return {invocation,...(mode==='missing-attestation'?{}:{mainAccountSession:mode==='wrong-attestation'?{...metadata.mainAccountSession!}:metadata.mainAccountSession!}),
    binding:{accountFingerprint:metadata.accountFingerprint,routeFingerprint:metadata.routeFingerprint,assetsFingerprint:'c'.repeat(64)},reuse,validateAcceptance};
  },
  processFactory:options=>{starts++;child=createObserverSessionProcess(options);const start=child.start;return {...child,...(mode==='close-failure'?{close:async()=>{throw Error('synthetic close unconfirmed');}}:{}),start:async invocation=>{
   const opened=await start(invocation),call=opened.rpc.call;opened.rpc.call=(method,params)=>{methods.push(method);return call(method,params);};return opened;
  }};},
 });
 try{
  const preparation=worker.prepareContext!(input,{currentTurnId:'turn',snapshot:{identity:'synthetic',sourceEpoch:0,revision:0,coverage:{complete:true,gaps:[]},async *records(){},close:async()=>{}}},controller.signal,'source',0,0);
  if(mode==='success'){
   const prepared=await preparation;
   expect((await worker.observe(prepared.input,controller.signal,'source',0)).status).toBe('interpreted');
   expect(preparations).toBe(1);expect(starts).toBe(1);
   expect(methods.filter(m=>m==='initialize')).toHaveLength(1);
   expect(methods.filter(m=>m==='account/login/start')).toHaveLength(1);
   expect(methods.filter(m=>m==='account/rateLimits/read')).toHaveLength(1);
   expect(methods.filter(m=>m==='turn/start')).toHaveLength(1);
   expect(accounting.snapshot()).toMatchObject({starts:1,knownTokens:110,unresolved:0});
   const receipts=(await readFile(join(root,'receipts','persistent-session-receipts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   expect(receipts[0]).toMatchObject({kind:'process_owner',creationIdentity:expect.any(String)});
   expect(receipts[0].pid).toBeGreaterThan(0);
  }else{
   await expect(preparation).rejects.toThrow();
   expect(starts).toBe(1);
   expect(methods).not.toContain('thread/start');expect(methods).not.toContain('turn/start');
   if(mode==='close-failure')expect(worker.status()).toMatchObject({poisoned:true,cleanupPending:true});
   else expect(child?.status().closed).toBe(true);
   expect(accounting.snapshot()).toMatchObject({starts:0,knownTokens:0,unresolved:0});
   if(mode==='unexpected'){
    expect(worker.status().poisoned).toBe(true);
    expect(accounting.snapshot()).toMatchObject({unknown:1,unresolved:0});
   }
  }
 }finally{
  try{if(mode==='close-failure')await expect(worker.close()).rejects.toThrow('SESSION_PROCESS_CLOSE_UNCONFIRMED');else await worker.close();}
  finally{await child?.close();await accounting.close();await rm(root,{recursive:true,force:true});}
 }
 expect(child?.status().closed).toBe(true);
});
