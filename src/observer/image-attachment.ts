import type {ConversationContentPart} from './conversation-record.js';
import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,resolve,parse,join,relative} from 'node:path';
import {readWindowsImage,WindowsImageReaderError} from './windows-image-reader.js';

type ImagePart=Exclude<ConversationContentPart,{type:'text'}>;
export type ResolvedImageAttachment={state:'missing'}|{state:'available';imageUrl:string;digest:string;encodedBytes:number};

type ImageCode='IMAGE_PATH_REJECTED'|'IMAGE_FORMAT_UNSUPPORTED'|'IMAGE_CAPACITY_EXCEEDED'|'IMAGE_READ_FAILED'|'IMAGE_SOURCE_CHANGED'|'IMAGE_CANCELLED';
export class ImageAttachmentError extends Error {
  constructor(readonly code:ImageCode){super(code);this.name='ImageAttachmentError';}
}
const fail=(code:ImageCode):never=>{throw new ImageAttachmentError(code);};
const check=(signal:AbortSignal):void=>{if(signal.aborted)fail('IMAGE_CANCELLED');};
function mime(bytes:Buffer):string {
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR')return 'image/png';
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return fail('IMAGE_FORMAT_UNSUPPORTED');
}
function available(bytes:Buffer,max:number,expectedMime?:string):ResolvedImageAttachment {
  const detected=mime(bytes);if(expectedMime!==undefined&&expectedMime!==detected)fail('IMAGE_FORMAT_UNSUPPORTED');
  const imageUrl=`data:${detected};base64,${bytes.toString('base64')}`;
  const encodedBytes=Buffer.byteLength(imageUrl);if(encodedBytes>max)fail('IMAGE_CAPACITY_EXCEEDED');
  return {state:'available',imageUrl,encodedBytes,digest:createHash('sha256').update(bytes).digest('hex')};
}
function safePath(value:string):string {
  if(!isAbsolute(value)||value.includes('\0')||/^[\\/]{2}/.test(value)||value.slice(2).includes(':'))fail('IMAGE_PATH_REJECTED');
  const normalized=resolve(value),root=parse(normalized).root;
  if(normalized===root)fail('IMAGE_PATH_REJECTED');
  for(const segment of relative(root,normalized).split(/[\\/]/)){
    if(/[. ]$/.test(segment)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))fail('IMAGE_PATH_REJECTED');
  }
  return normalized;
}
async function verifyPath(path:string,signal:AbortSignal){
  const root=parse(path).root;let cursor=root;
  for(const segment of relative(root,path).split(/[\\/]/)){
    check(signal);cursor=join(cursor,segment);
    const info=await lstat(cursor);if(info.isSymbolicLink())fail('IMAGE_PATH_REJECTED');
    if(cursor!==path&&!info.isDirectory())fail('IMAGE_PATH_REJECTED');
  }
  const actual=await realpath(path);
  if(relative(path,actual)!=='')fail('IMAGE_PATH_REJECTED');
}
export async function resolveImageAttachment(part:ImagePart,options:{signal:AbortSignal;maxEncodedBytes:number}):Promise<ResolvedImageAttachment>{
  const {signal,maxEncodedBytes}=options;check(signal);
  if(!Number.isSafeInteger(maxEncodedBytes)||maxEncodedBytes<=0)fail('IMAGE_CAPACITY_EXCEEDED');
  if(part.type==='input_image'){
    check(signal);
    if(Buffer.byteLength(part.imageUrl)>maxEncodedBytes)fail('IMAGE_CAPACITY_EXCEEDED');
    const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.imageUrl);
    if(!match)return fail('IMAGE_FORMAT_UNSUPPORTED');
    const bytes=Buffer.from(match[2]!,'base64');
    if(bytes.toString('base64')!==match[2])fail('IMAGE_FORMAT_UNSUPPORTED');
    return available(bytes,maxEncodedBytes,match[1]);
  }
  const path=safePath(part.path);
  if(process.platform==='win32'){
    try{
      const bytes=await readWindowsImage(path,{signal,maxEncodedBytes});
      if(bytes===null)return {state:'missing'};
      check(signal);return available(bytes,maxEncodedBytes);
    }catch(error){
      if(error instanceof ImageAttachmentError)throw error;
      if(error instanceof WindowsImageReaderError){
        if(error.code==='CANCELLED')fail('IMAGE_CANCELLED');
        if(error.code==='REPARSE'||error.code==='NOT_REGULAR')fail('IMAGE_PATH_REJECTED');
        if(error.code==='CAPACITY')fail('IMAGE_CAPACITY_EXCEEDED');
        fail('IMAGE_READ_FAILED');
      }
      check(signal);throw new ImageAttachmentError('IMAGE_READ_FAILED');
    }
  }
  let reading=false;
  try {
    await verifyPath(path,signal);
    const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink())fail('IMAGE_PATH_REJECTED');
    if(4*Math.ceil(before.size/3)+23>maxEncodedBytes)fail('IMAGE_CAPACITY_EXCEEDED');
    reading=true;
    const handle=await open(path,'r');
    try {
      const opened=await handle.stat();
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)fail('IMAGE_SOURCE_CHANGED');
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){
        check(signal);const read=await handle.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);
        if(read.bytesRead===0)fail('IMAGE_SOURCE_CHANGED');offset+=read.bytesRead;
      }
      check(signal);await verifyPath(path,signal);
      const after=await handle.stat(),named=await lstat(path);
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||named.ino!==before.ino||named.dev!==before.dev)fail('IMAGE_SOURCE_CHANGED');
      return available(bytes,maxEncodedBytes);
    } finally {await handle.close();}
  } catch(error){
    check(signal);
    if(error instanceof ImageAttachmentError)throw error;
    if(!reading&&(error as NodeJS.ErrnoException)?.code==='ENOENT')return {state:'missing'};
    throw new ImageAttachmentError('IMAGE_READ_FAILED');
  }
}
