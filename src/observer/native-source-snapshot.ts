import {createHash,randomUUID,type Hash} from "node:crypto";
import * as fs from "node:fs/promises";
import {dirname,isAbsolute,relative,resolve} from "node:path";

const COPY_CHUNK_BYTES=64*1024;
const METADATA_LINE_MAX_BYTES=1024*1024;

export interface NativeSourceSnapshot {
  kind:"native";
  sourceThreadId:string;
  /** Present only when supplied by the trusted incremental source reader. */
  sourceTurnId?:string;
  sourceEpoch:number;
  revision:number;
  byteLength:number;
  path:string;
  close():Promise<void>;
}

export interface NativeSourceSnapshotOptions {
  /** Trial envelope pin only, not a semantic completeness certificate. */
  sourceProfile?:'codex-01534-legacy';
  /** Previously observed complete-record boundary, not current file EOF. */
  byteWatermark?:number;
  sourcePath:string;
  sourceRoot:string;
  sourceThreadId:string;
  sourceEpoch:number;
  revision:number;
  destinationDirectory:string;
  maxSourceBytes:number;
  signal:AbortSignal;
  verifyDestination:()=>Promise<void>;
  beforeCopy?:(path:string)=>Promise<void>;
  copySettled?:()=>void;
}

interface SnapshotError extends Error {
  code:string;
}

interface FileIdentity {
  device:string;
  inode:string;
  birthtimeMs:string;
  linkCount:string;
}

function snapshotError(code:string,message:string):SnapshotError{
  const error=new Error(message) as SnapshotError;
  error.code=code;
  return error;
}

function checkCancelled(signal:AbortSignal):void{
  if(signal.aborted) throw snapshotError("source_cancelled","native source snapshot cancelled");
}

function isRecord(value:unknown):value is Record<string,unknown>{
  return typeof value==="object"&&value!==null;
}

function identityOf(stat:Awaited<ReturnType<fs.FileHandle["stat"]>>):FileIdentity{
  return {device:String(stat.dev),inode:String(stat.ino),birthtimeMs:String(stat.birthtimeMs),linkCount:String(stat.nlink)};
}

function sameIdentity(left:FileIdentity,right:FileIdentity):boolean{
  return left.device===right.device&&left.inode===right.inode&&left.birthtimeMs===right.birthtimeMs;
}

function normalizedPath(value:string):string{
  const path=resolve(value);
  return process.platform==="win32"?path.toLowerCase():path;
}

function samePath(left:string,right:string):boolean{
  return normalizedPath(left)===normalizedPath(right);
}

function pathChain(target:string):string[]{
  const chain:string[]=[];
  let current=resolve(target);
  while(true){
    chain.push(current);
    const parent=dirname(current);
    if(parent===current) return chain.reverse();
    current=parent;
  }
}

async function safePathChain(target:string,role:"source"|"destination",directory:boolean):Promise<void>{
  for(const entry of pathChain(target)){
    let stat:Awaited<ReturnType<typeof fs.lstat>>;
    try{stat=await fs.lstat(entry);}catch(error){
      const code=entry===target?`${role}_missing`:`${role}_path_unavailable`;
      throw snapshotError(code,`native snapshot ${role} path is unavailable: ${entry}`);
    }
    if(stat.isSymbolicLink()) throw snapshotError(`${role}_reparse`,`native snapshot ${role} path contains a reparse point`);
    if(entry!==target&&!stat.isDirectory()) throw snapshotError(`${role}_path_invalid`,`native snapshot ${role} path contains a non-directory component`);
  }
  const finalStat=await fs.lstat(target);
  if(directory&&!finalStat.isDirectory()) throw snapshotError("destination_path_invalid","native snapshot destination is not a directory");
  if(!directory&&!finalStat.isFile()) throw snapshotError("source_path_invalid","native snapshot source is not a regular file");
  let canonical:string;
  try{canonical=await fs.realpath(target);}catch(error){
    throw snapshotError(`${role}_missing`,`native snapshot ${role} path is unavailable: ${target}`);
  }
  if(!samePath(canonical,target)) throw snapshotError(`${role}_reparse`,`native snapshot ${role} path contains a reparse point`);
}

function ensureSourceContained(sourceRoot:string,sourcePath:string):void{
  const root=resolve(sourceRoot);
  const source=resolve(sourcePath);
  const remainder=relative(root,source);
  if(remainder===""||remainder.startsWith("..")||isAbsolute(remainder)){
    throw snapshotError("source_out_of_root","native snapshot source is outside the trusted source root");
  }
}

