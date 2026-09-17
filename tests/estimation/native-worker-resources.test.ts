import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeWorkerResources} from '../../src/estimation/native-worker-resources.js';
import {createNativeForkCustody} from '../../src/estimation/native-fork-custody.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){
 if(!root.startsWith(join(tmpdir(),'hud-native-resources-')))throw Error('UNSAFE_TEST_CLEANUP');await rm(root,{recursive:true,force:true});
}});
async function fixture(guard?:{verify(signal:AbortSignal):Promise<void>;isExited(identity:{pid:number;creationIdentity:string},signal:AbortSignal):Promise<boolean>;retire():Promise<void>}){
 const root=await mkdtemp(join(tmpdir(),'hud-native-resources-'));roots.push(root);
 const runtimeHome=join(root,'observer-auth'),snapshots=join(runtimeHome,'hud-native','snapshots'),custody=join(runtimeHome,'hud-native','custody');
 await mkdir(snapshots,{recursive:true});await mkdir(custody);await mkdir(join(runtimeHome,'sessions'));
 const invocation={executable:join(root,'codex.exe'),cwd:root,args:['app-server','--stdio'],env:{CODEX_HOME:runtimeHome},input:''};
 let exited=false,cleanupStarts=0,verifications=0;const calls:string[]=[];
 let beforePrepare=async()=>{},beforeVerify=async()=>{};
 const resourceOptions:Parameters<typeof createNativeWorkerResources>[0]={runtimeHome,maxSourceBytes:10000,...(guard?{guard}:{}),
  storage:{prepare:async()=>{await beforePrepare();return {snapshots,custody};},verify:async()=>{verifications++;await beforeVerify();}},captureController:async()=>({pid:100,creationIdentity:'controller'}),
  isExited:async process=>process.pid===101&&exited,
  prepareCleanupInvocation:async()=>invocation,
  cleanupProcessFactory:()=>({start:async()=>{cleanupStarts++;return {rpc:{call:async(method:string,params:unknown)=>{
    calls.push(method);if(method==='initialize')return {};
    if(method==='thread/delete'){await unlink(join(runtimeHome,'sessions',`${(params as {threadId:string}).threadId}.jsonl`));return {};}
    throw Error('UNEXPECTED_MODEL_OR_RPC');},notify:()=>{},subscribe:()=>()=>{}}};},close:async()=>{},disable:()=>{}}),
 };
 const resources=createNativeWorkerResources(resourceOptions);
 const snapshotPath=join(snapshots,'.native-source-11111111-1111-4111-8111-111111111111.tmp');
 const source={currentTurnId:'current',snapshot:{kind:'native' as const,sourceThreadId:'source',sourceTurnId:'current',sourceEpoch:1,revision:1,
   path:snapshotPath,byteLength:100,close:async()=>{}}};
 return {root,runtimeHome,snapshots,custody,resources,invocation,source,calls,peer:()=>createNativeWorkerResources(resourceOptions),
  onPrepare:(check:()=>Promise<void>)=>{beforePrepare=check;},
  onVerify:(check:()=>Promise<void>)=>{beforeVerify=check;},
  exited:()=>{exited=true;},cleanupStarts:()=>cleanupStarts,verifications:()=>verifications,
  prepare:async(role:'request'|'base'='request')=>{const target=await resources.destination(new AbortController().signal,role);await writeFile(snapshotPath,'');
    await target.beforeCopy!(snapshotPath);await writeFile(snapshotPath,'PRIVATE SYNTHETIC HISTORY');target.copySettled?.();},
  fork:async(tag:string)=>writeFile(join(runtimeHome,'sessions','fork.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'fork',thread_source:tag}})+'\n'),
 };
}
it('composes both custody records and confirms fork cleanup before releasing its raw copy',async()=>{
 const f=await fixture();await f.prepare();
 const claim=await f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},new AbortController().signal);
 await f.fork(claim.tag);await claim.recordFork('fork');
 await expect(claim.afterProcessClosed()).rejects.toThrow();
 expect(await readFile(f.source.snapshot.path,'utf8')).toBe('PRIVATE SYNTHETIC HISTORY');
 f.exited();await claim.afterProcessClosed();await f.resources.release!();
 expect(await readdir(f.snapshots)).toEqual([]);expect(await readdir(f.custody)).toEqual([]);
 expect(f.calls.filter(method=>method==='thread/delete')).toEqual(['thread/delete']);
});

