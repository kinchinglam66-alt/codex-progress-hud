import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {dirname,join,resolve} from 'node:path';
import {createNativeStorage} from './native-storage.js';
import {createNativeSnapshotCustody,recoverNativeSnapshotCustody,type NativeSnapshotCustody,type NativeSnapshotProcess} from './native-snapshot-custody.js';
import {createNativeForkCustody,recoverNativeForkCustody} from './native-fork-custody.js';
import {captureInvocationProcessIdentity,isInvocationProcessIdentityExited} from './invocation-process.js';
import {createObserverSessionProcess} from './observer-session-process.js';
import type {SessionRpc} from './observer-persistent-session.js';
import type {NativeWorkerResources,NativeWorkerClaim} from './observer-persistent-worker.js';
import type {Invocation} from './owned-process.js';
import type {NativeGuard} from './native-guard.js';

const MAX_RECORDS=3;
const MAX_SOURCE_BYTES=8*1024*1024;
const FORK_MANIFEST=/^custody-[a-f0-9-]{36}\.jsonl$/u;
const FORK_LOG=/\.jsonl$/u;

interface CleanupProcess {start(invocation:Invocation):Promise<{rpc:SessionRpc&{notify(method:string,params:unknown):void}}>;disable():void;close():Promise<void>}
interface Options {
 runtimeHome:string;maxSourceBytes:number;
 /** Fresh asset/home attestation only; must not require account connectivity. */
 prepareCleanupInvocation(signal:AbortSignal):Promise<Invocation>;
 storage?:ReturnType<typeof createNativeStorage>;
 /** Trusted composition only; never derived from source conversation data. */
 guard?:NativeGuard;
 captureController?:()=>Promise<NativeSnapshotProcess>;
 isExited?:(identity:NativeSnapshotProcess)=>Promise<boolean>;
 cleanupProcessFactory?:()=>CleanupProcess;
}
export interface NativeResourceUsage {requests:number;knownBytes:number}
interface FileIdentity {device:string;inode:string;birthtimeMs:string;linkCount:string}
interface OwnedFile {path:string;identity:FileIdentity}
interface ForkLease {tag:string;sourceThreadId:string;process:NativeSnapshotProcess;custody:Awaited<ReturnType<typeof createNativeForkCustody>>;manifest?:OwnedFile;threadId?:string;forkLog?:OwnedFile}
interface LeaseRecord {
 role:'request'|'base';
 snapshot:NativeSnapshotCustody;snapshotManifest?:OwnedFile;snapshotPath?:string;snapshotIdentity?:FileIdentity;
 copyActive:boolean;copyDone:Promise<void>;finishCopy:(()=>void)|undefined;copyRegistered:boolean;claimPending:boolean;claimDone?:Promise<void>;fork?:ForkLease;
}
type Paths={snapshots:string;custody:string};

const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const sameIdentity=(left:FileIdentity,right:FileIdentity)=>left.device===right.device&&left.inode===right.inode&&left.birthtimeMs===right.birthtimeMs&&left.linkCount===right.linkCount;
const fileIdentity=(stat:{dev:number;ino:number;birthtimeMs:number;nlink:number}):FileIdentity=>({device:String(stat.dev),inode:String(stat.ino),birthtimeMs:String(stat.birthtimeMs),linkCount:String(stat.nlink)});
const fail=(code:string)=>new Error(code);

