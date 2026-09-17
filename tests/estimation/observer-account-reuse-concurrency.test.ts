import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createObserverIdentityRuntime} from '../../src/estimation/observer-identity-runtime.js';
import {createPersistentObserverWorker} from '../../src/estimation/observer-persistent-worker.js';
import {createObserverSessionProcess} from '../../src/estimation/observer-session-process.js';
import {createPersistentReceiptJournal} from '../../src/estimation/observer-persistent-receipt.js';
import {openReleaseAccounting} from '../../src/estimation/release-accounting.js';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';

const state=vi.hoisted(()=>({authHome:'',accountId:'account-one',routeFingerprint:'b'.repeat(64),prepareCalls:0}));
const childScript=`let b='',n=0;process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(!m.id)continue;if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'t'}}});else if(m.method==='turn/start'){const id='r'+(++n);emit({id:m.id,result:{turn:{id}}});emit({method:'item/completed',params:{threadId:'t',turnId:id,item:{type:'agentMessage',text:JSON.stringify({relation:'continue',status:'running',summary:'current',estimate:{remainingSeconds:90,errorPercent:20}})}}});emit({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:id,tokenUsage:{total:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},last:{inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}}});emit({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}else if(m.method==='test/account_updated'){emit({method:'account/updated',params:{}});emit({id:m.id,result:{}});}else emit({id:m.id,result:{}});}});process.stdin.on('end',()=>process.exit(0));`;

