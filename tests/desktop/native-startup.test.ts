import {expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const hooks=vi.hoisted(()=>({open:undefined as undefined|((signal:AbortSignal)=>Promise<unknown>),inspect:vi.fn(async()=>{throw Error('ACCOUNT_WOULD_BE_READ');})}));
vi.mock('../../src/desktop/observer-pilot-config.js',()=>({readObserverPilotConfig:async()=>({
 executable:'C:/runtime/codex.exe',parentDirectory:'C:/hud-private',cwd:'C:/hud-empty',version:'0.153.4',
 executableSha256:'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6',proxyUrl:'http://127.0.0.1:1234',persistentObserver:true}),observerPilotEnvironment:()=>({})}));
vi.mock('../../src/estimation/observer-identity-runtime.js',()=>({createObserverIdentityRuntime:()=>({})}));
vi.mock('../../src/desktop/observer-account-settings.js',()=>({createObserverAccountSettings:()=>({inspect:hooks.inspect})}));
vi.mock('../../src/estimation/observer-api-assets.js',()=>({loadObserverApiAssets:async()=>({schema:{},instructions:'synthetic'}),loadObserverCompressionAssets:async()=>({})}));
vi.mock('../../src/estimation/residual/runtime.js',()=>({createResidualRuntime:async()=>undefined}));
vi.mock('../../src/desktop/observer-provider-host.js',()=>({createObserverProviderHost:async(options:any)=>{
 hooks.open=options.openSubscription;return {workers:[],workerSource:{}};
}}));
import {loadDesktopObserverPilot} from '../../src/desktop/observer-pilot.js';
it('rejects a configured but native-unqualified build before subscription startup can report ready',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hud-native-startup-'));
 try{
 await loadDesktopObserverPilot({dataDirectory:directory,resourcesDirectory:'C:/assets',
  environment:{SystemRoot:'C:/Windows'},consentProtection:{protect:v=>v,unprotect:v=>v},
  dialog:{showMessageBox:async()=>({response:1})}});
 await expect(hooks.open!(new AbortController().signal)).rejects.toThrow('NATIVE_TRIAL_RUNTIME_UNVERIFIED');
 expect(hooks.inspect).not.toHaveBeenCalled();
 }finally{await rm(directory,{recursive:true,force:true});}
});
