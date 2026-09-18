import {expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const state=vi.hoisted(()=>({mode:undefined as undefined|'main'|'independent',identities:[] as any[],workers:[] as any[],host:null as any,
 source:{inspect:async()=>({accountFingerprint:'a'.repeat(64),expiresAt:Date.now()+10000}),credentials:async()=>({accessToken:'synthetic',chatgptAccountId:'a'})}}));
vi.mock('../../src/desktop/observer-pilot-config.js',()=>({readObserverPilotConfig:async()=>({executable:'C:/runtime/codex.exe',parentDirectory:'C:/isolated',cwd:'C:/empty',version:'0.153.4',executableSha256:'ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b',proxyUrl:'http://127.0.0.1:1234',subscriptionAccountSource:state.mode}),observerPilotEnvironment:(_c:any,env:any)=>env}));
vi.mock('../../src/estimation/main-codex-account-source.js',()=>({createMainCodexAccountSource:()=>state.source}));
vi.mock('../../src/estimation/observer-identity-runtime.js',()=>({createObserverIdentityRuntime:(options:any)=>{state.identities.push(options);return {};}}));
vi.mock('../../src/desktop/observer-account-settings.js',()=>({createObserverAccountSettings:()=>({inspect:async()=>({accountLabel:'synthetic',evidence:{accountFingerprint:'a'.repeat(64)}}),close:async()=>{}})}));
vi.mock('../../src/desktop/observer-runtime.js',()=>({createDesktopObserverRuntime:(options:any)=>{
 options.persistentWorkerFactory({accounting:{},prepareSession:async()=>{},authorize:()=>true,now:Date.now,receiptDirectory:'synthetic'});
 return {workers:[],start:async()=>{},disable(){},close:async()=>{}};
}}));
vi.mock('../../src/desktop/native-production-worker.js',()=>({createDesktopPersistentWorker:(_identity:any,options:any)=>{state.workers.push(options);return {};}}));
vi.mock('../../src/estimation/observer-api-assets.js',()=>({loadObserverApiAssets:async()=>({schema:{},instructions:'synthetic'}),loadObserverCompressionAssets:async()=>({schema:{},instructions:'synthetic'})}));
vi.mock('../../src/estimation/residual/runtime.js',()=>({createResidualRuntime:async()=>undefined}));
vi.mock('../../src/desktop/observer-provider-host.js',()=>({createObserverProviderHost:async(options:any)=>{state.host=options;return {workers:[],disable(){},close:async()=>{}};}}));
import {loadDesktopObserverPilot} from '../../src/desktop/observer-pilot.js';
it.each([undefined,'main','independent'] as const)('uses one account source for settings, runtime and worker (%s)',async(mode)=>{
 state.mode=mode;state.identities=[];state.workers=[];
 const root=await mkdtemp(join(tmpdir(),'hud-main-composition-'));
 const pilot=await loadDesktopObserverPilot({dataDirectory:root,resourcesDirectory:root,environment:{SystemRoot:'C:/Windows',CODEX_HOME:resolve('synthetic-main')},consentProtection:{protect:v=>v,unprotect:v=>v},dialog:{showMessageBox:async()=>({response:1})}});
 try{
  const owner=await state.host.openSubscription(new AbortController().signal);
  const expected=mode==='independent'?undefined:state.source;
  expect(state.identities).toHaveLength(2);
  for(const identity of state.identities)expect(identity.mainAccountSource).toBe(expected);
  expect(state.workers).toHaveLength(1);
  if(expected)expect(state.workers[0].mainAccount).toEqual({source:expected,accountFingerprint:'a'.repeat(64)});
  else expect(state.workers[0].mainAccount).toBeUndefined();
  await owner.close();
 }finally{await pilot.close();await rm(root,{recursive:true,force:true});}
});
it('deletes durable consent even when the replacement has no current runtime',async()=>{
 state.mode='main';const root=await mkdtemp(join(tmpdir(),'hud-main-revoke-'));
 const path=join(root,'observer-consent.json');await writeFile(path,'previous sealed grant');
 const pilot=await loadDesktopObserverPilot({dataDirectory:root,resourcesDirectory:root,environment:{SystemRoot:'C:/Windows'},consentProtection:{protect:v=>v,unprotect:v=>v},dialog:{showMessageBox:async()=>({response:1})}});
 try{await pilot.revokeConsent();await expect(access(path)).rejects.toMatchObject({code:'ENOENT'});}
 finally{await pilot.close();await rm(root,{recursive:true,force:true});}
});