async function readMetadataLine(handle:fs.FileHandle,sourceThreadId:string,profile:NativeSourceSnapshotOptions['sourceProfile']):Promise<void>{
  const buffer=Buffer.alloc(METADATA_LINE_MAX_BYTES+1);
  let filled=0;
  let newline=-1;
  while(filled<buffer.length){
    const result=await handle.read(buffer,filled,buffer.length-filled,filled);
    if(result.bytesRead===0) break;
    newline=buffer.indexOf(0x0a,filled,filled+result.bytesRead);
    filled+=result.bytesRead;
    if(newline>=0) break;
  }
  if(newline<0){
    if(filled>=buffer.length) throw snapshotError("source_metadata_oversize","native snapshot source metadata line exceeds 1MiB");
    throw snapshotError("source_metadata_invalid","native snapshot source has no complete metadata line");
  }
  if(newline>METADATA_LINE_MAX_BYTES) throw snapshotError("source_metadata_oversize","native snapshot source metadata line exceeds 1MiB");
  let metadata:unknown;
  try{metadata=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,newline)));}
  catch{throw snapshotError("source_metadata_invalid","native snapshot source metadata is not valid UTF-8 JSON");}
  if(!isRecord(metadata)||metadata.type!=="session_meta"||!isRecord(metadata.payload)||metadata.payload.id!==sourceThreadId){
    throw snapshotError("source_identity_mismatch","native snapshot source metadata does not match the trusted thread");
  }
  if(profile!==undefined&&(profile!=='codex-01534-legacy'||metadata.payload.cli_version!=='0.153.4'||
    (metadata.payload.history_mode!==undefined&&metadata.payload.history_mode!=='legacy'))){
    throw snapshotError('source_profile_unsupported','native source runtime/history envelope is not verified for this trial');
  }
}

async function lastCompleteByteLength(handle:fs.FileHandle,size:number,signal:AbortSignal):Promise<number>{
  let end=size;
  while(end>0){
    checkCancelled(signal);
    const start=Math.max(0,end-COPY_CHUNK_BYTES);
    const buffer=Buffer.allocUnsafe(end-start);
    const result=await handle.read(buffer,0,buffer.length,start);
    if(result.bytesRead===0) throw snapshotError("source_truncated","native snapshot source ended while finding its fixed watermark");
    const newline=buffer.lastIndexOf(0x0a,result.bytesRead-1);
    if(newline>=0) return start+newline+1;
    end=start;
  }
  throw snapshotError("source_metadata_invalid","native snapshot source has no complete line");
}

async function copyPrefix(source:fs.FileHandle,destination:fs.FileHandle,length:number,signal:AbortSignal):Promise<Hash>{
  const hash=createHash("sha256");
  const buffer=Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES,Math.max(length,1)));
  let offset=0;
  while(offset<length){
    checkCancelled(signal);
    const requested=Math.min(buffer.length,length-offset);
    const result=await source.read(buffer,0,requested,offset);
    if(result.bytesRead===0) throw snapshotError("source_truncated","native snapshot source ended during copy");
    const chunk=buffer.subarray(0,result.bytesRead);
    hash.update(chunk);
    let written=0;
    while(written<chunk.length){
      const writeResult=await destination.write(chunk,written,chunk.length-written,offset+written);
      if(writeResult.bytesWritten===0) throw new Error("native snapshot destination made no write progress");
      written+=writeResult.bytesWritten;
    }
    offset+=result.bytesRead;
  }
  return hash;
}

async function hashPrefix(source:fs.FileHandle,length:number,signal:AbortSignal):Promise<string>{
  const hash=createHash("sha256");
  const buffer=Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES,Math.max(length,1)));
  let offset=0;
  while(offset<length){
    checkCancelled(signal);
    const requested=Math.min(buffer.length,length-offset);
    const result=await source.read(buffer,0,requested,offset);
    if(result.bytesRead===0) throw snapshotError("source_truncated","native snapshot source ended while verifying its fixed watermark");
    hash.update(buffer.subarray(0,result.bytesRead));
    offset+=result.bytesRead;
  }
  return hash.digest("hex");
}

async function ownedSnapshotStat(path:string,identity:FileIdentity):Promise<Awaited<ReturnType<typeof fs.lstat>>>{
  let stat:Awaited<ReturnType<typeof fs.lstat>>;
  try{stat=await fs.lstat(path);}catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT") throw snapshotError("snapshot_missing","native snapshot file is already absent");
    throw error;
  }
  if(stat.isSymbolicLink()||!stat.isFile()||!sameIdentity(identity,identityOf(stat))||String(stat.nlink)!==identity.linkCount){
    throw snapshotError("snapshot_ownership_mismatch","native snapshot file was replaced or ownership could not be proven");
  }
  return stat;
}

async function disposeOwnedFile(path:string,identity:FileIdentity,destinationDirectory:string,verifyDestination:()=>Promise<void>):Promise<void>{
  await verifyDestination();
  await safePathChain(destinationDirectory,"destination",true);
  try{
    await ownedSnapshotStat(path,identity);
  }catch(error){
    if((error as SnapshotError).code==="snapshot_missing"){
      await verifyDestination();
      return;
    }
    throw error;
  }
  await fs.unlink(path);
  await verifyDestination();
}

async function cleanupOwnedFile(path:string|undefined,identity:FileIdentity|undefined,destinationDirectory:string,verifyDestination:()=>Promise<void>):Promise<void>{
  if(path===undefined||identity===undefined) return;
  try{
    await verifyDestination();
    await safePathChain(destinationDirectory,"destination",true);
    await ownedSnapshotStat(path,identity);
    await fs.unlink(path);
    await verifyDestination();
  }catch{
    // Cleanup is deliberately best-effort and never removes an unproven path.
  }
}

