import {expect,it,vi,beforeEach,afterEach} from 'vitest';
import {resolve} from 'node:path';
import {ObserverAccountTimeout,ObserverPreDispatchTransient} from '../../src/estimation/observer-call-failure.js';
const state=vi.hoisted(()=>({events:[] as string[],accountId:'account-one',routeFingerprint:'b'.repeat(64),failure:'',active:false,compressionInputs:[] as string[],identityCaptureCount:0,identityGateCall:null as null|number,identityGate:null as null|{promise:Promise<void>;release:()=>void}}));
const identityFiles=vi.hoisted(()=>({value:'stable-identity-files'}));
vi.mock('../../src/estimation/observer-home.js',()=>({createObserverHomeManager:()=>({prepare:async()=>{state.events.push('home');return resolve('private/observer-auth');},disable(){},status:()=>({active:false,poisoned:false})})}));
vi.mock('../../src/estimation/codex-probe.js',()=>({createObserverRuntimeProbe:()=>({probe:async()=>({version:'codex-cli 0.153.4',features:'x stable false'}),disable(){}})}));
vi.mock('../../src/estimation/observer-identity-files.js',()=>({captureObserverIdentityFiles:async()=>{state.identityCaptureCount++;if(state.identityGate&&(state.identityGateCall===null||state.identityGateCall===state.identityCaptureCount))await state.identityGate.promise;return identityFiles.value;}}));
vi.mock('../../src/estimation/codex-preflight.js',()=>({createRuntimePreflightCache:()=>({
  check:async()=>{state.events.push('preflight');return {version:'0.153.4'};},invalidate(){state.events.push('cache-invalidated');}
})}));
vi.mock('../../src/estimation/codex-invocation.js',()=>({buildObserverExternalInvocation:()=>({executable:'unused',args:['external-metadata'],env:{},cwd:resolve('.'),input:''}),buildObserverSetupInvocation:(_p:unknown,action:string)=>({executable:'unused',args:action==='device-auth'?['login','--device-auth']:[action],env:{},cwd:resolve('.'),input:''}),buildObserverCodexInvocation:()=>({executable:'unused',args:['exec','--model','gpt-5.6-luna','-c','model_reasoning_effort="medium"'],env:{},cwd:resolve('.'),input:'bounded'}),buildObserverCompressionInvocation:(_p:unknown,input:string)=>{state.compressionInputs.push(input);return {executable:'unused',args:['exec','--compression-schema','pinned-summary-schema','-c','model_instructions_file="pinned-summary-instructions"'],env:{},cwd:resolve('.'),input};}}));
vi.mock('../../src/estimation/observer-account-reader.js',()=>({createObserverAccountReader:(_launch:unknown,_timeout:unknown,onDiagnostic?:(value:unknown)=>void)=>({read:async()=>{state.events.push('account');if(state.failure==='trusted-timeout')throw new ObserverAccountTimeout();if(state.failure){onDiagnostic?.({reason:'rpc_error',phase:2,elapsedMs:42,privateText:'DO_NOT_EXPOSE'});throw Error(state.failure);}return {accountId:state.accountId,email:'same@example.invalid',planType:'plus',routeFingerprint:state.routeFingerprint};},disable(){},ownership:()=>state.active?'reading':'idle'})}));
import {createObserverIdentityRuntime} from '../../src/estimation/observer-identity-runtime.js';
vi.mock('../../src/estimation/main-account-metadata.js',()=>({createMainAccountMetadataReader:(options:any)=>({
 read:async(signal:AbortSignal)=>({accountFingerprint:(await options.source.inspect(signal)).accountFingerprint,accountLabel:'followed@example.invalid',routeFingerprint:state.routeFingerprint,
  ...(options.openMainAccountSession?{mainAccountSession:await options.openMainAccountSession(options.invocation,signal)}:{})}),
 disable(){},ownership:()=> 'idle',
})}));
it('uses the main source for both inspection and prepared identity and forbids independent login',async()=>{
 let current='e'.repeat(64);
 const source={inspect:async()=>({accountFingerprint:current,expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const runtime=createObserverIdentityRuntime({...config(),mainAccountSource:source});
 try{
  const account=await runtime.inspect(new AbortController().signal);
  expect(account.accountLabel).toBe('followed@example.invalid');
  expect(account.evidence.accountFingerprint).toBe(current);
  const prepared=await runtime.prepareSession(new AbortController().signal);
  expect(prepared.invocation.args).toEqual(['external-metadata']);
  expect(prepared.evidence.accountFingerprint).toBe(current);
  expect(await prepared.validateAcceptance!(new AbortController().signal)).toBe(true);
  current='f'.repeat(64);
  expect(await prepared.validateAcceptance!(new AbortController().signal)).toBe(false);
  await expect(runtime.prepareLogin(new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_MANAGED_BY_CODEX');
  expect(state.events).not.toContain('account');
 }finally{await runtime.close();}
});
beforeEach(()=>{state.events=[];state.accountId='account-one';state.routeFingerprint='b'.repeat(64);state.failure='';state.active=false;state.compressionInputs=[];state.identityCaptureCount=0;state.identityGateCall=null;state.identityGate=null;identityFiles.value='stable-identity-files';});
afterEach(()=>vi.useRealTimers());
it('returns the attested worker transport and its exact invocation after main-account preparation',async()=>{
 const source={inspect:async()=>({accountFingerprint:'e'.repeat(64),expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const runtime=createObserverIdentityRuntime({...config(),mainAccountSource:source});
 let transport:any;
 try{
  const prepared=await runtime.prepareSession(new AbortController().signal,{openMainAccountSession:async(invocation)=>{
   transport={invocation,pid:123,creationIdentity:'test',rpc:{},lease:{}};return transport;
  }});
  expect(transport).toBeDefined();
  expect(prepared.mainAccountSession).toBe(transport);
  expect(prepared.invocation).toBe(transport.invocation);
  expect(prepared.reuse).toBeDefined();
 }finally{await runtime.close();}
});
it('provides one-use main-account preparation proof and rejects a subsequent account switch',async()=>{
 let current='e'.repeat(64);
 const source={inspect:async()=>({accountFingerprint:current,expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const runtime=createObserverIdentityRuntime({...config(),mainAccountSource:source});
 try{
  const prepared=await runtime.prepareSession(new AbortController().signal);
  expect(prepared.reuse).toBeDefined();
  const proof=await prepared.reuse!.claim(new AbortController().signal);
  expect(proof?.valid()).toBe(true);
  expect(await prepared.reuse!.claim(new AbortController().signal)).toBeNull();
  current='f'.repeat(64);
  expect(await proof!.validate(new AbortController().signal)).toBe(false);
  expect(proof!.valid()).toBe(false);
 }finally{await runtime.close();}
});
it.each(['switch','identity','cancel','invalidate'] as const)('rejects main-account reuse before claim after %s',async(change)=>{
 let current='e'.repeat(64);
 const source={inspect:async()=>({accountFingerprint:current,expiresAt:Date.now()+600000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})};
 const runtime=createObserverIdentityRuntime({...config(),mainAccountSource:source});
 try{
  const prepared=await runtime.prepareSession(new AbortController().signal),controller=new AbortController();
  expect(prepared.reuse).toBeDefined();
  if(change==='switch')current='f'.repeat(64);
  if(change==='identity')identityFiles.value='replaced';
  if(change==='cancel')controller.abort();
  if(change==='invalidate')runtime.invalidateSessionReuse();
  expect(await prepared.reuse!.claim(controller.signal)).toBeNull();
 }finally{await runtime.close();}
});
it('retains only the bounded reader failure category and phase for account inspection',async()=>{
  state.failure='PRIVATE';const runtime=createObserverIdentityRuntime(config());
  try{
    const failure=await runtime.inspect(new AbortController().signal).catch(error=>error);
    expect(failure.diagnostic).toMatchObject({stage:'account-read',reason:'check_failed',reader:{reason:'rpc_error',phase:2}});
    expect(JSON.stringify(failure.diagnostic)).not.toContain('DO_NOT_EXPOSE');
    expect(JSON.stringify(failure.diagnostic)).not.toContain('PRIVATE');
  }finally{await runtime.close();}
});
it('recovers metadata inspection after a closed account timeout without preparing login or inference',async()=>{
  vi.useFakeTimers();state.failure='trusted-timeout';
  const runtime=createObserverIdentityRuntime(config());
  const result=runtime.inspect(new AbortController().signal);
  const assertion=expect(result).resolves.toHaveProperty('evidence');
  void assertion.catch(()=>undefined); // Keep the assertion awaited after advancing time.
  await vi.advanceTimersByTimeAsync(999);
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  state.failure='';
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(state.events.filter(x=>x==='account')).toHaveLength(2);
  expect(state.compressionInputs).toEqual([]);
  await runtime.close();
});
it('bounds closed account-timeout inspection retries and exposes only safe failure details',async()=>{
  vi.useFakeTimers();state.failure='trusted-timeout';
  const runtime=createObserverIdentityRuntime(config());
  const assertion=expect(runtime.inspect(new AbortController().signal)).rejects.toMatchObject({
    message:'OBSERVER_IDENTITY_UNAVAILABLE',diagnostic:{stage:'account-read',reason:'timeout',attempts:3},
  });
  void assertion.catch(()=>undefined);
  await vi.advanceTimersByTimeAsync(4000);await assertion;
  expect(state.events.filter(x=>x==='account')).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(60000);
  expect(state.events.filter(x=>x==='account')).toHaveLength(3);
  await runtime.close();
});
it('cancels inspection backoff without starting another account reader',async()=>{
  vi.useFakeTimers();state.failure='trusted-timeout';
  const runtime=createObserverIdentityRuntime(config()),controller=new AbortController();
  const assertion=expect(runtime.inspect(controller.signal)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(500);controller.abort();
  await assertion;await vi.advanceTimersByTimeAsync(5000);
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  await runtime.close();
});
it('preserves inspect cancellation failure typing when failed diagnostics emit',async()=>{
  vi.useFakeTimers();state.failure='trusted-timeout';
  const diagnostics:unknown[]=[];
  const runtime=createObserverIdentityRuntime({...config(),onDiagnostic:value=>diagnostics.push(value)}),controller=new AbortController();
  const pending=runtime.inspect(controller.signal);
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  await expect(pending).rejects.toMatchObject({diagnostic:{stage:'account-read',reason:'cancelled',attempts:1}});
  expect(diagnostics).toContainEqual(expect.objectContaining({stage:'account-read',outcome:'failed'}));
  await runtime.close();
});
it('does not retry inspection when timeout cleanup is unconfirmed',async()=>{
  state.failure='trusted-timeout';state.active=true;
  const runtime=createObserverIdentityRuntime(config());
  await expect(runtime.inspect(new AbortController().signal)).rejects.toMatchObject({
    diagnostic:{stage:'account-read',reason:'ownership_unconfirmed',attempts:1},
  });
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  await expect(runtime.close()).rejects.toThrow('OBSERVER_IDENTITY_CLOSE_UNCONFIRMED');
});
it('holds identity ownership throughout inspection backoff and closes without another read',async()=>{
  vi.useFakeTimers();state.failure='trusted-timeout';
  const runtime=createObserverIdentityRuntime(config());
  const result=runtime.inspect(new AbortController().signal);
  const rejected=expect(result).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(500);
  await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  await expect(runtime.prepareLogin(new AbortController().signal)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  const closed=runtime.close();await rejected;await closed;
  await vi.advanceTimersByTimeAsync(5000);
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
});
it('does not extend metadata-only retries to persistent session preparation',async()=>{
  state.failure='trusted-timeout';
  const runtime=createObserverIdentityRuntime(config());
  await expect(runtime.prepareSession(new AbortController().signal)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  await runtime.close();
});
it.each(['OBSERVER_LOGIN_REQUIRED','malformed private response'])('does not retry non-timeout inspection failures (%s)',async failure=>{
  state.failure=failure;
  const runtime=createObserverIdentityRuntime(config());
  await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow(failure==='OBSERVER_LOGIN_REQUIRED'?failure:'OBSERVER_IDENTITY_UNAVAILABLE');
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  await runtime.close();
});
it.each(['allow','bypass'] as const)('validates acceptance binding after dispatch TTL without another account read (%s)',async(accountCache)=>{
 let clock=1000;const runtime=createObserverIdentityRuntime({...config(),now:()=>clock,monotonicNow:()=>clock});
 try{
  if(accountCache==='allow')await runtime.prepareSession(new AbortController().signal,{accountCache});
  const prepared=await runtime.prepareSession(new AbortController().signal,{accountCache});
  const reads=state.events.filter(x=>x==='account').length;
  clock+=45000;
  expect(prepared.validateAcceptance).toBeTypeOf('function');
  expect(await prepared.validateAcceptance!(new AbortController().signal)).toBe(true);
  expect(state.events.filter(x=>x==='account')).toHaveLength(reads);
  identityFiles.value='changed-account-files';
  expect(await prepared.validateAcceptance!(new AbortController().signal)).toBe(false);
 }finally{await runtime.close();}
});
it('rejects an acceptance guard after a fresh remote account check changes binding without a file change',async()=>{
 const runtime=createObserverIdentityRuntime(config());
 try{
  const prepared=await runtime.prepareSession(new AbortController().signal);
  state.accountId='account-two';await runtime.inspect(new AbortController().signal);
  expect(await prepared.validateAcceptance!(new AbortController().signal)).toBe(false);
 }finally{await runtime.close();}
});
it('prepares a persistent server only after identity attestation without dispatch',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const prepared=await runtime.prepareSession(new AbortController().signal);
  expect(prepared.invocation.args).toEqual(['metadata']);
  expect(prepared.evidence.expiresAt).toBe(301000);
  expect(state.events.filter(x=>x==='home')).toHaveLength(2);
  expect(state.events).toContain('account');
  await runtime.close();
});
it('allows a second normal preparation to reuse one full read with an independent handle',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const first=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  const second=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  expect(second.evidence).toEqual(first.evidence);
  expect(second.invocation).toEqual(first.invocation);
  expect(second.reuse).toBeDefined();
  expect(second.reuse).not.toBe(first.reuse);
  expect(await first.reuse!.claim(new AbortController().signal)).not.toBeNull();
  expect(await second.reuse!.claim(new AbortController().signal)).not.toBeNull();
  await runtime.close();
});
it('does not share a mutable cold invocation with a warm preparation',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const first=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  (first.invocation.args as string[]).push('mutated-by-cold-caller');
  (first.invocation.env as Record<string,string>).MUTATED='private';
  const second=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  expect(second.invocation.args).not.toContain('mutated-by-cold-caller');
  expect(second.invocation.env).not.toHaveProperty('MUTATED');
  await runtime.close();
});
it('does full reads for omitted and bypass policy without publishing a cache entry',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  await runtime.prepareSession(new AbortController().signal);
  await runtime.prepareSession(new AbortController().signal,{accountCache:'bypass'});
  await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  expect(state.events.filter(x=>x==='account')).toHaveLength(3);
  await runtime.close();
});
it('republishes after natural cache expiry without sliding the original entry',async()=>{
  let wall=1_000,mono=20;
  const runtime=createObserverIdentityRuntime({...config(),now:()=>wall,monotonicNow:()=>mono});
  const first=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  wall=31_000;mono=30_020;
  const second=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  const third=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  expect(state.events.filter(x=>x==='account')).toHaveLength(2);
  expect(second.evidence.observedAt).toBe(31_000);
  expect(third.evidence).toEqual(second.evidence);
  expect(third.evidence).not.toEqual(first.evidence);
  await runtime.close();
});
it.each([
  {name:'allow',policy:{accountCache:'allow'} as const,republish:true},
  {name:'bypass',policy:{accountCache:'bypass'} as const,republish:false},
])('rejects $name preparation invalidated during final metadata capture',async({policy,republish})=>{
  let release!:()=>void;
  state.identityGate={promise:new Promise<void>(resolve=>{release=resolve;}),release};
  state.identityGateCall=3;
  const runtime=createObserverIdentityRuntime(config());
  const pending=runtime.prepareSession(new AbortController().signal,policy);
  for(let i=0;i<10&&state.identityCaptureCount<3;i++)await Promise.resolve();
  expect(state.identityCaptureCount).toBe(3);
  runtime.invalidateSessionReuse();
  release();state.identityGate=null;state.identityGateCall=null;
  await expect(pending).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  if(republish){
    await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
    expect(state.events.filter(x=>x==='account')).toHaveLength(2);
  }
  await runtime.close();
});
it.each([
  {stage:'home-recheck' as const,policy:{accountCache:'allow'} as const},
  {stage:'home-recheck' as const,policy:{accountCache:'bypass'} as const},
  {stage:'ready' as const,policy:{accountCache:'allow'} as const},
  {stage:'ready' as const,policy:{accountCache:'bypass'} as const},
])('rejects $stage diagnostic invalidation for $policy.accountCache preparation',async({stage,policy})=>{
  let runtime!:ReturnType<typeof createObserverIdentityRuntime>;
  runtime=createObserverIdentityRuntime({...config(),onDiagnostic:value=>{if(value.stage===stage)runtime.invalidateSessionReuse();}});
  await expect(runtime.prepareSession(new AbortController().signal,policy)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  await runtime.close();
});
it('emits a ready diagnostic after a warm hit with only numeric cache fields',async()=>{
  const diagnostics:unknown[]=[];
  const runtime=createObserverIdentityRuntime({...config(),onDiagnostic:value=>diagnostics.push(value)});
  await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  const ready=diagnostics.at(-1) as {stage:string;accountCache?:Record<string,unknown>};
  expect(ready.stage).toBe('ready');
  expect(ready.accountCache).toMatchObject({candidateCount:2,hitCount:1,missCount:1,localGuardCount:1});
  expect(typeof ready.accountCache?.localGuardMs).toBe('number');
  expect(JSON.stringify(ready.accountCache)).not.toMatch(/account|private|invocation|metadata/);
  await runtime.close();
});
it('rejects a cache hit invalidated by its ready diagnostic before issuing a fresh handle',async()=>{
  let runtime!:ReturnType<typeof createObserverIdentityRuntime>,readyCount=0;
  runtime=createObserverIdentityRuntime({...config(),onDiagnostic:value=>{
    if(value.stage==='ready'&&++readyCount===2)runtime.invalidateSessionReuse();
  }});
  await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  await expect(runtime.prepareSession(new AbortController().signal,{accountCache:'allow'})).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  expect(state.events.filter(x=>x==='account')).toHaveLength(1);
  await runtime.close();
});
it('invalidates the cached generation and prior handle when local metadata changes',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const first=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  const proof=await first.reuse!.claim(new AbortController().signal);
  identityFiles.value='changed-identity-files';
  const second=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  expect(state.events.filter(x=>x==='account')).toHaveLength(2);
  expect(proof!.valid()).toBe(false);
  expect(second.evidence).toEqual(first.evidence);
  await runtime.close();
});
it('does not revoke a valid same-account handle after a full bypass check',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const first=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  const proof=await first.reuse!.claim(new AbortController().signal);
  await runtime.prepareSession(new AbortController().signal,{accountCache:'bypass'});
  expect(proof!.valid()).toBe(true);
  await runtime.close();
});
it('invalidates old handles when a full check observes a replacement account',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const first=await runtime.prepareSession(new AbortController().signal,{accountCache:'allow'});
  const proof=await first.reuse!.claim(new AbortController().signal);
  state.accountId='account-two';state.routeFingerprint='c'.repeat(64);
  const second=await runtime.prepareSession(new AbortController().signal,{accountCache:'bypass'});
  expect(state.events.filter(x=>x==='account')).toHaveLength(2);
  expect(proof!.valid()).toBe(false);
  expect(second.evidence.accountFingerprint).not.toBe(first.evidence.accountFingerprint);
  await runtime.close();
});
it('returns one-use session reuse and revalidates local identity before reuse',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const prepared=await runtime.prepareSession(new AbortController().signal);
  expect(prepared.reuse).toBeDefined();
  const proof=await prepared.reuse!.claim(new AbortController().signal);
  expect(proof?.valid()).toBe(true);
  identityFiles.value='replaced-identity-files';
  expect(await proof!.validate(new AbortController().signal)).toBe(false);
  runtime.invalidateSessionReuse();
  await runtime.close();
});
it('rejects an unrelated direct local guard while another proof guard is pending',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const prepared=await runtime.prepareSession(new AbortController().signal);
  const proof=await prepared.reuse!.claim(new AbortController().signal);
  let release!:()=>void;
  state.identityGate={promise:new Promise<void>(resolve=>{release=resolve;}),release};
  const first=proof!.validate(new AbortController().signal);
  await Promise.resolve();
  const second=proof!.validate(new AbortController().signal);
  expect(await second).toBe(false);
  release();
  expect(await first).toBe(false);
  state.identityGate=null;
  await runtime.close();
});
it('invalidates outstanding reuse when a later full inspection observes account or route changes',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const prepared=await runtime.prepareSession(new AbortController().signal);
  const proof=await prepared.reuse!.claim(new AbortController().signal);
  expect(proof?.valid()).toBe(true);
  state.accountId='account-two';state.routeFingerprint='c'.repeat(64);
  await runtime.inspect(new AbortController().signal);
  expect(proof!.valid()).toBe(false);
  await runtime.close();
});
it('requires a logged-in account for persistent server preparation',async()=>{
  const runtime=createObserverIdentityRuntime(config());state.failure='OBSERVER_LOGIN_REQUIRED';
  await expect(runtime.prepareSession(new AbortController().signal)).rejects.toThrow('OBSERVER_LOGIN_REQUIRED');
  await runtime.close();
});
it('prepares cleanup-only local RPC without requiring a working account or returning account evidence',async()=>{
  const runtime=createObserverIdentityRuntime(config());state.failure='OBSERVER_LOGIN_REQUIRED';
  const invocation=await runtime.prepareCleanupServer(new AbortController().signal);
  expect(invocation.args).toEqual(expect.arrayContaining(['metadata','features.goals=false','features.tool_suggest=false','features.in_app_local_automation=false']));
  expect(invocation).not.toHaveProperty('evidence');
  expect(state.events).toEqual(['home','preflight','home']);expect(state.compressionInputs).toEqual([]);
  await runtime.close();
});
const config=()=>({resourcesDirectory:resolve('resources'),parentDirectory:resolve('private'),powershell:resolve('powershell.exe'),executable:resolve('codex.exe'),cwd:resolve('empty'),version:'0.153.4',now:()=>1000});
it('binds identity to backend account and verified assets rather than email',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const first=await runtime.inspect(new AbortController().signal);
  expect(first.accountLabel).toBe('same@example.invalid');
  expect(first.evidence).toMatchObject({observedAt:1000,expiresAt:301000,routeFingerprint:'b'.repeat(64)});
  expect(first.evidence.assetsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(state.events.indexOf('preflight')).toBeLessThan(state.events.indexOf('account'));
  state.accountId='account-two';
  const second=await runtime.inspect(new AbortController().signal);
  expect(second.evidence.accountFingerprint).not.toBe(first.evidence.accountFingerprint);
  await runtime.close();
});
it.each([false,true])('marks an account timeout retryable only after confirmed cleanup (active=%s)',async active=>{
  const runtime=createObserverIdentityRuntime(config());state.failure='trusted-timeout';state.active=active;
  const pending=runtime.prepareEstimate({goalSummary:null,activeSeconds:20,runtime:'running',messages:[{kind:'user',text:'goal',truncated:false}],truncated:false},new AbortController().signal);
  if(active){await expect(pending).rejects.not.toBeInstanceOf(ObserverPreDispatchTransient);await expect(runtime.close()).rejects.toThrow('OBSERVER_IDENTITY_CLOSE_UNCONFIRMED');}
  else {await expect(pending).rejects.toBeInstanceOf(ObserverPreDispatchTransient);await runtime.close();}
});
it('preserves only explicit login-required and sanitizes other failures',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  state.failure='OBSERVER_LOGIN_REQUIRED';
  await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow(/^OBSERVER_LOGIN_REQUIRED$/);
  state.failure='private-error-detail';
  await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow(/^OBSERVER_IDENTITY_UNAVAILABLE$/);
  await runtime.close();
});
it('never starts preparation after disable',async()=>{
  const runtime=createObserverIdentityRuntime(config());runtime.disable();
  await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow();
  expect(state.events).toEqual(['cache-invalidated']);await runtime.close();
});
it('prepares isolated login only after runtime and metadata checks',async()=>{
  const runtime=createObserverIdentityRuntime(config());state.failure='OBSERVER_LOGIN_REQUIRED';
  const invocation=await runtime.prepareLogin(new AbortController().signal);
  expect(invocation.args).toEqual(['login']);expect(invocation.input).toBe('');
  expect(state.events).toContain('account');await runtime.close();
});
it('prepares official logout and device-auth invocations without reading the main home',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const logout=await runtime.prepareLogout(new AbortController().signal);
  expect(logout.args).toEqual(['logout']);
  const device=await runtime.prepareDeviceLogin(new AbortController().signal);
  expect(device.args).toEqual(['login','--device-auth']);
  await runtime.close();
});
it('prepares an estimate with fresh identity evidence but never dispatches it',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const prepared=await runtime.prepareEstimate({goalSummary:null,activeSeconds:20,runtime:'running',messages:[{kind:'user',text:'synthetic goal',truncated:false}],truncated:false},new AbortController().signal);
  expect(prepared.invocation.args).toContain('exec');
  expect(prepared.provenance).toMatchObject({input:'observer-input-facts-v5',model:'gpt-5.6-luna-medium',algorithm:'pace-v1'});
  expect(prepared.evidence.accountFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(state.events).toContain('account');await runtime.close();
});
it('does not claim cleanup while a metadata child remains owned',async()=>{
  const runtime=createObserverIdentityRuntime(config());state.active=true;
  await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
  await expect(runtime.close()).rejects.toThrow('OBSERVER_IDENTITY_CLOSE_UNCONFIRMED');
});
it('reports the failed preparation stage without private error text',async()=>{
 const diagnostics:unknown[]=[];state.failure='secret backend text';
 const runtime=createObserverIdentityRuntime({...config(),onDiagnostic:value=>diagnostics.push(value)});
 await expect(runtime.inspect(new AbortController().signal)).rejects.toThrow('OBSERVER_IDENTITY_UNAVAILABLE');
 expect(diagnostics).toContainEqual(expect.objectContaining({stage:'account-read',outcome:'failed'}));
 expect(JSON.stringify(diagnostics)).not.toContain('secret');
  await runtime.close();
});
it('prepares compression with the pinned summary invocation through the trusted identity runtime',async()=>{
  const runtime=createObserverIdentityRuntime(config());
  const request={text:'older context',firstOrdinal:4,lastOrdinal:8};
  const prepared=await runtime.prepareCompression(request,new AbortController().signal);
  expect(prepared.invocation.args).toContain('--compression-schema');
  expect(prepared.invocation.args).toContain('pinned-summary-schema');
  expect(prepared.invocation.args).toContain('model_instructions_file="pinned-summary-instructions"');
  expect(prepared.invocation.input).toBe(JSON.stringify(request));
  expect(state.compressionInputs).toEqual([JSON.stringify(request)]);
  await runtime.close();
});
it('diagnostic sink failures cannot turn a successful account check into a failure',async()=>{
 const runtime=createObserverIdentityRuntime({...config(),onDiagnostic:()=>{throw Error('sink');}});
 await expect(runtime.inspect(new AbortController().signal)).resolves.toHaveProperty('evidence');
 await runtime.close();
});