async function assertPlainPath(path:string):Promise<void>{
 const target=resolve(path);
 for(let current=target;;current=dirname(current)){
  const stat=await lstat(current);
  if(stat.isSymbolicLink()||canonical(await realpath(current))!==canonical(current))throw fail('NATIVE_RESOURCE_REPARSE');
  if(current!==target&&!stat.isDirectory())throw fail('NATIVE_RESOURCE_PATH');
  if(dirname(current)===current)break;
 }
}
async function readOwnedFile(path:string,expected?:FileIdentity):Promise<{identity:FileIdentity;size:number}>{
 await assertPlainPath(path);const before=await lstat(path);
 if(!before.isFile()||before.nlink!==1)throw fail('NATIVE_RESOURCE_OWNERSHIP_UNKNOWN');
 const beforeIdentity=fileIdentity(before);if(expected&&!sameIdentity(beforeIdentity,expected))throw fail('NATIVE_RESOURCE_REPLACED');
 const handle=await open(path,'r');
 try{
  const opened=await handle.stat();if(!sameIdentity(fileIdentity(opened),beforeIdentity))throw fail('NATIVE_RESOURCE_REPLACED');
  const afterHandle=await handle.stat(),afterIdentity=fileIdentity(afterHandle),after=await lstat(path);
  if(!sameIdentity(afterIdentity,beforeIdentity)||!sameIdentity(fileIdentity(after),beforeIdentity))throw fail('NATIVE_RESOURCE_REPLACED');
  const size=Number(afterHandle.size);if(!Number.isSafeInteger(size)||size<0)throw fail('NATIVE_RESOURCE_SIZE_UNKNOWN');
  return {identity:afterIdentity,size};
 }finally{await handle.close();}
}
async function readFirstLine(path:string,expected?:FileIdentity):Promise<{identity:FileIdentity;size:number;text:string}>{
 await assertPlainPath(path);const before=await lstat(path);
 if(!before.isFile()||before.nlink!==1)throw fail('NATIVE_RESOURCE_OWNERSHIP_UNKNOWN');
 const beforeIdentity=fileIdentity(before);if(expected&&!sameIdentity(beforeIdentity,expected))throw fail('NATIVE_RESOURCE_REPLACED');
 const handle=await open(path,'r');
 try{
  const opened=await handle.stat();if(!sameIdentity(fileIdentity(opened),beforeIdentity))throw fail('NATIVE_RESOURCE_REPLACED');
  const buffer=Buffer.alloc(Math.min(Number(opened.size),1024*1024));let used=0,newline=-1;
  while(used<buffer.length){const read=await handle.read(buffer,used,buffer.length-used,used);if(read.bytesRead===0)break;used+=read.bytesRead;newline=buffer.subarray(0,used).indexOf(10);if(newline>=0)break;}
  if(newline<0)throw fail('NATIVE_RESOURCE_METADATA_UNKNOWN');
  const afterHandle=await handle.stat(),afterIdentity=fileIdentity(afterHandle),after=await lstat(path);
  if(!sameIdentity(afterIdentity,beforeIdentity)||!sameIdentity(fileIdentity(after),beforeIdentity))throw fail('NATIVE_RESOURCE_REPLACED');
  const size=Number(afterHandle.size);if(!Number.isSafeInteger(size)||size<0)throw fail('NATIVE_RESOURCE_SIZE_UNKNOWN');
  return {identity:afterIdentity,size,text:buffer.subarray(0,newline).toString('utf8')};
 }finally{await handle.close();}
}
async function forkLogFiles(runtimeHome:string):Promise<string[]>{
 const found:string[]=[];let visited=0;
 const walk=async(path:string,depth:number):Promise<void>=>{
  if(depth>8||++visited>50000)throw fail('NATIVE_RESOURCE_SCAN_LIMIT');await assertPlainPath(path);
  for(const entry of await readdir(path,{withFileTypes:true})){
   const child=join(path,entry.name);if(entry.isSymbolicLink())throw fail('NATIVE_RESOURCE_REPARSE');
   if(entry.isDirectory())await walk(child,depth+1);else if(entry.isFile()&&FORK_LOG.test(entry.name))found.push(child);
  }
 };
 for(const name of ['sessions','archived_sessions']){
  const path=join(runtimeHome,name);
  try{const stat=await lstat(path);if(!stat.isDirectory())throw fail('NATIVE_RESOURCE_PATH');}
  catch(caught){if((caught as NodeJS.ErrnoException).code==='ENOENT')continue;throw caught;}
  await walk(path,0);
 }
 return found;
}
async function discoverForkLog(runtimeHome:string,lease:ForkLease):Promise<OwnedFile&{size:number}>{
 const match=async(path:string,expected?:FileIdentity)=>{
  const head=await readFirstLine(path,expected),metadata:unknown=JSON.parse(head.text);
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw fail('NATIVE_RESOURCE_METADATA_UNKNOWN');
  const payload=(metadata as {type?:unknown;payload?:{id?:unknown;thread_source?:unknown}});
  if(payload.type!=='session_meta'||payload.payload===undefined||payload.payload.id!==lease.threadId||payload.payload.thread_source!==lease.tag)return undefined;
  return {path,identity:head.identity,size:head.size};
 };
 if(lease.forkLog){const cached=await match(lease.forkLog.path,lease.forkLog.identity);if(!cached)throw fail('NATIVE_RESOURCE_OWNERSHIP_UNKNOWN');return cached;}
 const found:(OwnedFile&{size:number})[]=[];for(const path of await forkLogFiles(runtimeHome)){const candidate=await match(path);if(candidate)found.push(candidate);}
 if(found.length!==1)throw fail('NATIVE_RESOURCE_FORK_LOG_UNKNOWN');lease.forkLog=found[0]!;return found[0]!;
}

