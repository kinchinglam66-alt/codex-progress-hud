import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getConfig} from 'app-builder-lib/out/util/config/config.js';
import {expect,it} from 'vitest';
import {observerAssetPins} from '../../src/estimation/asset-pins.js';

it('ships exact rich observer assets outside app.asar with source-pinned bytes',async()=>{
  const config=await getConfig(process.cwd(),null,null);
  const resources=Array.isArray(config.extraResources)?config.extraResources:[config.extraResources];
  for(const [name,pin] of Object.entries(observerAssetPins)) {
    const mapping=resources.find(value=>typeof value==='object' && value?.to===`observer-assets/${name}`);
    expect(mapping).toEqual({from:`src/estimation/assets/${name}`,to:`observer-assets/${name}`});
    if(!mapping || typeof mapping!=='object' || !mapping.from) throw Error('MISSING_OBSERVER_ASSET');
    expect(createHash('sha256').update(await readFile(resolve(mapping.from))).digest('hex')).toBe(pin);
  }
});
