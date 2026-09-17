import {lstat,realpath} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';

interface StatIdentity {
  dev:string;
  ino:string;
  mode:string;
  nlink:string;
  size:string;
  mtimeNs:string;
  ctimeNs:string;
  birthtimeNs:string;
}

interface DirectoryIdentity {
  dev:string;
  ino:string;
  mode:string;
  birthtimeNs:string;
}

interface FileIdentity {
  present:boolean;
  stat:StatIdentity|null;
}

interface IdentitySnapshot {
  home:string;
  homeStat:DirectoryIdentity;
  auth:FileIdentity;
  config:FileIdentity;
}

const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);

function statIdentity(value:BigIntStats):StatIdentity {
  const fields=[value.dev,value.ino,value.mode,value.nlink,value.size,value.mtimeNs,value.ctimeNs,value.birthtimeNs];
  if(fields.some(field=>typeof field!=='bigint'))throw Error('IDENTITY_METADATA_UNAVAILABLE');
  // A zero inode cannot distinguish replacement from reuse on platforms that
  // do not provide file identity, so fail closed instead of weakening proof.
  if(value.ino<=0n||value.nlink<1n)throw Error('IDENTITY_METADATA_UNAVAILABLE');
  return {dev:value.dev.toString(),ino:value.ino.toString(),mode:value.mode.toString(),nlink:value.nlink.toString(),size:value.size.toString(),
    mtimeNs:value.mtimeNs.toString(),ctimeNs:value.ctimeNs.toString(),birthtimeNs:value.birthtimeNs.toString()};
}

function directoryIdentity(value:BigIntStats):DirectoryIdentity {
  const fields=[value.dev,value.ino,value.mode,value.birthtimeNs];
  if(fields.some(field=>typeof field!=='bigint')||value.ino<=0n)throw Error('IDENTITY_METADATA_UNAVAILABLE');
  return {dev:value.dev.toString(),ino:value.ino.toString(),mode:value.mode.toString(),birthtimeNs:value.birthtimeNs.toString()};
}

async function readFileIdentity(path:string,required:boolean):Promise<FileIdentity> {
  try {
    const value=await lstat(path,{bigint:true});
    if(value.isSymbolicLink()||!value.isFile()||value.nlink!==1n)throw Error('IDENTITY_METADATA_UNAVAILABLE');
    return {present:true,stat:statIdentity(value)};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT'&&!required)return {present:false,stat:null};
    throw error;
  }
}

async function readSnapshot(authHome:string):Promise<IdentitySnapshot> {
  if(!isAbsolute(authHome)||/\x00/.test(authHome))throw Error('IDENTITY_METADATA_UNAVAILABLE');
  const inputHome=await lstat(authHome,{bigint:true});
  if(inputHome.isSymbolicLink()||!inputHome.isDirectory())throw Error('IDENTITY_METADATA_UNAVAILABLE');
  const home=canonical(await realpath(authHome));
  if(home!==canonical(authHome))throw Error('IDENTITY_METADATA_UNAVAILABLE');
  const homeValue=await lstat(home,{bigint:true});
  if(homeValue.isSymbolicLink()||!homeValue.isDirectory())throw Error('IDENTITY_METADATA_UNAVAILABLE');
  const auth=await readFileIdentity(join(home,'auth.json'),true);
  if(!auth.present||!auth.stat)throw Error('IDENTITY_METADATA_UNAVAILABLE');
  const config=await readFileIdentity(join(home,'config.toml'),false);
  return {home,homeStat:directoryIdentity(homeValue),auth,config};
}

/** Captures only independent auth-home metadata; credential contents are never read. */
export async function captureObserverIdentityFiles(authHome:string):Promise<string|null> {
  try {
    const before=await readSnapshot(authHome);
    // Re-resolve and re-stat after every metadata lookup so a replacement or
    // directory race cannot become an apparently stable reuse record.
    const after=await readSnapshot(authHome);
    if(JSON.stringify(before)!==JSON.stringify(after))return null;
    return JSON.stringify(after);
  } catch {
    return null;
  }
}
