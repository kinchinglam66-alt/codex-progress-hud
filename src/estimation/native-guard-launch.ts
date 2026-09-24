import {createHash} from 'node:crypto';
import {lstat,open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createNativeStorage} from './native-storage.js';
import {createObserverHomeValidation} from './observer-home-validation.js';
import {resolveTrustedPowerShellPath} from './recovery-boot-boundary.js';
import type {Invocation} from './owned-process.js';
import {nativePowerShellEnvironment} from './native-powershell-environment.js';
export const NATIVE_GUARD_SCRIPT_SHA256='17f7a0e9987c427e89b424f462319f482f815ce77c6961eaf5ea3edc99dd2ad5';
/** Execute the exact hash-verified bytes, never reopen the source pathname in PowerShell. */
export async function prepareNativeGuardInvocation(runtimeHome:string,scriptPath:string):Promise<Omit<Invocation,'input'>>{
 createNativeStorage(runtimeHome);
 const home=resolve(runtimeHome),parentDirectory=dirname(home),powershell=resolveTrustedPowerShellPath();
 await createObserverHomeValidation({parentDirectory,powershell,scriptPath,scriptSha256:NATIVE_GUARD_SCRIPT_SHA256}).assets();
 const before=await lstat(scriptPath),handle=await open(scriptPath,'r');
 let script:string;
 try{
  const opened=await handle.stat();
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!opened.isFile()||opened.nlink!==1||
   before.dev!==opened.dev||before.ino!==opened.ino||opened.size>65536)throw Error('NATIVE_GUARD_ASSET_INVALID');
  const buffer=Buffer.alloc(65537),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();
  const bytes=buffer.subarray(0,bytesRead);
  if(bytesRead!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.nlink!==1||
   createHash('sha256').update(bytes).digest('hex')!==NATIVE_GUARD_SCRIPT_SHA256)throw Error('NATIVE_GUARD_ASSET_INVALID');
  script=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 }finally{await handle.close();}
 const command=`& {\n${script}\n} -RuntimeHome ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home,'utf8').toString('base64')}')))`,encoded=Buffer.from(command,'utf16le').toString('base64');
 if(encoded.length>30000)throw Error('NATIVE_GUARD_COMMAND_LIMIT');
 const env=nativePowerShellEnvironment();
 return {executable:powershell,cwd:parentDirectory,env,args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded]};
}
