import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const codes=new Set(['ENOENT','EACCES','EPERM','EBUSY','EIO','EMFILE','ENFILE']);
const fingerprint=(path:string)=>createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');

/** Local metadata only: never read token, consent, or account file contents. */
export async function collectStartupFileEvidence(dataDirectory:string,tokenPath:string) {
  const entries=[['settings','settings.json'],['pilot','observer-pilot.json'],
    ['providerState','observer-provider-state.json'],['providerActive','observer-provider-active.json']] as const;
  async function probe(path:string,settings=false) {
    let handle:Awaited<ReturnType<typeof open>>|undefined;
    try {
      handle=await open(path,'r');
      const stat=await handle.stat();
      const base={readable:true,size:stat.size,modifiedAt:stat.mtime.toISOString()};
      if(!settings||!stat.isFile()||stat.size>4096)return base;
      const buffer=Buffer.alloc(4097);
      const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead>4096)return {...base,settingsReadable:false};
      try {
        const value:unknown=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
        const settings=value as {generation?:unknown;desiredState?:unknown}|null;
        const generation=settings?.generation;
        return {...base,settingsReadable:true,
          ...(typeof generation==='number'&&Number.isSafeInteger(generation)&&generation>=0?{generation}:{}),
          ...(['on','off'].includes(String(settings?.desiredState))?{desiredState:settings?.desiredState}:{})};
      } catch {return {...base,settingsReadable:false};}
    } catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      return {readable:false,error:typeof code==='string'&&codes.has(code)?code:'OTHER'};
    } finally {await handle?.close().catch(()=>undefined);}
  }
  return {version:1,pid:process.pid,at:new Date().toISOString(),
    dataDirectoryFingerprint:fingerprint(dataDirectory),tokenPathFingerprint:fingerprint(tokenPath),
    files:Object.fromEntries(await Promise.all(entries.map(async([name,path])=>[name,await probe(join(dataDirectory,path),name==='settings')]))),
    token:await probe(tokenPath)};
}

export async function writeStartupFileEvidence(dataDirectory:string,tokenPath:string):Promise<void> {
  const evidence=await collectStartupFileEvidence(dataDirectory,tokenPath);
  const directory=join(dataDirectory,'diagnostics');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`startup-files-${process.pid}-${randomUUID()}.json`),JSON.stringify(evidence),{flag:'wx',mode:0o600});
}
