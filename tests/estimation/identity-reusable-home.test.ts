import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({children:[] as ChildProcessWithoutNullStreams[],account:'one',hold:false,started:()=>{},diagnostic:(_stage:string)=>{}}));
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:(...args:Parameters<typeof actual.spawn>)=>{const child=actual.spawn(...args);state.children.push(child as ChildProcessWithoutNullStreams);return child;}};
});
vi.mock('../../src/estimation/observer-release-files.js',()=>({observerReleaseFiles:()=>({executableSha256:'a'.repeat(64),schemaSha256:'b'.repeat(64),instructionsSha256:'c'.repeat(64),compressionSchemaSha256:'d'.repeat(64),compressionInstructionsSha256:'e'.repeat(64)})}));
vi.mock('../../src/estimation/codex-preflight.js',()=>({createRuntimePreflightCache:()=>({check:async()=>({version:'synthetic'}),invalidate(){}})}));
vi.mock('../../src/estimation/codex-invocation.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../../src/estimation/codex-invocation.js')>();
  return {...actual,buildObserverSetupInvocation:()=>({executable:'unused',args:[],cwd:resolve('.'),env:{},input:''})};
});
vi.mock('../../src/estimation/observer-account-reader.js',()=>({createObserverAccountReader:()=>({
  async read(signal:AbortSignal){
    if(state.hold){state.started();await new Promise<void>((_resolve,reject)=>{const abort=()=>reject(Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
    return {accountId:state.account,email:'synthetic@example.invalid',planType:'plus',routeFingerprint:'f'.repeat(64)};
  },disable(){},ownership:()=> 'idle',
})}));
import {createObserverHomeManager} from '../../src/estimation/observer-home.js';
import {observerHomeProfile} from '../../src/estimation/observer-home-assets.js';
import {createObserverIdentityRuntime} from '../../src/estimation/observer-identity-runtime.js';
const roots:string[]=[], runtimes:ReturnType<typeof createObserverIdentityRuntime>[]=[];
const poisonedRuntimes=new Set<ReturnType<typeof createObserverIdentityRuntime>>();
const signal=()=>new AbortController().signal;
async function fixture(){
  state.account='one';state.hold=false;state.children=[];state.diagnostic=()=>{};
  const root=await mkdtemp(join(tmpdir(),'hud-identity-home-'));roots.push(root);
  const resourcesDirectory=resolve('scripts/windows');const powershell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const setup=createObserverHomeManager(observerHomeProfile(resourcesDirectory,root,powershell));
  const home=await setup.prepare(false,signal());setup.disable();await writeFile(join(home,'auth.json'),'synthetic-not-a-token');state.children=[];
  const runtime=createObserverIdentityRuntime({resourcesDirectory,parentDirectory:root,powershell,executable:'unused',cwd:root,version:'synthetic',reuseHomeCheckProcess:true,onDiagnostic:event=>state.diagnostic(event.stage)});
  runtimes.push(runtime);return {runtime};
}
afterEach(async()=>{vi.useRealTimers();state.hold=false;for(const runtime of runtimes.splice(0)){if(poisonedRuntimes.delete(runtime))await expect(runtime.close()).rejects.toThrow('OBSERVER_IDENTITY_CLOSE_UNCONFIRMED');else await runtime.close();}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.skipIf(process.platform!=='win32')('shares a resident helper across preparation and acceptance, then confirms close',async()=>{
  const {runtime}=await fixture();const prepared=await runtime.prepareSession(signal());
  expect(prepared.validateAcceptance).toBeTypeOf('function');
  await expect(prepared.validateAcceptance!(signal())).resolves.toBe(true);
  await runtime.prepareSession(signal());
  expect(state.children).toHaveLength(1);
  expect(state.children[0]!.exitCode).toBe(null);
  await runtime.close();expect(state.children.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
},20000);
it.skipIf(process.platform!=='win32')('explicit invalidation retires the old helper before a new generation starts',async()=>{
  const {runtime}=await fixture();const first=await runtime.prepareSession(signal());runtime.invalidateSessionReuse();
  await expect(first.validateAcceptance!(signal())).resolves.toBe(false);
  // close() is the externally observable drain barrier; no replacement is allowed during retirement.
  await runtime.close();expect(state.children.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
},20000);
it.skipIf(process.platform!=='win32')('cancels during account reading and drains the otherwise idle helper',async()=>{
  const {runtime}=await fixture();state.hold=true;
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});state.started=started;
  const controller=new AbortController();const rejected=expect(runtime.prepareSession(controller.signal)).rejects.toThrow();
  await ready;controller.abort();await rejected;await runtime.close();
  expect(state.children.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
},20000);
it.skipIf(process.platform!=='win32')('account identity changes retire the resident generation and fence prior acceptance',async()=>{
  const {runtime}=await fixture();const first=await runtime.prepareSession(signal());
  const original=state.children[0]!;state.account='two';const second=await runtime.prepareSession(signal());
  expect(second.evidence.accountFingerprint).not.toBe(first.evidence.accountFingerprint);
  expect(original.exitCode!==null||original.signalCode!==null).toBe(true);
  await expect(first.validateAcceptance!(signal())).resolves.toBe(false);
  await expect(second.validateAcceptance!(signal())).resolves.toBe(true);
  expect(state.children).toHaveLength(2);
},20000);
it.skipIf(process.platform!=='win32')('login preparation retires both the previous generation and its own helper',async()=>{
  const {runtime}=await fixture();await runtime.prepareSession(signal());
  await runtime.prepareLogin(signal());
  expect(state.children).toHaveLength(2);
  expect(state.children.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
  await runtime.prepareSession(signal());expect(state.children).toHaveLength(3);
},20000);
it.skipIf(process.platform!=='win32').each(['account-change','login','logout','device-auth'] as const)('refuses %s success when helper shutdown is unconfirmed',async mode=>{
  const {runtime}=await fixture();await runtime.prepareSession(signal());
  // Only intercept retirement of this test's owned helper; restore and reap it in finally.
  let attempted!:()=>void;const stopping=new Promise<void>(resolve=>{attempted=resolve;});
  let restore=async()=>{},trapped=false;
  const trap=()=>{
    if(trapped)return;trapped=true;
    const original=state.children.at(-1)!,kill=original.kill.bind(original);
    original.kill=()=>{attempted();return true;};
    restore=async()=>{original.kill=kill;const closed=new Promise<void>(resolve=>original.once('close',()=>resolve()));kill();await closed;};
  };
  state.diagnostic=stage=>{if(stage==='ready')trap();};
  poisonedRuntimes.add(runtime);vi.useFakeTimers();
  try {
    if(mode==='account-change')state.account='two';
    const operation=mode==='account-change'?runtime.prepareSession(signal()):mode==='login'?runtime.prepareLogin(signal()):mode==='logout'?runtime.prepareLogout(signal()):runtime.prepareDeviceLogin(signal());
    // Attach immediately so a rejected promise remains handled during timer advancement.
    const result=operation.then(()=>({accepted:true}),()=>({accepted:false}));
    await stopping;await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({accepted:false});
  }finally{
    vi.useRealTimers();state.diagnostic=()=>{};await restore();
  }
},20000);
