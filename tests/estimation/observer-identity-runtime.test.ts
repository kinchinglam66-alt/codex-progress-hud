import {expect,it,vi,beforeEach} from 'vitest';
import {resolve} from 'node:path';
import {ObserverAccountTimeout,ObserverPreDispatchTransient} from '../../src/estimation/observer-call-failure.js';
const state=vi.hoisted(()=>({events:[] as string[],accountId:'account-one',failure:'',active:false}));
vi.mock('../../src/estimation/observer-home.js',()=>({createObserverHomeManager:()=>({prepare:async()=>{state.events.push('home');return resolve('private/observer-auth');},disable(){},status:()=>({active:false,poisoned:false})})}));
vi.mock('../../src/estimation/codex-probe.js',()=>({createObserverRuntimeProbe:()=>({probe:async()=>({version:'codex-cli 0.153.4',features:'x stable false'}),disable(){}})}));
vi.mock('../../src/estimation/codex-preflight.js',()=>({createRuntimePreflightCache:()=>({
  check:async()=>{state.events.push('preflight');return {version:'0.153.4'};},invalidate(){state.events.push('cache-invalidated');}
})}));
vi.mock('../../src/estimation/codex-invocation.js',()=>({buildObserverSetupInvocation:(_p:unknown,action:string)=>({executable:'unused',args:action==='device-auth'?['login','--device-auth']:[action],env:{},cwd:resolve('.'),input:''}),buildObserverCodexInvocation:()=>({executable:'unused',args:['exec','--model','gpt-5.6-luna','-c','model_reasoning_effort="medium"'],env:{},cwd:resolve('.'),input:'bounded'})}));
vi.mock('../../src/estimation/observer-account-reader.js',()=>({createObserverAccountReader:()=>({read:async()=>{state.events.push('account');if(state.failure==='trusted-timeout')throw new ObserverAccountTimeout();if(state.failure)throw Error(state.failure);return {accountId:state.accountId,email:'same@example.invalid',planType:'plus',routeFingerprint:'b'.repeat(64)};},disable(){},ownership:()=>state.active?'reading':'idle'})}));
import {createObserverIdentityRuntime} from '../../src/estimation/observer-identity-runtime.js';
beforeEach(()=>{state.events=[];state.accountId='account-one';state.failure='';state.active=false;});
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
  expect(prepared.provenance).toMatchObject({input:'observer-input-facts-v2',model:'gpt-5.6-luna-medium',algorithm:'pace-v1'});
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
it('diagnostic sink failures cannot turn a successful account check into a failure',async()=>{
 const runtime=createObserverIdentityRuntime({...config(),onDiagnostic:()=>{throw Error('sink');}});
 await expect(runtime.inspect(new AbortController().signal)).resolves.toHaveProperty('evidence');
 await runtime.close();
});