/** One process generation owns several independent request leases. The caller
 * supplies authorization, scheduling and the generation boundary. */
export function createNativeWorkerResources(options:Options):NativeWorkerResources&{usage():Promise<NativeResourceUsage>;claimChild:NonNullable<NativeWorkerResources['claimChild']>}{
 if(!Number.isSafeInteger(options.maxSourceBytes)||options.maxSourceBytes<1||options.maxSourceBytes>MAX_SOURCE_BYTES)throw fail('NATIVE_SOURCE_LIMIT_INVALID');
 const storage=options.storage??createNativeStorage(options.runtimeHome);
 const guardSignals=new AsyncLocalStorage<AbortSignal>();
 let guardPoisoned=false;
 const assertGuard=()=>{if(guardPoisoned)throw fail('NATIVE_GUARD_POISONED');};
 const verifyStorage=async(signal:AbortSignal=guardSignals.getStore()??new AbortController().signal)=>{
  assertGuard();signal.throwIfAborted();if(options.guard)await options.guard.verify(signal);else await storage.verify(signal);signal.throwIfAborted();
 };
 const isExited=async(identity:NativeSnapshotProcess,signal:AbortSignal=guardSignals.getStore()??new AbortController().signal)=>{
  assertGuard();return options.guard?options.guard.isExited(identity,signal):(options.isExited??isInvocationProcessIdentityExited)(identity);
 };
 let paths:Paths|undefined;const records:LeaseRecord[]=[],children:{fork?:ForkLease}[]=[];let releasing:Promise<void>|undefined;let cleanupPromise:Promise<void>|undefined;let allocationPromise:Promise<unknown>|undefined;
 const requestCount=()=>records.filter(record=>record.role==='request').length+children.length;
 const allForks=()=>[...records,...children].flatMap(record=>record.fork?[record.fork]:[]);
 const pendingForkIds=new Set<string>(),acknowledgements=new Set<Promise<void>>();
 const assertHome=(invocation:Invocation)=>{const homes=Object.entries(invocation.env).filter(([key])=>key.toUpperCase()==='CODEX_HOME');if(homes.length!==1||typeof homes[0]![1]!=='string'||canonical(homes[0]![1]!)!==canonical(options.runtimeHome))throw fail('NATIVE_RUNTIME_HOME_MISMATCH');};
 const cleanupForks=async():Promise<void>=>{
  if(cleanupPromise)return cleanupPromise;
  const work=(async()=>{
   if(!paths)throw fail('NATIVE_STORAGE_UNAVAILABLE');await verifyStorage();
   if(!(await readdir(paths.custody)).some(name=>FORK_MANIFEST.test(name)))return;
   const controller=new AbortController(),owner=(options.cleanupProcessFactory??createObserverSessionProcess)();let unsubscribe:(()=>void)|undefined;const timer=setTimeout(()=>{controller.abort();owner.disable();},20000);
   try{
    const invocation=await options.prepareCleanupInvocation(controller.signal);controller.signal.throwIfAborted();assertHome(invocation);await verifyStorage(controller.signal);
    const {rpc}=await owner.start(invocation);controller.signal.throwIfAborted();unsubscribe=rpc.subscribe(notification=>{if(notification.method==='turn/started'||notification.method==='thread/tokenUsage/updated'||notification.method==='item/started'){controller.abort();owner.disable();}});
    await rpc.call('initialize',{clientInfo:{name:'hud_native_cleanup',version:'1.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized',{});controller.signal.throwIfAborted();
    await recoverNativeForkCustody({directory:paths.custody,runtimeHome:options.runtimeHome,verifyStorage:()=>verifyStorage(controller.signal),isExited:identity=>isExited(identity,controller.signal),rpc:{subscribe:rpc.subscribe,call:async(method,params)=>{controller.signal.throwIfAborted();if(method!=='thread/delete')throw fail('NATIVE_CLEANUP_RPC_FORBIDDEN');return rpc.call(method,params);}}});controller.signal.throwIfAborted();
   }finally{clearTimeout(timer);unsubscribe?.();await owner.close();}
  })();
  let joined!:Promise<void>;
  joined=work.finally(()=>{if(cleanupPromise===joined)cleanupPromise=undefined;});
  cleanupPromise=joined;return joined;
 };
 const beginCopy=(record:LeaseRecord)=>{let finish!:()=>void;record.copyDone=new Promise<void>(resolve=>{finish=resolve;});record.finishCopy=finish;record.copyActive=true;};
 const createForkLease=async(record:{fork?:ForkLease},sourceThreadId:string,child:NativeSnapshotProcess,signal:AbortSignal,rootSourceThreadId?:string):Promise<NativeWorkerClaim>=>{
  if(!paths)throw fail('NATIVE_STORAGE_UNAVAILABLE');
  const custody=await createNativeForkCustody({directory:paths.custody,runtimeHome:options.runtimeHome,verifyStorage,sourceThreadId,process:child,...(rootSourceThreadId===undefined?{}:{rootSourceThreadId})});
  const fork:ForkLease={tag:custody.tag,sourceThreadId,process:child,custody};record.fork=fork;
  fork.manifest={path:custody.manifestPath,identity:(await readOwnedFile(custody.manifestPath)).identity};
  return {tag:custody.tag,recordFork:async(threadId:string)=>guardSignals.run(signal,async()=>{
   signal.throwIfAborted();
   if(releasing)throw fail('NATIVE_RESOURCE_BUSY');
   if(fork.threadId!==undefined&&fork.threadId!==threadId)throw fail('NATIVE_RESOURCE_FORK_MISMATCH');
   if(pendingForkIds.has(threadId)||allForks().some(other=>other!==fork&&other.threadId===threadId))throw fail('NATIVE_RESOURCE_FORK_MISMATCH');
   pendingForkIds.add(threadId);
   const acknowledgement=custody.recordFork(threadId).then(()=>{fork.threadId=threadId;});acknowledgements.add(acknowledgement);
   try{await acknowledgement;}finally{pendingForkIds.delete(threadId);acknowledgements.delete(acknowledgement);}
  }),afterProcessClosed:async()=>{if(await isExited(child)!==true)throw fail('NATIVE_OWNER_EXIT_UNCONFIRMED');await Promise.allSettled([...acknowledgements]);if(!await custody.isRetired())await cleanupForks();if(!await custody.isRetired())throw fail('NATIVE_FORK_CLEANUP_PENDING');}};
 };
 const usage=async():Promise<NativeResourceUsage>=>{
  if(!paths)return {requests:0,knownBytes:0};await verifyStorage();let knownBytes=0;
  for(const record of records){
   if(!record.snapshotManifest)throw fail('NATIVE_RESOURCE_MANIFEST_UNKNOWN');
   knownBytes+=(await readOwnedFile(record.snapshotManifest.path,record.snapshotManifest.identity)).size;
   if(record.snapshotPath){if(!record.snapshotIdentity)throw fail('NATIVE_RESOURCE_OWNERSHIP_UNKNOWN');knownBytes+=(await readOwnedFile(record.snapshotPath,record.snapshotIdentity)).size;}
  }
  for(const child of children)if(!child.fork)throw fail('NATIVE_RESOURCE_MANIFEST_UNKNOWN');
  for(const fork of allForks()){
   if(!fork.manifest)throw fail('NATIVE_RESOURCE_MANIFEST_UNKNOWN');
   knownBytes+=(await readOwnedFile(fork.manifest.path,fork.manifest.identity)).size;
   if(fork.threadId)knownBytes+=(await discoverForkLog(options.runtimeHome,fork)).size;
  }
  return {requests:requestCount(),knownBytes};
 };
 return {
  async destination(signal,role='request'){
   assertGuard();
   if(releasing)throw fail('NATIVE_RESOURCE_BUSY');
   const previous=allocationPromise;
   const current=(previous??Promise.resolve()).catch(()=>undefined).then(()=>guardSignals.run(signal,async()=>{
   if(releasing)throw fail('NATIVE_RESOURCE_BUSY');signal.throwIfAborted();
   if(role!=='request'&&role!=='base')throw fail('NATIVE_RESOURCE_ROLE_INVALID');
   if(role==='base'){
    const baseCount=records.filter(record=>record.role==='base').length;
    if(baseCount>=MAX_RECORDS||requestCount()>=MAX_RECORDS)throw fail('NATIVE_RESOURCE_LIMIT');
    // One new turn base requires an earlier request; never accumulate empty
    // bases independently of the process's bounded request lifecycle.
    if(baseCount>requestCount())throw fail('NATIVE_RESOURCE_BASE_EXISTS');
   }
   if(role==='request'&&requestCount()>=MAX_RECORDS)throw fail('NATIVE_RESOURCE_LIMIT');if(records.some(record=>record.copyActive||record.claimPending))throw fail('NATIVE_RESOURCE_BUSY');
   if(records.length===0){
    paths=await storage.prepare(signal);signal.throwIfAborted();await cleanupForks();signal.throwIfAborted();
    await recoverNativeSnapshotCustody({directory:paths.snapshots,runtimeHome:options.runtimeHome,verifyStorage,isExited});
   }else await verifyStorage(signal);
   signal.throwIfAborted();if(!paths)throw fail('NATIVE_STORAGE_UNAVAILABLE');
   const controller=options.captureController?await options.captureController():await (async()=>{const creationIdentity=await captureInvocationProcessIdentity(process.pid);if(!creationIdentity)throw fail('NATIVE_CONTROLLER_IDENTITY_UNAVAILABLE');return {pid:process.pid,creationIdentity};})();signal.throwIfAborted();
   const snapshot=await createNativeSnapshotCustody({directory:paths.snapshots,runtimeHome:options.runtimeHome,verifyStorage,controller,isExited});
   const record:LeaseRecord={role,snapshot,copyActive:false,copyDone:Promise.resolve(),finishCopy:undefined,copyRegistered:false,claimPending:false};
   records.push(record); // Keep cleanup authority even if identity measurement fails.
   record.snapshotManifest={path:snapshot.manifestPath,identity:(await readOwnedFile(snapshot.manifestPath)).identity};
   const allocated=record;
   return {sourceProfile:'codex-01534-legacy' as const,destinationDirectory:paths.snapshots,maxSourceBytes:options.maxSourceBytes,verifyDestination:()=>verifyStorage(signal),
    beforeCopy:async(path:string)=>guardSignals.run(signal,async()=>{signal.throwIfAborted();if(!records.includes(allocated)||releasing||allocated.copyRegistered||allocated.copyActive)throw fail('NATIVE_RESOURCE_STALE');beginCopy(allocated);try{await allocated.snapshot.beforeCopy(path);allocated.snapshotPath=canonical(path);allocated.snapshotIdentity=(await readOwnedFile(path)).identity;allocated.copyRegistered=true;}catch(caught){allocated.copyActive=false;allocated.finishCopy?.();allocated.finishCopy=undefined;throw caught;}}),
    copySettled:()=>{if(allocated.copyActive){allocated.copyActive=false;allocated.finishCopy?.();allocated.finishCopy=undefined;}}
   };
   }));
   allocationPromise=current;
   try{return await current;}finally{if(allocationPromise===current)allocationPromise=undefined;}
  },
  async claim(source,invocation,child,signal){
   assertGuard();
   if(releasing)throw fail('NATIVE_RESOURCE_BUSY');
   signal.throwIfAborted();assertHome(invocation);const record=records.find(candidate=>candidate.snapshotPath!==undefined&&candidate.snapshotPath===canonical(source.snapshot.path));if(!record||record.copyActive||!record.copyRegistered||record.fork||record.claimPending)throw fail('NATIVE_RESOURCE_UNREGISTERED');record.claimPending=true;
   let finishClaim!:()=>void;record.claimDone=new Promise<void>(resolve=>{finishClaim=resolve;});
   try{return await guardSignals.run(signal,async()=>{if(!paths)throw fail('NATIVE_STORAGE_UNAVAILABLE');await verifyStorage();await record.snapshot.bindChild(child);signal.throwIfAborted();
    return createForkLease(record,source.snapshot.sourceThreadId,child,signal);
   });}finally{record.claimPending=false;finishClaim();}
  },
  async claimChild(source,invocation,child,signal){
   assertGuard();
   if(releasing)throw fail('NATIVE_RESOURCE_BUSY');
   const previous=allocationPromise;
   const current=(previous??Promise.resolve()).catch(()=>undefined).then(()=>guardSignals.run(signal,async()=>{
    if(releasing)throw fail('NATIVE_RESOURCE_BUSY');signal.throwIfAborted();assertHome(invocation);
    if(requestCount()>=MAX_RECORDS)throw fail('NATIVE_RESOURCE_LIMIT');
    const base=records.filter(record=>record.role==='base').at(-1)?.fork;
    if(!base||base.threadId!==source.baseThreadId||base.sourceThreadId!==source.rootSourceThreadId||base.process.pid!==child.pid||base.process.creationIdentity!==child.creationIdentity)throw fail('NATIVE_RESOURCE_BASE_MISMATCH');
    await verifyStorage();await discoverForkLog(options.runtimeHome,base);signal.throwIfAborted();
    const record:{fork?:ForkLease}={};children.push(record); // Retain failed allocation evidence until release.
    return createForkLease(record,source.baseThreadId,child,signal,source.rootSourceThreadId);
   }));
   allocationPromise=current;
   try{return await current;}finally{if(allocationPromise===current)allocationPromise=undefined;}
  },
  async release(){
   if(releasing)return releasing;
   const work=(async()=>{
    try{
    await allocationPromise?.catch(()=>undefined);
    await Promise.all(records.map(record=>record.copyDone));
    await Promise.all(records.map(record=>record.claimDone));
    await Promise.allSettled([...acknowledgements]);
    // Startup handles shared-home recovery. Teardown need not start another
    // runtime solely because an unrelated live generation retains its intent.
    if(paths){
     let pending=false;
     for(const fork of allForks())if(!await fork.custody.isRetired())pending=true;
     if(pending)await cleanupForks();
    }
    for(const fork of allForks())if(!await fork.custody.isRetired())throw fail('NATIVE_FORK_CLEANUP_PENDING');
    for(const record of records)await record.snapshot.close();
    }finally{
     try{await options.guard?.retire();}catch(error){guardPoisoned=true;throw error;}
    }
    records.splice(0,records.length);children.splice(0,children.length);
   })();
   releasing=work.finally(()=>{releasing=undefined;});return releasing;
  },
  usage
 };
}
