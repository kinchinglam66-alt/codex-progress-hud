import {expect,it} from 'vitest';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersistentObserverWorker} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
const code=`let b='',logged=false;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');if(!m.id)continue;
if(m.method==='account/login/start'){logged=m.params.accessToken==='synthetic-token';emit({method:'account/updated',params:{authMode:'chatgpt',planType:'plus'}});emit({id:m.id,result:{type:'chatgptAuthTokens'}});}
else if(m.method==='account/rateLimits/read')emit({id:m.id,result:{accountId:'synthetic-account',rateLimits:{}}});
else if(m.method==='thread/start'){if(!logged){emit({id:m.id,error:{code:-1,message:'not logged in'}});continue;}emit({id:m.id,result:{thread:{id:'t'}}});}
else if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'r'}}});emit({method:'item/completed',params:{threadId:'t',turnId:'r',item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'work',estimate:{remainingSeconds:60,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:'r',tokenUsage:{total:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id:'r',status:'completed'}}});}
else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;
it.each(['none','provider_returned','admission','dispatch','settlement','finished'])('authenticates before history and fences changed-account results without losing usage (%s)',async(change)=>{
 const dir=await mkdtemp(join(tmpdir(),'hud-main-worker-'));await mkdir(join(dir,'ledger'));
 const accounting=await openReleaseAccounting(join(dir,'ledger'),Date.now);
 const fingerprint='a'.repeat(64);let current=fingerprint;
 const source={inspect:async()=>({accountFingerprint:current,expiresAt:Date.now()+600000}),credentials:async(expected:string)=>{
  if(expected!==current)throw Error('MAIN_ACCOUNT_CHANGED');return {accessToken:'synthetic-token',chatgptAccountId:'synthetic-account'};
 }};
 const worker=createPersistentObserverWorker({accounting,mainAccount:{source,accountFingerprint:fingerprint},authorize:()=>true,now:Date.now,
  outputSchema:{type:'object'},receiptDirectory:join(dir,'receipts'),
  prepareSession:async()=>({invocation:{executable:process.execPath,cwd:dir,env:process.env,args:['-e',code],input:''},
   binding:{accountFingerprint:fingerprint,routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64)},validateAcceptance:async()=>true}),
  processFactory:options=>createObserverSessionProcess({...options,captureIdentity:async()=> 'synthetic-identity'}),
 });
 try{
  const result=await worker.observe({goalSummary:'work',runtime:'running',activeSeconds:1,messages:[{kind:'user',text:'work',truncated:false}],truncated:false},new AbortController().signal,'source',0,
   stage=>{if(stage===change)current='d'.repeat(64);});
  expect(result.status).toBe(change==='admission'||change==='dispatch'?'aborted':change==='none'?'interpreted':'process_error');
  if(change==='admission'||change==='dispatch'){
   expect(result.usage).toBeNull();expect(accounting.snapshot()).toMatchObject({starts:change==='admission'?0:1,knownTokens:0,unknown:0,inFlight:0,unresolved:0});
   if(change==='dispatch')expect(await readFile(join(dir,'receipts','persistent-session-receipts.jsonl'),'utf8')).toContain('cancelled_before_dispatch');
  }else{
   if(change==='settlement'||change==='finished')expect(result.rejectionReason).toBe('provider_account_invalid');
   expect(result.usage?.inputTokens).toBe(100);
   expect(accounting.snapshot()).toMatchObject({starts:1,knownTokens:110,unknown:0});
  }
 }finally{await worker.close();await accounting.close();await rm(dir,{recursive:true,force:true});}
});
