import {isAbsolute,resolve} from 'node:path';
import {lstat,open} from 'node:fs/promises';
import {z} from 'zod';
import {codexRuntimeProfiles} from '../estimation/codex-runtime-profiles.js';

const pathSchema=z.string().min(1).max(4096).refine(value=>isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value) &&
  (process.platform!=='win32' || /^[a-z]:[\\/]/i.test(value)));
const schema=z.object({executable:pathSchema,parentDirectory:pathSchema,cwd:pathSchema,
  version:z.string().refine(value=>codexRuntimeProfiles.some(profile=>profile.version===value)),
  executableSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  persistentObserver:z.boolean().optional(),
  proxyUrl:z.string().max(256).refine(value=>{
    try {const url=new URL(value);return url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname) &&
      !url.username && !url.password && url.pathname==='/' && !url.search && !url.hash;}catch{return false;}
  })}).strict().refine(value=>resolve(value.cwd).toLowerCase()!==resolve(value.parentDirectory).toLowerCase())
  .refine(value=>value.executableSha256===undefined || codexRuntimeProfiles.some(profile=>
    profile.version===value.version && profile.sha256===value.executableSha256));
export type ObserverPilotConfig=z.infer<typeof schema>;
export async function readObserverPilotConfig(path:string):Promise<ObserverPilotConfig|null> {
  let metadata;
  try {metadata=await lstat(path);}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw Error('OBSERVER_PILOT_CONFIG_INVALID');
  }
  if(!metadata.isFile() || metadata.isSymbolicLink() || metadata.size>16384)throw Error('OBSERVER_PILOT_CONFIG_INVALID');
  const file=await open(path,'r').catch(()=>{throw Error('OBSERVER_PILOT_CONFIG_INVALID');});
  try {
    const buffer=Buffer.alloc(16385),{bytesRead}=await file.read(buffer,0,buffer.length,0);
    if(bytesRead>16384)throw Error();
    return parseObserverPilotConfig(JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')));
  }catch{throw Error('OBSERVER_PILOT_CONFIG_INVALID');}finally{await file.close();}
}
export function parseObserverPilotConfig(value:unknown):ObserverPilotConfig {
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw Error('OBSERVER_PILOT_CONFIG_INVALID');
  return Object.freeze(parsed.data);
}
/** Only the observer child gets these settings; never mutate process.env. */
export function observerPilotEnvironment(config:ObserverPilotConfig,environment:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env={...environment};
  for(const key of Object.keys(env))if(/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key))delete env[key];
  return {...env,HTTP_PROXY:config.proxyUrl,HTTPS_PROXY:config.proxyUrl,ALL_PROXY:config.proxyUrl,NO_PROXY:'localhost,127.0.0.1,::1'};
}
