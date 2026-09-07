import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {codexRuntimeProfiles} from '../estimation/codex-runtime-profiles.js';

// Only explicit release-controlled candidates; never trust on first discovery.
export async function findPinnedCodex(root: string, trustedHash: string | readonly string[]=codexRuntimeProfiles.map(profile => profile.sha256)): Promise<string> {
  try {
    const pins = typeof trustedHash === 'string' ? [trustedHash] : [...trustedHash];
    if(!isAbsolute(root) || pins.length < 1 || pins.length > 8 || pins.some(pin => typeof pin !== 'string' || !/^[a-f0-9]{64}$/i.test(pin))) throw Error();
    const trusted = new Set(pins.map(pin => pin.toLowerCase()));
    if((await realpath(root)).toLowerCase() !== resolve(root).toLowerCase()) throw Error();
    const entries=await readdir(root,{withFileTypes:true});
    if(entries.length>64) throw Error();
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file=join(root,entry.name,'codex.exe');
      try {
        const stat=await lstat(file);
        if(!stat.isFile() || stat.isSymbolicLink() || stat.size>512*1024*1024 ||
          (await realpath(file)).toLowerCase()!==resolve(file).toLowerCase()) continue;
        const hash=createHash('sha256');
        for await(const chunk of createReadStream(file))hash.update(chunk);
        if(trusted.has(hash.digest('hex')))return file;
      } catch { /* unknown installation entries are not executable candidates */ }
    }
  } catch { /* only a sanitized availability result crosses this boundary */ }
  throw Error('NAME_SOURCE_UNAVAILABLE');
}

export function nameProcessArguments(): string[] {
  const args=['app-server','--listen','stdio://'];
  for(const feature of ['plugins','hooks','apps','remote_plugin','multi_agent','code_mode_host',
    'shell_tool','unified_exec','workspace_dependencies','memories']) args.push('--disable',feature);
  for(const setting of ['analytics.enabled=false','history.persistence="none"',
    'features.respect_system_proxy=true','suppress_unstable_features_warning=true']) args.push('-c',setting);
  return args;
}
