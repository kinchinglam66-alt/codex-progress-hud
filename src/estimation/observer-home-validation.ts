import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {resolveObserverAuthHome} from './codex-invocation.js';
import type {ObserverHomeProfile} from './observer-home.js';

/** Shared one-shot/resident guards; every call reads fresh metadata and bytes. */
export function createObserverHomeValidation(profile:ObserverHomeProfile) {
  const config=Object.freeze({...profile}),hostEnvironment={...process.env},defaultHome=homedir();
  const authHome=join(config.parentDirectory,'observer-auth');
  const fail=()=>Error('OBSERVER_HOME_UNAVAILABLE');
  const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
  return {authHome,
    async assets() {
      if(process.platform!=='win32'||!/^[a-f0-9]{64}$/.test(config.scriptSha256))throw fail();
      resolveObserverAuthHome(hostEnvironment,authHome);resolveObserverAuthHome({HOME:defaultHome},authHome);
      for(const path of [config.parentDirectory,config.powershell,config.scriptPath]) {
        if(typeof path!=='string'||!isAbsolute(path)||!/^[a-z]:[\\/]/i.test(path)||/[\x00-\x1f\x7f]/.test(path)||canonical(await realpath(path))!==canonical(path))throw fail();
      }
      if(!(await lstat(config.parentDirectory)).isDirectory()||!(await lstat(config.powershell)).isFile()||!(await lstat(config.scriptPath)).isFile())throw fail();
      const script=await open(config.scriptPath,'r');
      try {
        const before=await script.stat();if(!before.isFile()||before.size>65536)throw fail();
        const buffer=Buffer.alloc(65537);const {bytesRead}=await script.read(buffer,0,buffer.length,0);const after=await script.stat();
        if(bytesRead!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||createHash('sha256').update(buffer.subarray(0,bytesRead)).digest('hex')!==config.scriptSha256)throw fail();
      }finally{await script.close();}
    },
    async credentials() {
      try {
        const auth=await lstat(join(authHome,'auth.json'));
        if(!auth.isFile()||auth.isSymbolicLink()||auth.nlink!==1)throw fail();
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw fail();}
    },
  };
}