vi.mock('../../src/estimation/observer-release-files.js',()=>({observerReleaseFiles:()=>({executable:'C:/trusted/codex.exe',cwd:'C:/trusted/cwd',schemaPath:'C:/trusted/schema.json',instructionsPath:'C:/trusted/instructions.md',executableSha256:'a'.repeat(64),schemaSha256:'b'.repeat(64),instructionsSha256:'c'.repeat(64),compressionSchemaPath:'C:/trusted/compression-schema.json',compressionInstructionsPath:'C:/trusted/compression-instructions.md',compressionSchemaSha256:'d'.repeat(64),compressionInstructionsSha256:'e'.repeat(64)})}));
vi.mock('../../src/estimation/observer-home-assets.js',()=>({OBSERVER_HOME_SCRIPT_SHA256:'f'.repeat(64),observerHomeProfile:()=>({parentDirectory:'C:/trusted',powershell:'C:/trusted/powershell.exe',scriptPath:'C:/trusted/home.ps1',scriptSha256:'f'.repeat(64)})}));
vi.mock('../../src/estimation/observer-home.js',()=>({createObserverHomeManager:()=>({prepare:async()=>state.authHome,disable(){},status:()=>({active:false,poisoned:false})})}));
vi.mock('../../src/estimation/codex-preflight.js',()=>({createRuntimePreflightCache:()=>({check:async()=>({version:'0.153.4'}),invalidate(){}})}));
vi.mock('../../src/estimation/codex-probe.js',()=>({createObserverRuntimeProbe:()=>({probe:async()=>({version:'codex-cli 0.153.4',features:'x stable false'}),disable(){}})}));
vi.mock('../../src/estimation/codex-invocation.js',()=>({
  buildObserverSetupInvocation:()=>({executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',childScript],input:''}),
  buildObserverCodexInvocation:()=>({executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',childScript],input:''}),
  buildObserverCompressionInvocation:()=>({executable:process.execPath,cwd:process.cwd(),env:process.env,args:['-e',childScript],input:''}),
}));
vi.mock('../../src/estimation/observer-account-reader.js',()=>({createObserverAccountReader:()=>({
  read:async()=>({accountId:state.accountId,email:'same@example.invalid',planType:'plus',routeFingerprint:state.routeFingerprint}),
  disable(){},ownership:()=> 'idle',
})}));

const input:ObserverInput={goalSummary:'current',runtime:'running',activeSeconds:10,messages:[{kind:'user',text:'current',truncated:false}],truncated:false};
const history=():HistorySnapshot=>({identity:'local-only-source-identity',sourceEpoch:0,revision:0,coverage:{complete:true,gaps:[]},async *records():AsyncGenerator<{ordinal:number;record:ConversationRecord}>{},close:async()=>{}});
const signal=()=>new AbortController().signal;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

interface WorkerFixture {
  identity:ReturnType<typeof createObserverIdentityRuntime>;
  workers:[ReturnType<typeof createPersistentObserverWorker>,ReturnType<typeof createPersistentObserverWorker>];
  accounting:[Awaited<ReturnType<typeof openReleaseAccounting>>,Awaited<ReturnType<typeof openReleaseAccounting>>];
  rpcRefs:Array<{call:(method:string,params:unknown)=>Promise<unknown>}>;
  admitted:Promise<void>;
  resumeA:()=>void;
  root:string;
  cleanup():Promise<void>;
}

async function fixture(pauseA=false):Promise<WorkerFixture>{
  const root=await mkdtemp(join(tmpdir(),'codex-account-reuse-race-'));
  state.authHome=join(root,'observer-auth');state.accountId='account-one';state.routeFingerprint='b'.repeat(64);state.prepareCalls=0;
  await mkdir(state.authHome);await writeFile(join(state.authHome,'auth.json'),'opaque-test-content');
  const identity=createObserverIdentityRuntime({resourcesDirectory:root,parentDirectory:root,powershell:join(root,'powershell.exe'),executable:join(root,'codex.exe'),cwd:root,version:'0.153.4',now:()=>1000,monotonicNow:()=>20});
  const prepareSession=async(s:AbortSignal)=>{state.prepareCalls++;const prepared=await identity.prepareSession(s);return {...prepared,binding:{accountFingerprint:prepared.evidence.accountFingerprint,routeFingerprint:prepared.evidence.routeFingerprint,assetsFingerprint:prepared.evidence.assetsFingerprint}};};
  await mkdir(join(root,'ledger-a'));await mkdir(join(root,'ledger-b'));
  const accountingA=await openReleaseAccounting(join(root,'ledger-a'),()=>1000);
  const accountingB=await openReleaseAccounting(join(root,'ledger-b'),()=>1000);
  const admitted=deferred(),release=deferred(),rpcRefs:Array<{call:(method:string,params:unknown)=>Promise<unknown>}> = [];
  const makeWorker=(accounting:Awaited<ReturnType<typeof openReleaseAccounting>>,journalPause:boolean)=>{
    const receiptDirectory=join(root,journalPause?'receipts-a':'receipts-b');
    const baseJournal=createPersistentReceiptJournal(receiptDirectory);
    const receiptJournalFactory=journalPause?()=>({...baseJournal,operationStarted:async(record:Parameters<typeof baseJournal.operationStarted>[0])=>{admitted.resolve();await release.promise;return baseJournal.operationStarted(record);}}):undefined;
    return createPersistentObserverWorker({...({accounting,prepareSession,invalidateSessionReuse:identity.invalidateSessionReuse,authorize:()=>true,now:()=>1000,outputSchema:{type:'object'},receiptDirectory}),...(receiptJournalFactory?{receiptJournalFactory}:{}),
      processFactory:()=>{const process=createObserverSessionProcess({captureIdentity:async()=> 'fake-process-identity'});const start=process.start;return {...process,start:async(invocation:any)=>{const opened=await start(invocation);rpcRefs.push(opened.rpc as any);return opened;}};},
    });
  };
  const workers:[ReturnType<typeof createPersistentObserverWorker>,ReturnType<typeof createPersistentObserverWorker>]=[makeWorker(accountingA,pauseA),makeWorker(accountingB,false)];
  return {identity,workers,accounting:[accountingA,accountingB],rpcRefs,admitted:admitted.promise,resumeA:release.resolve,root,cleanup:async()=>{release.resolve();await Promise.all(workers.map(worker=>worker.close().catch(()=>undefined)));await Promise.all([accountingA.close(),accountingB.close()]);await identity.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}};
}

beforeEach(()=>{state.authHome='';state.accountId='account-one';state.routeFingerprint='b'.repeat(64);state.prepareCalls=0;});
afterEach(()=>{state.authHome='';});

it('keeps worker A valid across unchanged worker B preparation and rejects cross-worker handles',async()=>{
  const f=await fixture(true);
  try {
    const preparedA=await f.workers[0].prepareContext!(input,{snapshot:history(),currentTurnId:'a'},signal(),'worker-a',0,0);
    const aObserve=f.workers[0].observe(preparedA.input,signal(),'worker-a',0);
    await f.admitted;
    await f.workers[1].prepareContext!(input,{snapshot:history(),currentTurnId:'b'},signal(),'worker-b',0,0);
    expect((await f.workers[1].observe(preparedA.input,signal(),'worker-a',0)).status).toBe('invalid_input');
    f.resumeA();
    expect((await aObserve).status).toBe('interpreted');
    expect(state.prepareCalls).toBe(2);
    expect(f.accounting[0].snapshot()).toMatchObject({starts:1,knownTokens:110,unresolved:0});
  } finally { await f.cleanup(); }
});

it('invalidates both issued proofs after an actual account and route change',async()=>{
  const f=await fixture(false);
  try {
    const first=await f.identity.prepareSession(signal());
    const proofA=await first.reuse!.claim(signal());
    const second=await f.identity.prepareSession(signal());
    const proofB=await second.reuse!.claim(signal());
    expect(proofA?.valid()).toBe(true);expect(proofB?.valid()).toBe(true);
    state.accountId='account-two';state.routeFingerprint='c'.repeat(64);
    await f.identity.inspect(signal());
    expect(proofA?.valid()).toBe(false);expect(proofB?.valid()).toBe(false);
  } finally { await f.cleanup(); }
});

it('propagates account events to the shared runtime so both workers lose reuse',async()=>{
  const f=await fixture(false);
  try {
    const preparedA=await f.workers[0].prepareContext!(input,{snapshot:history(),currentTurnId:'a'},signal(),'worker-a',0,0);
    const preparedB=await f.workers[1].prepareContext!(input,{snapshot:history(),currentTurnId:'b'},signal(),'worker-b',0,0);
    expect(f.rpcRefs).toHaveLength(2);
    await f.rpcRefs[0]!.call('test/account_updated',{});
    expect((await f.workers[0].observe(preparedA.input,signal(),'worker-a',0)).status).toBe('interpreted');
    expect((await f.workers[1].observe(preparedB.input,signal(),'worker-b',0)).status).toBe('interpreted');
    expect(state.prepareCalls).toBe(4);
  } finally { await f.cleanup(); }
});
