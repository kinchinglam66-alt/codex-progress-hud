import {randomUUID} from 'node:crypto';
import {lstat,open,readdir,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANIFEST_NAME=/^native-snapshot-custody-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const SNAPSHOT_NAME=/^\.native-source-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/i;
const MAX_MANIFEST_BYTES=256*1024;
const MAX_CHILDREN=128;

export interface NativeSnapshotProcess {pid:number;creationIdentity:string}
export interface NativeSnapshotStorage {directory:string;runtimeHome:string;verifyStorage:()=>Promise<void>}
export interface NativeSnapshotCustodyOptions extends NativeSnapshotStorage {
 controller:NativeSnapshotProcess;
 /** Trusted read-only process identity probe. False or rejection is fail-closed. */
 isExited:(process:NativeSnapshotProcess)=>Promise<boolean>;
}
export interface NativeSnapshotCustody {
 /** Exact local custody file, for identity-checked resource measurement. Never remote prompt data. */
 readonly manifestPath:string;
 /** Register the exclusive empty destination before source bytes are copied. */
 beforeCopy(path:string):Promise<void>;
 /** Persist a child identity before dispatching work to that child. */
 bindChild(process:NativeSnapshotProcess):Promise<void>;
 /** Clean only after all registered children are confirmed exited. */
 close():Promise<void>;
 /** Alias for close, retained as an explicit cleanup capability. */
 cleanup():Promise<void>;
}
export interface NativeSnapshotRecoveryOptions extends NativeSnapshotStorage {
 isExited:(process:NativeSnapshotProcess)=>Promise<boolean>;
}
export interface NativeSnapshotRecoveryResult {cleaned:number;pending:number}

interface FileIdentity {device:string;inode:string;birthtimeMs:string;linkCount:string}
interface ManifestProcess {pid:number;creationIdentity:string}
interface ManifestIntent {version:1;id:string;controller:ManifestProcess}
interface ManifestSnapshot {basename:string;identity:FileIdentity}
interface ManifestState {intent:ManifestIntent;snapshot?:ManifestSnapshot;children:ManifestProcess[];identity:FileIdentity}

interface CustodyError extends Error {code:string}
function custodyError(code:string,message:string):CustodyError{
 const error=new Error(message) as CustodyError;error.code=code;return error;
}
function canonical(path:string):string{return process.platform==='win32'?resolve(path).toLowerCase():resolve(path)}
function sameIdentity(left:FileIdentity,right:FileIdentity):boolean{
 return left.device===right.device&&left.inode===right.inode&&left.birthtimeMs===right.birthtimeMs&&left.linkCount===right.linkCount;
}
function fileIdentity(stat:{dev:number;ino:number;birthtimeMs:number;nlink:number}):FileIdentity{
 return {device:String(stat.dev),inode:String(stat.ino),birthtimeMs:String(stat.birthtimeMs),linkCount:String(stat.nlink)};
}
function assertProcess(value:NativeSnapshotProcess):ManifestProcess{
 if(!value||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.creationIdentity!=='string'||value.creationIdentity.length===0||value.creationIdentity.length>256){
  throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PROCESS_INVALID','native snapshot custody process identity is invalid');
 }
 return {pid:value.pid,creationIdentity:value.creationIdentity};
}
function assertAbsolute(value:string):void{
 if(typeof value!=='string'||!isAbsolute(value))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody paths must be absolute');
}
function ensureInsideHome(runtimeHome:string,directory:string):void{
 const remainder=relative(resolve(runtimeHome),resolve(directory));
 if(!remainder||isAbsolute(remainder)||remainder==='..'||remainder.startsWith(`..${sep}`))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_OUTSIDE_HOME','native snapshot custody storage must be inside runtime home');
}
async function safeDirectory(path:string):Promise<FileIdentity>{
 assertAbsolute(path);
 const target=resolve(path);
 let targetIdentity:FileIdentity|undefined;
 for(let current=target;;current=dirname(current)){
  let stat:Awaited<ReturnType<typeof lstat>>;
  try{stat=await lstat(current);}catch{throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody path is unavailable');}
  if(stat.isSymbolicLink())throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPARSE','native snapshot custody path contains a reparse point');
  let canonicalPath:string;
  try{canonicalPath=await realpath(current);}catch{throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody path is unavailable');}
  if(canonical(canonicalPath)!==canonical(current))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPARSE','native snapshot custody path contains a reparse point');
  if(current!==target&&!stat.isDirectory())throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody path contains a non-directory component');
  if(current===target){if(!stat.isDirectory())throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody directory is not a directory');targetIdentity=fileIdentity(stat);}
  if(dirname(current)===current)break;
 }
 if(targetIdentity===undefined)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody path is unavailable');
 return targetIdentity;
}
async function safeFile(path:string,requireSingleLink=true):Promise<{stat:Awaited<ReturnType<typeof lstat>>;identity:FileIdentity}>{
 assertAbsolute(path);
 const target=resolve(path);
 let targetStat:Awaited<ReturnType<typeof lstat>>|undefined;
 let targetIdentity:FileIdentity|undefined;
 for(let current=target;;current=dirname(current)){
  let stat:Awaited<ReturnType<typeof lstat>>;
  try{stat=await lstat(current);}catch(error){throw error;}
  if(stat.isSymbolicLink())throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPARSE','native snapshot custody file is a reparse point');
  if(current!==target&&!stat.isDirectory())throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody file parent is not a directory');
  if(current===target){
   if(!stat.isFile()||(requireSingleLink&&stat.nlink!==1))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_OWNERSHIP_MISMATCH','native snapshot custody file ownership could not be proven');
   let canonicalPath:string;
   try{canonicalPath=await realpath(current);}catch{throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody file is unavailable');}
   if(canonical(canonicalPath)!==canonical(current))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPARSE','native snapshot custody file is a reparse point');
   targetStat=stat;targetIdentity=fileIdentity(stat);
  }
  if(dirname(current)===current)break;
 }
 if(targetStat===undefined||targetIdentity===undefined)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody file is unavailable');
 return {stat:targetStat,identity:targetIdentity};
}
async function attest(options:NativeSnapshotStorage):Promise<void>{
 assertAbsolute(options.runtimeHome);assertAbsolute(options.directory);ensureInsideHome(options.runtimeHome,options.directory);
 await options.verifyStorage();await safeDirectory(options.runtimeHome);await safeDirectory(options.directory);
}
function ownKeys(value:Record<string,unknown>,keys:string[]):boolean{
 const actual=Object.keys(value).sort(),expected=[...keys].sort();return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
}
function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody metadata is invalid');
 return value as Record<string,unknown>;
}
function parseIdentity(value:unknown):FileIdentity{
 const object=record(value);
 if(!ownKeys(object,['device','inode','birthtimeMs','linkCount'])||Object.values(object).some(item=>typeof item!=='string'||item.length===0))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody file identity is invalid');
 return {device:object.device as string,inode:object.inode as string,birthtimeMs:object.birthtimeMs as string,linkCount:object.linkCount as string};
}
function parseProcess(value:unknown):ManifestProcess{
 const object=record(value);
 if(!ownKeys(object,['pid','creationIdentity']))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody process metadata is invalid');
 return assertProcess(object as unknown as NativeSnapshotProcess);
}
function parseManifest(text:string,identity:FileIdentity):ManifestState{
 const lines=text.split(/\r?\n/).filter(line=>line.length>0);
 if(lines.length===0||lines.length>MAX_CHILDREN+2)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest is invalid');
 let first:Record<string,unknown>;
 try{first=record(JSON.parse(lines[0]!));}catch{throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest is invalid');}
 if(!ownKeys(first,['version','id','controller'])||first.version!==1||typeof first.id!=='string'||!MANIFEST_NAME.test(`native-snapshot-custody-${first.id}.json`))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody intent is invalid');
 const state:ManifestState={intent:{version:1,id:first.id,controller:parseProcess(first.controller)},children:[],identity};
 for(const line of lines.slice(1)){
  let object:Record<string,unknown>;
  try{object=record(JSON.parse(line));}catch{throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody record is invalid');}
  if(object.type==='snapshot'){
   if(!ownKeys(object,['type','basename','identity'])||typeof object.basename!=='string'||!SNAPSHOT_NAME.test(object.basename)||state.snapshot!==undefined)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody snapshot record is invalid');
   state.snapshot={basename:object.basename,identity:parseIdentity(object.identity)};
  }else if(object.type==='child'){
   if(!ownKeys(object,['type','process']))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody child record is invalid');
   const child=parseProcess(object.process);
   if(state.children.some(existing=>existing.pid===child.pid&&existing.creationIdentity===child.creationIdentity))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody child is duplicated');
   state.children.push(child);
  }else throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody record is unknown');
 }
 return state;
}
async function readManifest(path:string,expectedIdentity?:FileIdentity):Promise<ManifestState>{
 const inspected=await safeFile(path);
 if(expectedIdentity!==undefined&&!sameIdentity(inspected.identity,expectedIdentity))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest was replaced');
 const size=inspected.stat.size;
 if(size>MAX_MANIFEST_BYTES)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest is too large');
 const handle=await open(path,'r');
 try{
  const opened=await handle.stat(),openedIdentity=fileIdentity(opened);
  if(!sameIdentity(openedIdentity,inspected.identity)||opened.size!==size)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest changed while opening');
  const buffer=Buffer.alloc(size);let offset=0;
  while(offset<size){const result=await handle.read(buffer,offset,size-offset,offset);if(result.bytesRead===0)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest was truncated');offset+=result.bytesRead;}
  const after=await handle.stat();
  if(!sameIdentity(fileIdentity(after),inspected.identity)||after.size!==size)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest changed while reading');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
  if(!text.endsWith('\n'))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest lacks a complete final record');
  const current=await safeFile(path);
  if(!sameIdentity(current.identity,inspected.identity)||current.stat.size!==size)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest was replaced');
  return parseManifest(text,inspected.identity);
 }catch(error){
  if((error as TypeError).name==='TypeError')throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest is not valid UTF-8');
  throw error;
 }finally{await handle.close();}
}
async function appendRecord(path:string,expected:FileIdentity,value:Record<string,unknown>):Promise<void>{
 const handle=await open(path,'a');
 try{
  const current=fileIdentity(await handle.stat());
  if(!sameIdentity(current,expected))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest was replaced');
  await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();
 }finally{await handle.close();}
}
function snapshotPath(directory:string,basename:string):string{
 if(!SNAPSHOT_NAME.test(basename))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody snapshot name is invalid');
 const path=join(directory,basename);
 if(canonical(dirname(path))!==canonical(directory))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody snapshot path is external');
 return path;
}
async function removeOwnedSnapshot(directory:string,snapshot:ManifestSnapshot):Promise<void>{
 const path=snapshotPath(directory,snapshot.basename);
 let owned:{stat:Awaited<ReturnType<typeof lstat>>;identity:FileIdentity};
 try{owned=await safeFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!sameIdentity(owned.identity,snapshot.identity))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_OWNERSHIP_MISMATCH','native snapshot custody file was replaced or linked');
 await unlink(path);
}
async function removeManifest(path:string,expected:FileIdentity):Promise<void>{
 let owned:{stat:Awaited<ReturnType<typeof lstat>>;identity:FileIdentity};
 try{owned=await safeFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!sameIdentity(owned.identity,expected))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest was replaced');
 await unlink(path);
}
async function requireExited(probe:(process:NativeSnapshotProcess)=>Promise<boolean>,process:NativeSnapshotProcess):Promise<void>{
 try{if(await probe(process)!==true)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PROCESS_NOT_EXITED','native snapshot custody process has not exited');}
 catch(error){if((error as CustodyError).code==='NATIVE_SNAPSHOT_CUSTODY_PROCESS_NOT_EXITED')throw error;throw custodyError('NATIVE_SNAPSHOT_CUSTODY_EXIT_UNKNOWN','native snapshot custody process exit is unknown');}
}
const lanes=new Map<string,Promise<unknown>>();
async function serial<T>(directory:string,work:()=>Promise<T>):Promise<T>{
 const key=canonical(directory),previous=lanes.get(key);const result=(previous??Promise.resolve()).catch(()=>undefined).then(work);lanes.set(key,result);
 try{return await result;}finally{if(lanes.get(key)===result)lanes.delete(key);}
}

export async function createNativeSnapshotCustody(options:NativeSnapshotCustodyOptions):Promise<NativeSnapshotCustody>{
 const controller=assertProcess(options.controller);
 await attest(options);
 const id=randomUUID(),path=join(options.directory,`native-snapshot-custody-${id}.json`);
 const handle=await open(path,'wx',0o600);
 try{await handle.writeFile(JSON.stringify({version:1,id,controller})+'\n');await handle.sync();}finally{await handle.close();}
 const manifest=await safeFile(path);let closePromise:Promise<void>|undefined;
 const beforeCopy=async(snapshot:string):Promise<void>=>serial(path,async()=>{
   await attest(options);const state=await readManifest(path,manifest.identity);
   if(state.snapshot!==undefined)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_ALREADY_REGISTERED','native snapshot custody already has a registered copy');
   assertAbsolute(snapshot);
   if(canonical(dirname(resolve(snapshot)))!==canonical(options.directory))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody snapshot path is external');
   const basename=resolve(snapshot).slice(resolve(snapshot).lastIndexOf(sep)+1);
   if(!SNAPSHOT_NAME.test(basename))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_PATH','native snapshot custody snapshot filename is invalid');
   const owned=await safeFile(resolve(snapshot));
   if(owned.stat.size!==0)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_NONEMPTY','native snapshot custody registration requires an empty file');
   await appendRecord(path,manifest.identity,{type:'snapshot',basename,identity:owned.identity});
 });
 const bindChild=async(child:NativeSnapshotProcess):Promise<void>=>serial(path,async()=>{
   const process=assertProcess(child);await attest(options);const state=await readManifest(path,manifest.identity);
   if(state.children.length>=MAX_CHILDREN)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_LIMIT','native snapshot custody child limit exceeded');
   if(state.children.some(existing=>existing.pid===process.pid&&existing.creationIdentity===process.creationIdentity))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody child is duplicated');
   await appendRecord(path,manifest.identity,{type:'child',process});
 });
  const close=():Promise<void>=>{
   if(closePromise!==undefined)return closePromise;
  closePromise=serial(path,async()=>{
    await attest(options);const state=await readManifest(path,manifest.identity);
    for(const child of state.children)await requireExited(options.isExited,child);
    const current=await safeFile(path);
    if(!sameIdentity(current.identity,manifest.identity))throw custodyError('NATIVE_SNAPSHOT_CUSTODY_REPLACED','native snapshot custody manifest was replaced');
    if(state.snapshot!==undefined)await removeOwnedSnapshot(options.directory,state.snapshot);
    await removeManifest(path,manifest.identity);
   }).catch(error=>{closePromise=undefined;throw error;});
   return closePromise;
  };
 return {manifestPath:path,beforeCopy,bindChild,close,cleanup:close};
}

export async function recoverNativeSnapshotCustody(options:NativeSnapshotRecoveryOptions):Promise<NativeSnapshotRecoveryResult>{
 await attest(options);
 const entries=await readdir(options.directory,{withFileTypes:true});
 const manifests=entries.map(entry=>entry.name).filter(name=>MANIFEST_NAME.test(name));
 if(manifests.length>4096)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_LIMIT','native snapshot custody manifest limit exceeded');
 const outcomes:NativeSnapshotRecoveryResult[]=[];
 for(const name of manifests){
  outcomes.push(await serial(join(options.directory,name),async()=>{
   const path=join(options.directory,name),state=await readManifest(path);
   if(name!==`native-snapshot-custody-${state.intent.id}.json`)throw custodyError('NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID','native snapshot custody manifest name does not match its intent');
   let controllerExited=false;
   try{controllerExited=await options.isExited(state.intent.controller)===true;}catch{controllerExited=false;}
   if(!controllerExited)return {cleaned:0,pending:1};
   let childrenExited=true;
   for(const child of state.children){try{if(await options.isExited(child)!==true)childrenExited=false;}catch{childrenExited=false;}}
   if(!childrenExited)return {cleaned:0,pending:1};
   await attest(options);
   if(state.snapshot!==undefined)await removeOwnedSnapshot(options.directory,state.snapshot);
   await removeManifest(path,state.identity);return {cleaned:1,pending:0};
  }));
 }
 return outcomes.reduce((total,current)=>({cleaned:total.cleaned+current.cleaned,pending:total.pending+current.pending}),{cleaned:0,pending:0});
}