it.each(['acknowledge-again','release'] as const)('does not restart cleanup for retired local custody during %s while another owner remains live',async(action)=>{
 const f=await fixture();await f.prepare();
 const claim=await f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},new AbortController().signal);
 await f.fork(claim.tag);await claim.recordFork('fork');
 const peer=await createNativeForkCustody({directory:f.custody,runtimeHome:f.runtimeHome,verifyStorage:async()=>{},sourceThreadId:'peer-source',process:{pid:202,creationIdentity:'live-peer'}});
 const peerBefore=await readFile(peer.manifestPath,'utf8');
 f.exited();await claim.afterProcessClosed();
 expect(f.cleanupStarts()).toBe(1);
 if(action==='acknowledge-again')await claim.afterProcessClosed();else await f.resources.release!();
 expect(f.cleanupStarts()).toBe(1);
 expect(await readFile(peer.manifestPath,'utf8')).toBe(peerBefore);
 expect(await readdir(join(f.runtimeHome,'sessions'))).toEqual([]);
 await f.resources.release!();
});

it('owns one base copy and three independent child intents without counting the base as a request',async()=>{
 const f=await fixture(),signal=new AbortController().signal,owner={pid:101,creationIdentity:'child'};
 await f.prepare('base');
 const base=await f.resources.claim(f.source,f.invocation,owner,signal);
 await writeFile(join(f.runtimeHome,'sessions','base.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'base',thread_source:base.tag}})+'\n');
 await base.recordFork('base');
 const before=await f.resources.usage();expect(before.requests).toBe(0);expect(before.knownBytes).toBeGreaterThan(0);
 for(let i=0;i<3;i++){
  const child=await f.resources.claimChild({baseThreadId:'base',rootSourceThreadId:'source'},f.invocation,owner,signal);
  expect(await readFile(join(f.custody,`custody-${child.tag.slice('hud_native_'.length)}.jsonl`),'utf8')).toContain('rootSourceThreadId');
  await writeFile(join(f.runtimeHome,'sessions',`child-${i}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:`child-${i}`,thread_source:child.tag}})+'\n');
  await child.recordFork(`child-${i}`);
 }
 const after=await f.resources.usage();expect(after.requests).toBe(3);expect(after.knownBytes).toBeGreaterThan(before.knownBytes);
 expect((await readdir(f.snapshots)).filter(name=>name.endsWith('.tmp'))).toHaveLength(1);
 await expect(f.resources.claimChild({baseThreadId:'base',rootSourceThreadId:'source'},f.invocation,owner,signal)).rejects.toThrow('NATIVE_RESOURCE_LIMIT');
 await expect(f.resources.release!()).rejects.toThrow();
 expect(await readFile(f.source.snapshot.path,'utf8')).toBe('PRIVATE SYNTHETIC HISTORY');
 f.exited();await f.resources.release!();
 expect(f.calls.filter(method=>method==='thread/delete')).toHaveLength(4);
 expect(await readdir(f.snapshots)).toEqual([]);expect(await readdir(f.custody)).toEqual([]);
});

it('rejects a second base, unknown base, wrong root and wrong process before creating child custody',async()=>{
 const f=await fixture(),signal=new AbortController().signal,owner={pid:101,creationIdentity:'child'};
 await f.prepare('base');const base=await f.resources.claim(f.source,f.invocation,owner,signal);
 await writeFile(join(f.runtimeHome,'sessions','base.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'base',thread_source:base.tag}})+'\n');await base.recordFork('base');
 await expect(f.resources.destination(signal,'base')).rejects.toThrow('NATIVE_RESOURCE_BASE_EXISTS');
 for(const [origin,process] of [
  [{baseThreadId:'unknown',rootSourceThreadId:'source'},owner],
  [{baseThreadId:'base',rootSourceThreadId:'other'},owner],
  [{baseThreadId:'base',rootSourceThreadId:'source'},{...owner,creationIdentity:'reused-pid'}],
 ] as const)await expect(f.resources.claimChild(origin,f.invocation,process,signal)).rejects.toThrow('NATIVE_RESOURCE_BASE_MISMATCH');
 expect(await readdir(f.custody)).toHaveLength(1);
 f.exited();await f.resources.release!();
});

it('keeps successive turn bases in custody, rejects retired-base children and enforces one cumulative request cap',async()=>{
 const f=await fixture(),signal=new AbortController().signal,owner={pid:101,creationIdentity:'child'};
 let previousBytes=0;
 for(let n=1;n<=3;n++){
  const target=await f.resources.destination(signal,'base');
  const path=join(f.snapshots,`.native-source-22222222-2222-4222-8222-${String(n).padStart(12,'0')}.tmp`);
  await writeFile(path,'');await target.beforeCopy!(path);await writeFile(path,`SYNTHETIC-TURN-${n}`);target.copySettled?.();
  const base=await f.resources.claim({...f.source,snapshot:{...f.source.snapshot,path}},f.invocation,owner,signal);
  await writeFile(join(f.runtimeHome,'sessions',`base-${n}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:`base-${n}`,thread_source:base.tag}})+'\n');
  await base.recordFork(`base-${n}`);
  if(n>1)await expect(f.resources.claimChild({baseThreadId:`base-${n-1}`,rootSourceThreadId:'source'},f.invocation,owner,signal)).rejects.toThrow('NATIVE_RESOURCE_BASE_MISMATCH');
  const child=await f.resources.claimChild({baseThreadId:`base-${n}`,rootSourceThreadId:'source'},f.invocation,owner,signal);
  await writeFile(join(f.runtimeHome,'sessions',`child-${n}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:`child-${n}`,thread_source:child.tag}})+'\n');
  await child.recordFork(`child-${n}`);
  const usage=await f.resources.usage();expect(usage.requests).toBe(n);expect(usage.knownBytes).toBeGreaterThan(previousBytes);previousBytes=usage.knownBytes;
 }
 await expect(f.resources.destination(signal,'base')).rejects.toThrow('NATIVE_RESOURCE_LIMIT');
 await expect(f.resources.release!()).rejects.toThrow();
 expect((await readdir(f.snapshots)).filter(name=>name.endsWith('.tmp'))).toHaveLength(3);
 f.exited();await f.resources.release!();
 expect(f.calls.filter(method=>method==='thread/delete')).toHaveLength(6);
 expect(await readdir(f.snapshots)).toEqual([]);expect(await readdir(f.custody)).toEqual([]);
});

it('serializes concurrent child allocations against the three-request cap',async()=>{
 const f=await fixture(),signal=new AbortController().signal,owner={pid:101,creationIdentity:'child'};
 await f.prepare('base');const base=await f.resources.claim(f.source,f.invocation,owner,signal);
 await writeFile(join(f.runtimeHome,'sessions','base.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'base',thread_source:base.tag}})+'\n');await base.recordFork('base');
 const results=await Promise.allSettled(Array.from({length:5},()=>f.resources.claimChild({baseThreadId:'base',rootSourceThreadId:'source'},f.invocation,owner,signal)));
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(3);
 expect(results.filter(result=>result.status==='rejected')).toHaveLength(2);
 expect((await f.resources.usage()).requests).toBe(3);
 f.exited();await f.resources.release!();expect(await readdir(f.custody)).toEqual([]);
});

it('waits for child-intent persistence before release and retains lost-reply cleanup authority',async()=>{
 const f=await fixture(),signal=new AbortController().signal,owner={pid:101,creationIdentity:'child'};
 await f.prepare('base');const base=await f.resources.claim(f.source,f.invocation,owner,signal);
 await writeFile(join(f.runtimeHome,'sessions','base.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'base',thread_source:base.tag}})+'\n');await base.recordFork('base');
 let unblock!:()=>void,entered!:()=>void,once=true;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 f.onVerify(async()=>{if(once){once=false;entered();await new Promise<void>(resolve=>{unblock=resolve;});}});
 const allocation=f.resources.claimChild({baseThreadId:'base',rootSourceThreadId:'source'},f.invocation,owner,signal);
 await started;let released=false;const release=f.resources.release!().finally(()=>{released=true;});const outcome=release.catch(error=>error);
 await new Promise<void>(resolve=>setImmediate(resolve));expect(released).toBe(false);
 unblock();const child=await allocation;await outcome;
 // Simulate a fork written by the runtime but whose acknowledgement was lost.
 await writeFile(join(f.runtimeHome,'sessions','lost.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'lost',thread_source:child.tag}})+'\n');
 f.exited();await f.resources.release!();expect(f.calls.filter(method=>method==='thread/delete')).toHaveLength(2);
 expect(await readdir(f.custody)).toEqual([]);
});

it('does not accept the same fork ID for two concurrent child acknowledgements',async()=>{
 const f=await fixture(),signal=new AbortController().signal,owner={pid:101,creationIdentity:'child'};
 await f.prepare('base');const base=await f.resources.claim(f.source,f.invocation,owner,signal);
 await writeFile(join(f.runtimeHome,'sessions','base.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'base',thread_source:base.tag}})+'\n');await base.recordFork('base');
 const a=await f.resources.claimChild({baseThreadId:'base',rootSourceThreadId:'source'},f.invocation,owner,signal);
 const b=await f.resources.claimChild({baseThreadId:'base',rootSourceThreadId:'source'},f.invocation,owner,signal);
 const results=await Promise.allSettled([a.recordFork('duplicate'),b.recordFork('duplicate')]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
 f.exited();await f.resources.release!();
});
it('releases pre-fork destination custody without launching a cleanup process',async()=>{
 const f=await fixture();await f.resources.destination(new AbortController().signal);await f.resources.release!();
 expect(await readdir(f.snapshots)).toEqual([]);expect(f.cleanupStarts()).toBe(0);
});
it('allocates concurrent conversation manifests in the shared home without confusing their ownership',async()=>{
 const f=await fixture(),peer=f.peer(),signal=new AbortController().signal;
 try{
  await Promise.all([f.resources.destination(signal),peer.destination(signal)]);
  expect((await f.resources.usage!()).requests).toBe(1);expect((await peer.usage!()).requests).toBe(1);
 }finally{await f.resources.release!();await peer.release!();}
 expect(await readdir(f.snapshots)).toEqual([]);
});
it('does not start a cleanup runtime when allocating another request for a live owner',async()=>{
 const f=await fixture(),signal=new AbortController().signal;await f.prepare();
 const claim=await f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},signal);
 await f.fork(claim.tag);await claim.recordFork('fork');
 try{await f.resources.destination(signal);expect(f.cleanupStarts()).toBe(0);}
 finally{f.exited();await f.resources.release!();}
});
it('drains an in-progress allocation before releasing all generation resources',async()=>{
 const f=await fixture();let unblock!:()=>void;
 f.onPrepare(()=>new Promise<void>(resolve=>{unblock=resolve;}));
 const allocating=f.resources.destination(new AbortController().signal);
 await new Promise<void>(resolve=>setImmediate(resolve));
 const releasing=f.resources.release!();unblock();
 await expect(Promise.all([allocating,releasing])).resolves.toHaveLength(2);
 expect(await readdir(f.snapshots)).toEqual([]);
});
it('does not delete a snapshot while its child ownership claim is being persisted',async()=>{
 const f=await fixture();await f.prepare();let unblock!:()=>void,first=true,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 f.onVerify(async()=>{if(first){first=false;entered();await new Promise<void>(resolve=>{unblock=resolve;});}});
 const claiming=f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},new AbortController().signal);
 const claimResult=claiming.catch(error=>error);await started;
 let settled=false;const releasing=f.resources.release!().finally(()=>{settled=true;});const releaseResult=releasing.catch(error=>error);
 try{await new Promise(resolve=>setTimeout(resolve,50));expect(settled).toBe(false);
  expect(await readFile(f.source.snapshot.path,'utf8')).toBe('PRIVATE SYNTHETIC HISTORY');
 }finally{unblock();await claimResult;await releaseResult;f.exited();await f.resources.release!();}
 expect(await readdir(f.snapshots)).toEqual([]);
});
it('rejects a different runtime home before binding or forking',async()=>{
 const f=await fixture();await f.prepare();
 await expect(f.resources.claim(f.source,{...f.invocation,env:{CODEX_HOME:join(f.root,'other')}},{pid:101,creationIdentity:'child'},new AbortController().signal)).rejects.toThrow();
 await f.resources.release!();expect(await readdir(f.custody)).toEqual([]);expect(f.cleanupStarts()).toBe(0);
});
it('waits for a started source copy to settle before deleting its file',async()=>{
 const f=await fixture(),target=await f.resources.destination(new AbortController().signal);
 await writeFile(f.source.snapshot.path,'');await target.beforeCopy!(f.source.snapshot.path);
 const beforeReleaseChecks=f.verifications();
 let closed=false;const release=f.resources.release!().then(()=>{closed=true;});
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));expect(closed).toBe(false);
  expect(f.verifications()).toBe(beforeReleaseChecks);
  expect(await readFile(f.source.snapshot.path,'utf8')).toBe('');
 }finally{target.copySettled?.();await release;}
 expect(closed).toBe(true);expect(await readdir(f.snapshots)).toEqual([]);
});

it('retains two independent leases and rejects a fourth registered request',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const targets=[];
 for(let i=0;i<3;i++)targets.push(await f.resources.destination(signal));
 await expect(f.resources.destination(signal)).rejects.toThrow('NATIVE_RESOURCE_LIMIT');
 for(const [i,target] of targets.entries()){
  const path=join(f.snapshots,`.native-source-${String(i+2).padStart(8,'0')}-${String(i+2).padStart(4,'0')}-4${String(i+2).padStart(3,'0')}-8${String(i+2).padStart(3,'0')}-${String(i+2).padStart(12,'0')}.tmp`);
  await writeFile(path,'');await target.beforeCopy!(path);await writeFile(path,`PRIVATE ${i}`);target.copySettled?.();
 }
 const usage=(f.resources as typeof f.resources&{usage():Promise<{requests:number;knownBytes:number}>}).usage;
 await expect(usage()).resolves.toMatchObject({requests:3});
});

it('matches claim to the exact registered snapshot rather than the latest lease',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const first=await f.resources.destination(signal),second=await f.resources.destination(signal);
 const firstPath=join(f.snapshots,'.native-source-22222222-2222-4222-8222-222222222222.tmp');
 const secondPath=join(f.snapshots,'.native-source-33333333-3333-4333-8333-333333333333.tmp');
 await writeFile(firstPath,'');await first.beforeCopy!(firstPath);await writeFile(firstPath,'FIRST');first.copySettled?.();
 await writeFile(secondPath,'');await second.beforeCopy!(secondPath);await writeFile(secondPath,'SECOND');second.copySettled?.();
 const originalPath=f.source.snapshot.path;f.source.snapshot.path=firstPath;
 await expect(f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},signal)).resolves.toBeDefined();
 f.source.snapshot.path=originalPath;
});

it('keeps half-copy custody retryable after a live-owner release failure',async()=>{
 const f=await fixture(),target=await f.resources.destination(new AbortController().signal);
 await writeFile(f.source.snapshot.path,'');await target.beforeCopy!(f.source.snapshot.path);await writeFile(f.source.snapshot.path,'PARTIAL');target.copySettled?.();
 const claim=await f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},new AbortController().signal);
 await f.fork(claim.tag);await claim.recordFork('fork');
 await expect(f.resources.release!()).rejects.toThrow();
 expect(await readFile(f.source.snapshot.path,'utf8')).toBe('PARTIAL');
 f.exited();await f.resources.release!();
 await expect(readFile(f.source.snapshot.path,'utf8')).rejects.toMatchObject({code:'ENOENT'});
});

it('retires the verifier after successful cleanup and permits another allocation',async()=>{
 let checks=0,retired=0;
 const f=await fixture({verify:async()=>{checks++;},isExited:async()=>false,retire:async()=>{retired++;}});
 await f.resources.destination(new AbortController().signal);await f.resources.release!();
 expect(checks).toBeGreaterThan(0);expect(retired).toBe(1);expect(await readdir(f.snapshots)).toEqual([]);
 await f.resources.destination(new AbortController().signal);await f.resources.release!();expect(retired).toBe(2);
});
it('retires on cleanup failure without discarding pending snapshot custody',async()=>{
 let rejectChecks=false,retired=0;
 const f=await fixture({verify:async()=>{if(rejectChecks)throw Error('CHECK_FAILED');},isExited:async()=>false,retire:async()=>{retired++;}});
 await f.resources.destination(new AbortController().signal);const before=await readdir(f.snapshots);rejectChecks=true;
 await expect(f.resources.release!()).rejects.toThrow('CHECK_FAILED');expect(retired).toBe(1);
 expect(await readdir(f.snapshots)).toEqual(before);rejectChecks=false;await f.resources.release!();
 expect(await readdir(f.snapshots)).toEqual([]);
});
it('unconfirmed verifier retirement permanently blocks new allocations',async()=>{
 const f=await fixture({verify:async()=>{},isExited:async()=>false,retire:async()=>{throw Error('CLOSE_UNCONFIRMED');}});
 await f.resources.destination(new AbortController().signal);
 await expect(f.resources.release!()).rejects.toThrow('CLOSE_UNCONFIRMED');
 await expect(f.resources.destination(new AbortController().signal)).rejects.toThrow('NATIVE_GUARD_POISONED');
});
it('propagates claim cancellation into the active verifier',async()=>{
 let capture=false,seen:AbortSignal|undefined,entered!:()=>void,unblock!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const f=await fixture({verify:async signal=>{if(capture){seen=signal;entered();await new Promise<void>(resolve=>{unblock=resolve;});}},isExited:async()=>false,retire:async()=>{}});
 await f.prepare();capture=true;const controller=new AbortController();
 const claim=f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},controller.signal).catch(error=>error);
 await started;controller.abort();const cancelled=seen!.aborted;capture=false;unblock();await claim;
 expect(cancelled).toBe(true);
});
it('keeps cancellation for destination callbacks invoked after allocation returns',async()=>{
 let capture=false,seen:AbortSignal|undefined,entered!:()=>void,unblock!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const f=await fixture({verify:async signal=>{if(capture){seen=signal;entered();await new Promise<void>(resolve=>{unblock=resolve;});}},isExited:async()=>false,retire:async()=>{}});
 const controller=new AbortController();const destination=await f.resources.destination(controller.signal);
 capture=true;const check=destination.verifyDestination!().catch(error=>error);await started;
 controller.abort();const cancelled=seen!.aborted;capture=false;unblock();await check;
 // Release is separate from the now-cancelled foreground operation.
 await f.resources.release!();expect(cancelled).toBe(true);expect(await readdir(f.snapshots)).toEqual([]);
});
it('keeps cancellation for fork acknowledgement after claim returns',async()=>{
 let capture=false,seen:AbortSignal|undefined,entered!:()=>void,unblock!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const f=await fixture({verify:async signal=>{if(capture){seen=signal;entered();await new Promise<void>(resolve=>{unblock=resolve;});}},isExited:async()=>true,retire:async()=>{}});
 await f.prepare();const controller=new AbortController();
 const claim=await f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},controller.signal);
 capture=true;const ack=claim.recordFork('fork').catch(error=>error);await started;
 controller.abort();const cancelled=seen!.aborted;capture=false;unblock();await ack;expect(cancelled).toBe(true);
});