export async function createNativeSourceSnapshot(options:NativeSourceSnapshotOptions):Promise<NativeSourceSnapshot>{
  const sourcePath=resolve(options.sourcePath);
  const sourceRoot=resolve(options.sourceRoot);
  const destinationDirectory=resolve(options.destinationDirectory);
  if(!isAbsolute(options.sourcePath)||!isAbsolute(options.sourceRoot)||!isAbsolute(options.destinationDirectory)){
    throw snapshotError("invalid_options","native snapshot paths must be absolute");
  }
  if(!Number.isSafeInteger(options.maxSourceBytes)||options.maxSourceBytes<=0){
    throw snapshotError("invalid_options","native snapshot size bound must be a positive safe integer");
  }
  if(options.sourceThreadId.length===0||!Number.isSafeInteger(options.sourceEpoch)||!Number.isSafeInteger(options.revision)){
    throw snapshotError("invalid_options","native snapshot identity is invalid");
  }
  checkCancelled(options.signal);
  ensureSourceContained(sourceRoot,sourcePath);
  await safePathChain(sourceRoot,"source",true);
  await safePathChain(sourcePath,"source",false);
  await safePathChain(destinationDirectory,"destination",true);

  let source:fs.FileHandle|undefined;
  let destination:fs.FileHandle|undefined;
  let snapshotPath:string|undefined;
  let snapshotIdentity:FileIdentity|undefined;
  try{
    source=await fs.open(sourcePath,"r");
    const initial=await source.stat();
    if(!initial.isFile()) throw snapshotError("source_path_invalid","native snapshot source is not a regular file");
    if(initial.size>options.maxSourceBytes) throw snapshotError("source_over_limit","native snapshot source exceeds its supported size bound");
    const initialIdentity=identityOf(initial);
    await readMetadataLine(source,options.sourceThreadId,options.sourceProfile);
    const watermark=options.byteWatermark??initial.size;
    if(!Number.isSafeInteger(watermark)||watermark<1||watermark>initial.size)throw snapshotError('source_watermark_invalid','native source watermark is invalid');
    const byteLength=await lastCompleteByteLength(source,watermark,options.signal);
    if(options.byteWatermark!==undefined&&byteLength!==watermark)throw snapshotError('source_watermark_invalid','native source watermark is not a complete record boundary');
    if(byteLength>options.maxSourceBytes) throw snapshotError("source_over_limit","native snapshot fixed watermark exceeds its supported size bound");
    checkCancelled(options.signal);

    await options.verifyDestination();
    checkCancelled(options.signal);
    await safePathChain(destinationDirectory,"destination",true);
    snapshotPath=resolve(destinationDirectory,`.native-source-${randomUUID()}.tmp`);
    destination=await fs.open(snapshotPath,"wx",0o600);
    snapshotIdentity=identityOf(await destination.stat());
    await options.beforeCopy?.(snapshotPath);
    const copiedHash=await copyPrefix(source,destination,byteLength,options.signal);
    await destination.sync();
    await options.verifyDestination();
    checkCancelled(options.signal);
    const sourceHash=await hashPrefix(source,byteLength,options.signal);
    if(copiedHash.digest("hex")!==sourceHash) throw snapshotError("source_content_changed","native snapshot source changed within its copied prefix");
    const afterHandle=await source.stat();
    if(!sameIdentity(initialIdentity,identityOf(afterHandle))) throw snapshotError("source_identity_mismatch","native snapshot source identity changed during copy");
    if(afterHandle.size<initial.size) throw snapshotError("source_truncated","native snapshot source was truncated during copy");
    await safePathChain(sourcePath,"source",false);
    let currentPath:fs.FileHandle|undefined;
    try{
      currentPath=await fs.open(sourcePath,"r");
      const current=await currentPath.stat();
      if(!sameIdentity(initialIdentity,identityOf(current))||current.size<initial.size){
        throw snapshotError("source_identity_mismatch","native snapshot source path changed during copy");
      }
    }finally{await currentPath?.close();}
    await destination.close();
    destination=undefined;
    let closePromise:Promise<void>|undefined;
    const close=():Promise<void>=>{
      if(closePromise!==undefined) return closePromise;
      closePromise=(async()=>{
        try{await disposeOwnedFile(snapshotPath!,snapshotIdentity!,destinationDirectory,options.verifyDestination);}
        catch(error){closePromise=undefined;throw error;}
      })();
      return closePromise;
    };
    return {kind:"native",sourceThreadId:options.sourceThreadId,sourceEpoch:options.sourceEpoch,revision:options.revision,byteLength,path:snapshotPath,close};
  }catch(error){
    await destination?.close().catch(()=>{});
    destination=undefined;
    await cleanupOwnedFile(snapshotPath,snapshotIdentity,destinationDirectory,options.verifyDestination);
    throw error;
  }finally{
    await source?.close().catch(()=>{});
    options.copySettled?.();
  }
}
