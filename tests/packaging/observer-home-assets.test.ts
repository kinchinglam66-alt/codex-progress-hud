import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getConfig} from 'app-builder-lib/out/util/config/config.js';
import {expect,it} from 'vitest';
import {OBSERVER_HOME_SCRIPT_SHA256,observerHomeProfile} from '../../src/estimation/observer-home-assets.js';

it('packages the pinned helper outside app.asar at the runtime-resolved path',async()=>{
  const config=await getConfig(process.cwd(),null,null);
  const resources=Array.isArray(config.extraResources)?config.extraResources:[config.extraResources];
  const mapping=resources.find(value=>typeof value==='object' && value?.to==='observer-home.ps1');
  expect(mapping).toMatchObject({from:'scripts/windows/observer-home.ps1',to:'observer-home.ps1'});
  if(!mapping || typeof mapping!=='object' || !mapping.from) throw Error('TEST_HELPER_MAPPING_MISSING');
  const bytes=await readFile(resolve(mapping.from));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(OBSERVER_HOME_SCRIPT_SHA256);
  const profile=observerHomeProfile(resolve('resources'),resolve('data'),resolve('powershell.exe'));
  expect(profile).toEqual({parentDirectory:resolve('data'),powershell:resolve('powershell.exe'),scriptPath:resolve('resources','observer-home.ps1'),scriptSha256:OBSERVER_HOME_SCRIPT_SHA256});
  expect(Object.isFrozen(profile)).toBe(true);
});
it('refuses relative or control-character runtime asset locations',()=>{
  for(const values of [['relative',resolve('data'),resolve('powershell.exe')],
    [resolve('resources'),'relative',resolve('powershell.exe')],
    [resolve('resources'),resolve('data'),'relative'],
    [resolve('resources')+'\n',resolve('data'),resolve('powershell.exe')]]) {
    expect(()=>observerHomeProfile(values[0]!,values[1]!,values[2]!)).toThrow('OBSERVER_HOME_ASSETS_UNAVAILABLE');
  }
});
