import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateHudData} from '../../src/lifecycle/data-directory-migration.js';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'hud-migration-')),source=join(root,'old'),destination=join(root,'new');await mkdir(source);
 for(const name of ['auth.token','settings.json','install.json','observer-pilot.json','observer-provider-active.json'])await writeFile(join(source,name),`fixture-${name}`);
 return {root,source,destination,assertStopped:async()=>{},secureStage:async()=>{}};}
describe('offline HUD data migration',()=>{
 it('preserves byte-exact account and ledger data, retains originals and omits stale runtime',async()=>{const f=await fixture();try{
  await mkdir(join(f.source,'observer-accounting'));await writeFile(join(f.source,'observer-accounting','ledger.sqlite'),'ledger-bytes');
  await writeFile(join(f.source,'runtime.json'),'old-process');await writeFile(join(f.source,'Local State'),'encrypted-profile-key');
  const result=await migrateHudData(f);expect(result.originalsPreserved).toBe(true);
  expect(await readFile(join(f.destination,'observer-accounting','ledger.sqlite'),'utf8')).toBe('ledger-bytes');
  expect(await readFile(join(f.destination,'electron','Local State'),'utf8')).toBe('encrypted-profile-key');
  expect(await readFile(join(f.source,'auth.token'),'utf8')).toBe('fixture-auth.token');
  await expect(access(join(f.destination,'runtime.json'))).rejects.toThrow();
 }finally{await rm(f.root,{recursive:true,force:true});}});
 it('never overwrites an existing destination',async()=>{const f=await fixture();try{await mkdir(f.destination);await writeFile(join(f.destination,'keep'),'old');
  await expect(migrateHudData(f)).rejects.toThrow('MIGRATION_DESTINATION_EXISTS');expect(await readFile(join(f.destination,'keep'),'utf8')).toBe('old');
 }finally{await rm(f.root,{recursive:true,force:true});}});
 it('refuses publication if writers restart',async()=>{const f=await fixture();try{let checks=0;
  await expect(migrateHudData({...f,assertStopped:async()=>{if(++checks===3)throw Error('WRITER_RUNNING');}})).rejects.toThrow('WRITER_RUNNING');
  await expect(access(f.destination)).rejects.toThrow();expect(await readFile(join(f.source,'auth.token'),'utf8')).toBe('fixture-auth.token');
 }finally{await rm(f.root,{recursive:true,force:true});}});
 it('refuses source changes during copying',async()=>{const f=await fixture();try{
  await expect(migrateHudData({...f,secureStage:async()=>{await writeFile(join(f.source,'auth.token'),'changed');}})).rejects.toThrow('MIGRATION_SOURCE_CHANGED');
  await expect(access(f.destination)).rejects.toThrow();
 }finally{await rm(f.root,{recursive:true,force:true});}});
});
