import {describe,it,expect} from 'vitest';
import {resolve} from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {parseObserverPilotConfig,observerPilotEnvironment,readObserverPilotConfig} from '../../src/desktop/observer-pilot-config.js';

const config={executable:resolve('codex.exe'),parentDirectory:resolve('private-pilot'),cwd:resolve('private-pilot/empty'),version:'0.153.4',proxyUrl:'http://127.0.0.1:7890'};
describe('local observer pilot configuration',()=>{
  it('preserves an explicitly verified build selector and rejects unknown or mismatched pins',()=>{
    const executableSha256='e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75';
    expect(parseObserverPilotConfig({...config,executableSha256})).toMatchObject({executableSha256});
    expect(()=>parseObserverPilotConfig({...config,executableSha256:'0'.repeat(64)})).toThrow();
    expect(()=>parseObserverPilotConfig({...config,version:'0.153.3',executableSha256})).toThrow();
  });
  it('accepts explicit local paths and a loopback proxy',()=>{
    expect(parseObserverPilotConfig(config)).toEqual(config);
  });
  it.each([
    {...config,executable:'codex.exe'}, {...config,parentDirectory:'../private'},
    {...config,version:'unverified'}, {...config,apiKey:'secret'},
    {...config,proxyUrl:'http://user:password@127.0.0.1:7890'},
    {...config,proxyUrl:'http://remote.example:7890'},
    {...config,proxyUrl:'http://127.0.0.1:7890/path'},
    {...config,cwd:config.parentDirectory},
  ])('rejects untrusted or ambiguous host settings',value=>expect(()=>parseObserverPilotConfig(value)).toThrow('OBSERVER_PILOT_CONFIG_INVALID'));
  it('overrides all case variants only in the child environment',()=>{
    const original={https_proxy:'http://old',HTTP_PROXY:'http://old',no_proxy:'*',OTHER:'keep'};
    const env=observerPilotEnvironment(config,original);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.https_proxy).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    expect(env.OTHER).toBe('keep');
    expect(original.https_proxy).toBe('http://old');
  });
  it('reads a bounded opt-in file, with absence distinct from invalid settings',async()=>{
    const directory=await mkdtemp(resolve(tmpdir(),'hud-config-'));
    const file=resolve(directory,'observer-pilot.json');
    try {
      expect(await readObserverPilotConfig(file)).toBeNull();
      await writeFile(file,JSON.stringify(config));
      expect(await readObserverPilotConfig(file)).toEqual(config);
      await writeFile(file,' '.repeat(16385));
      await expect(readObserverPilotConfig(file)).rejects.toThrow('OBSERVER_PILOT_CONFIG_INVALID');
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
