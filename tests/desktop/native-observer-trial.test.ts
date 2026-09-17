import {expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>({resources:vi.fn(),identity:vi.fn(),guard:vi.fn()}));
vi.mock('../../src/estimation/native-guard.js',()=>({createNativeGuard:hooks.guard}));
vi.mock('../../src/estimation/native-worker-resources.js',()=>({createNativeWorkerResources:hooks.resources}));
vi.mock('../../src/estimation/observer-identity-runtime.js',()=>({createObserverIdentityRuntime:hooks.identity}));
import {createNativeObserverTrial} from '../../src/desktop/native-observer-trial.js';
const identity={parentDirectory:'C:/hud-private',cwd:'C:/hud-empty',executable:'C:/runtime/codex.exe',
 version:'0.153.4',executableSha256:'ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b',
 resourcesDirectory:'C:/assets',powershell:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',environment:{}};

it('is off without the in-process trial option and performs no account work',()=>{
 hooks.resources.mockClear();hooks.identity.mockClear();
 expect(createNativeObserverTrial(identity,undefined)).toBeUndefined();
 expect(hooks.resources).not.toHaveBeenCalled();expect(hooks.identity).not.toHaveBeenCalled();
});
it('only attaches a separate verifier through explicit trusted opt-in',()=>{
 hooks.guard.mockClear();hooks.resources.mockClear();
 createNativeObserverTrial(identity,{maxSourceBytes:1000});
 expect(hooks.guard).not.toHaveBeenCalled();expect(hooks.resources.mock.calls.at(-1)![0].guard).toBeUndefined();
 const guard={verify:async()=>{},isExited:async()=>false,retire:async()=>{}};hooks.guard.mockReturnValue(guard);
 createNativeObserverTrial(identity,{maxSourceBytes:1000,reuseNativeGuard:true});
 expect(hooks.resources.mock.calls.at(-1)![0].guard).toBe(guard);
 expect(hooks.guard.mock.calls[0]!.map((path:string)=>path.replaceAll('\\','/'))).toEqual(['C:/hud-private/observer-auth','C:/assets/native-guard.ps1']);
});
it('rejects unverified runtime pins and unbounded source sizes',()=>{
 for(const patch of [{version:'0.153.3'},{executableSha256:undefined},{executableSha256:'a'.repeat(64)}])
  expect(()=>createNativeObserverTrial({...identity,...patch},{maxSourceBytes:1000})).toThrow('NATIVE_TRIAL_RUNTIME_UNVERIFIED');
 for(const maxSourceBytes of [0,-1,Infinity,1.5,Number.MAX_SAFE_INTEGER])
  expect(()=>createNativeObserverTrial(identity,{maxSourceBytes})).toThrow('NATIVE_TRIAL_SOURCE_LIMIT_INVALID');
});
it('retains the guard only with explicit native guard ownership and bounded host policy',()=>{
 hooks.guard.mockClear();
 expect(()=>createNativeObserverTrial(identity,{maxSourceBytes:1000,retainNativeGuard:true})).toThrow('NATIVE_TRIAL_GUARD_RETENTION_INVALID');
 expect(hooks.guard).not.toHaveBeenCalled();
 createNativeObserverTrial(identity,{maxSourceBytes:1000,mode:'completed-turn',reuseNativeGuard:true,retainNativeGuard:true});
 expect(hooks.guard.mock.calls[0]![2]).toEqual({idleTimeoutMs:1860000});
});

it('requires an explicit supported in-process mode for the completed-turn candidate',()=>{
 hooks.resources.mockClear();
 expect(()=>createNativeObserverTrial(identity,{maxSourceBytes:1000,mode:'unknown' as 'completed-turn'})).toThrow('NATIVE_TRIAL_MODE_INVALID');
 expect(hooks.resources).not.toHaveBeenCalled();
 createNativeObserverTrial(identity,{maxSourceBytes:1000,mode:'completed-turn'});
 expect(hooks.resources).toHaveBeenCalledTimes(1);
});
it('allocates one resource owner per worker and uses fresh cleanup-only identities',async()=>{
 const resourceA={},resourceB={};hooks.resources.mockReturnValueOnce(resourceA).mockReturnValueOnce(resourceB);
 const close=vi.fn(async()=>{}),prepare=vi.fn(async()=>({env:{CODEX_HOME:'C:/hud-private/observer-auth'}}));
 hooks.identity.mockReturnValue({prepareCleanupServer:prepare,close});
 expect(createNativeObserverTrial(identity,{maxSourceBytes:1000})).toBe(resourceA);
 expect(createNativeObserverTrial(identity,{maxSourceBytes:1000})).toBe(resourceB);
 const args=hooks.resources.mock.calls.at(-1)![0];
 expect(args.runtimeHome.replaceAll('\\','/')).toBe('C:/hud-private/observer-auth');
 expect(args.maxSourceBytes).toBe(1000);expect(hooks.identity).not.toHaveBeenCalled();
 const signal=new AbortController().signal;
 await args.prepareCleanupInvocation(signal);await args.prepareCleanupInvocation(signal);
 expect(hooks.identity).toHaveBeenCalledTimes(2);expect(prepare).toHaveBeenCalledWith(signal);expect(close).toHaveBeenCalledTimes(2);
 prepare.mockRejectedValueOnce(Error('preflight failed'));
 await expect(args.prepareCleanupInvocation(signal)).rejects.toThrow('preflight failed');
 expect(close).toHaveBeenCalledTimes(3);
});
