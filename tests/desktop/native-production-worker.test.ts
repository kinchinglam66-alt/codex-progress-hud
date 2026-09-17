import {beforeEach,expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({worker:vi.fn(),resources:vi.fn(),guard:vi.fn()}));
vi.mock('../../src/estimation/observer-persistent-worker.js',()=>({createPersistentObserverWorker:calls.worker}));
vi.mock('../../src/estimation/native-worker-resources.js',()=>({createNativeWorkerResources:calls.resources}));
vi.mock('../../src/estimation/native-guard.js',()=>({createNativeGuard:calls.guard}));
import {createDesktopPersistentWorker} from '../../src/desktop/native-production-worker.js';
const identity={parentDirectory:'C:/hud-private',cwd:'C:/hud-empty',executable:'C:/runtime/codex.exe',
 version:'0.153.4',executableSha256:'ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b',
 resourcesDirectory:'C:/assets',powershell:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',environment:{}};
const options={authorize:()=>false,now:Date.now,receiptDirectory:'C:/receipts',outputSchema:{type:'object'},
 accounting:{} as never,prepareSession:async()=>{throw Error('not authorized');}};
beforeEach(()=>vi.clearAllMocks());
it('routes the installed subscription worker to completed-turn native inheritance with inline reuse',()=>{
 const resource={release:async()=>{}};calls.resources.mockReturnValue(resource);
 createDesktopPersistentWorker(identity,options,'trusted instructions');
 expect(calls.worker).toHaveBeenCalledWith(expect.objectContaining({nativeContext:resource,
  nativeInstructions:'trusted instructions',completedTurnContext:true,reuseNativeTurnSession:true,
  inlineCurrentTurnSupplement:true,authorize:options.authorize}));
 expect(calls.guard).toHaveBeenCalledWith(expect.any(String),expect.any(String),{idleTimeoutMs:1860000});
});
it('rejects an unqualified runtime instead of silently selecting full-history import',()=>{
 expect(()=>createDesktopPersistentWorker({...identity,executableSha256:'a'.repeat(64)},options,'trusted')).toThrow('NATIVE_TRIAL_RUNTIME_UNVERIFIED');
 expect(calls.worker).not.toHaveBeenCalled();expect(calls.resources).not.toHaveBeenCalled();
});
it('exposes the native scheduler contract without bypassing authorization or starting a process',async()=>{
 const real=await vi.importActual<typeof import('../../src/estimation/observer-persistent-worker.js')>('../../src/estimation/observer-persistent-worker.js');
 calls.worker.mockImplementationOnce(real.createPersistentObserverWorker);
 calls.resources.mockReturnValue({release:async()=>{}});
 const prepareSession=vi.fn(options.prepareSession);
 const worker=createDesktopPersistentWorker(identity,{...options,prepareSession},'trusted');
 expect(typeof worker.prepareNativeTurnContext).toBe('function');
 const result=await worker.observe({goalSummary:'synthetic',activeSeconds:0,runtime:'running',messages:[],truncated:false},new AbortController().signal,'synthetic',1);
 expect(result.status).toBe('disabled');expect(prepareSession).not.toHaveBeenCalled();
 await worker.close();expect(worker.status().active).toBe(false);
});
