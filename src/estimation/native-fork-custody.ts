import {randomUUID} from 'node:crypto';
import {lstat,open,readdir,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import type {SessionRpc} from './observer-persistent-session.js';

const processSchema=z.object({pid:z.number().int().positive().safe(),creationIdentity:z.string().min(1).max(256)}).strict();
const intentSchema=z.object({version:z.literal(1),id:z.string().uuid(),sourceThreadId:z.string().min(1).max(256),rootSourceThreadId:z.string().min(1).max(256).optional(),process:processSchema}).strict();
type Intent=z.infer<typeof intentSchema>;
interface Storage {directory:string;runtimeHome:string;verifyStorage:()=>Promise<void>}
interface Recovery extends Storage {
 rpc:SessionRpc;
 /** Trusted process-identity probe. False/throw means do not touch resources. */
 isExited:(process:Intent['process'])=>Promise<boolean>;
}
const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const identity=(stat:{dev:number;ino:number;birthtimeMs:number})=>`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const rootFlights=new Map<string,Promise<unknown>>();
async function serial<T>(directory:string,work:()=>Promise<T>):Promise<T>{
 const key=canonical(directory),previous=rootFlights.get(key);
 const result=(previous??Promise.resolve()).catch(()=>undefined).then(work);rootFlights.set(key,result);
 try{return await result;}finally{if(rootFlights.get(key)===result)rootFlights.delete(key);}
}
async function safePath(path:string,directory:boolean){
 if(!isAbsolute(path))throw Error('NATIVE_CUSTODY_PATH');
 for(let current=resolve(path);;current=dirname(current)){
  const stat=await lstat(current);
  if(stat.isSymbolicLink()||canonical(await realpath(current))!==canonical(current))throw Error('NATIVE_CUSTODY_REPARSE');
  if(current!==resolve(path)&&!stat.isDirectory())throw Error('NATIVE_CUSTODY_PATH');
  if(dirname(current)===current)break;
 }
 const stat=await lstat(path);
 if(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)throw Error('NATIVE_CUSTODY_PATH');
 return stat;
}
async function attest(options:Storage){
 const rel=relative(resolve(options.runtimeHome),resolve(options.directory));
 if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('NATIVE_CUSTODY_OUTSIDE_HOME');
 await options.verifyStorage();await safePath(options.runtimeHome,true);await safePath(options.directory,true);
}
async function firstLine(path:string,maxBytes:number):Promise<{text:string;identity:string}>{
 const before=await safePath(path,false),handle=await open(path,'r');
 try{
  if(identity(await handle.stat())!==identity(before))throw Error('NATIVE_CUSTODY_REPLACED');
  const buffer=Buffer.alloc(Math.min(before.size,maxBytes));let used=0,newline=-1;
  while(used<buffer.length){const read=await handle.read(buffer,used,buffer.length-used,used);if(read.bytesRead===0)break;used+=read.bytesRead;newline=buffer.subarray(0,used).indexOf(10);if(newline>=0)break;}
  if(newline<0)throw Error('NATIVE_CUSTODY_METADATA_INVALID');
  if(identity(await safePath(path,false))!==identity(before))throw Error('NATIVE_CUSTODY_REPLACED');
  return {text:buffer.subarray(0,newline).toString('utf8'),identity:identity(before)};
 }finally{await handle.close();}
}

/** Durable intent precedes fork RPC. Its random tag is also persisted by the
 * pinned runtime in session_meta.thread_source, covering a lost RPC reply.
 * This is local custody metadata, not an inference/accounting reservation. */
export async function createNativeForkCustody(options:Storage&{sourceThreadId:string;rootSourceThreadId?:string;process:Intent['process']}){
 return serial(options.directory,async()=>{
  await attest(options);
  const intent=intentSchema.parse({version:1,id:randomUUID(),sourceThreadId:options.sourceThreadId,...(options.rootSourceThreadId===undefined?{}:{rootSourceThreadId:options.rootSourceThreadId}),process:options.process});
  const path=join(options.directory,`custody-${intent.id}.jsonl`),handle=await open(path,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(intent)+'\n');await handle.sync();}finally{await handle.close();}
  const fileIdentity=identity(await safePath(path,false));
  return {tag:`hud_native_${intent.id}`,manifestPath:path,
   async isRetired(){
    return serial(options.directory,async()=>{
     await attest(options);
     try{if(identity(await safePath(path,false))!==fileIdentity)throw Error('NATIVE_CUSTODY_REPLACED');return false;}
     catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}
    });
   },
   async recordFork(threadId:string){
    if(typeof threadId!=='string'||!threadId||threadId.length>256||threadId===intent.sourceThreadId||threadId===intent.rootSourceThreadId)throw Error('NATIVE_CUSTODY_SOURCE_COLLISION');
    await serial(options.directory,async()=>{
     await attest(options);
     if(identity(await safePath(path,false))!==fileIdentity)throw Error('NATIVE_CUSTODY_REPLACED');
     const file=await open(path,'a');try{
      if(identity(await file.stat())!==fileIdentity)throw Error('NATIVE_CUSTODY_REPLACED');
      await file.writeFile(JSON.stringify({forkId:threadId})+'\n');await file.sync();
     }finally{await file.close();}
    });
   }
  };
 });
}

async function rolloutFiles(runtimeHome:string):Promise<string[]>{
 const found:string[]=[];let visited=0;
 const walk=async(path:string,depth:number):Promise<void>=>{
  if(depth>8)throw Error('NATIVE_CUSTODY_SCAN_LIMIT');
  await safePath(path,true);
  for(const entry of await readdir(path,{withFileTypes:true})){
   if(++visited>50000)throw Error('NATIVE_CUSTODY_SCAN_LIMIT');
   const child=join(path,entry.name);
   if(entry.isSymbolicLink())throw Error('NATIVE_CUSTODY_REPARSE');
   if(entry.isDirectory())await walk(child,depth+1);
   else if(entry.isFile()&&entry.name.endsWith('.jsonl'))found.push(child);
  }
 };
 for(const name of ['sessions','archived_sessions']){
  const path=join(runtimeHome,name);
  try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  await walk(path,0);
 }
 return found;
}

/** Caller uses a freshly attested independent runtime for deletion, never the
 * main app server. Original owner must be confirmed exited by PID AND birth.
 * Only tagged files are candidates; no recursive filesystem deletion occurs.
 * Concurrent calls within the HUD join a local storage lane, not a model lock. */
export async function recoverNativeForkCustody(options:Recovery):Promise<{cleaned:number;pending:number}>{
 return serial(options.directory,async()=>{
  await attest(options);let cleaned=0,pending=0;
  const entries=(await readdir(options.directory)).filter(name=>/^custody-[a-f0-9-]{36}\.jsonl$/.test(name));
  if(entries.length>4096)throw Error('NATIVE_CUSTODY_SCAN_LIMIT');
  const eligible=new Map<string,{manifest:string;first:Awaited<ReturnType<typeof firstLine>>;intent:Intent}>();
  for(const name of entries){
   const manifest=join(options.directory,name),first=await firstLine(manifest,4096);
   const intent=intentSchema.parse(JSON.parse(first.text));
   if(name!==`custody-${intent.id}.jsonl`)throw Error('NATIVE_CUSTODY_METADATA_INVALID');
   if(!await options.isExited(intent.process).catch(()=>false)){pending++;continue;}
   eligible.set(`hud_native_${intent.id}`,{manifest,first,intent});
  }
  // Only owners already confirmed exited may use this per-recovery snapshot.
  // Never retain it across recoveries or scan once per custody manifest.
  const candidates=new Map<string,Array<{path:string;head:Awaited<ReturnType<typeof firstLine>>;id:string}>>();
  if(eligible.size>0)for(const path of await rolloutFiles(options.runtimeHome)){
    let head:Awaited<ReturnType<typeof firstLine>>;
    try{head=await firstLine(path,1024*1024);}catch(error){
     if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;
    }
    const metadata:unknown=JSON.parse(head.text);
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('NATIVE_CUSTODY_METADATA_INVALID');
    const record=metadata as {type?:unknown;payload?:{id?:unknown;thread_source?:unknown}};
    if(record.type!=='session_meta'||!record.payload)throw Error('NATIVE_CUSTODY_METADATA_INVALID');
    const tag=record.payload.thread_source;
    if(typeof tag!=='string')continue;
    const owner=eligible.get(tag);if(!owner)continue;
    const {intent}=owner;
    const id=record.payload.id;
    if(typeof id!=='string'||!id||id===intent.sourceThreadId||id===intent.rootSourceThreadId)throw Error('NATIVE_CUSTODY_SOURCE_COLLISION');
    const group=candidates.get(tag)??[];group.push({path,head,id});candidates.set(tag,group);
  }
  const deleted=new Set<string>();
  for(const [tag,{manifest,first,intent}] of eligible){
   for(const {path,head,id} of candidates.get(tag)??[]){
    await attest(options);
    const currentManifest=await firstLine(manifest,4096);
    if(currentManifest.identity!==first.identity||currentManifest.text!==first.text)throw Error('NATIVE_CUSTODY_REPLACED');
    if(!await options.isExited(intent.process).catch(()=>false))throw Error('NATIVE_OWNER_EXIT_UNCONFIRMED');
    let current:Awaited<ReturnType<typeof firstLine>>;
    try{current=await firstLine(path,1024*1024);}catch(error){
     // Only a confirmed deletion of this owned child's direct parent explains
     // absence. Moves/archives without that acknowledgement retain custody.
     if((error as NodeJS.ErrnoException).code==='ENOENT'&&deleted.has(intent.sourceThreadId))continue;throw error;
    }
    if(current.identity!==head.identity||current.text!==head.text)throw Error('NATIVE_CUSTODY_REPLACED');
    const ack=await options.rpc.call('thread/delete',{threadId:id});
    if(!ack||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).length!==0)throw Error('NATIVE_CUSTODY_DELETE_UNCONFIRMED');
    try{await lstat(path);throw Error('NATIVE_CUSTODY_DELETE_UNCONFIRMED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    deleted.add(id);
   }
   await attest(options);
   const currentManifest=await firstLine(manifest,4096);
   if(currentManifest.identity!==first.identity||currentManifest.text!==first.text)throw Error('NATIVE_CUSTODY_REPLACED');
   if(!await options.isExited(intent.process).catch(()=>false))throw Error('NATIVE_OWNER_EXIT_UNCONFIRMED');
   await unlink(manifest);cleaned++;
  }
  return {cleaned,pending};
 });
}
