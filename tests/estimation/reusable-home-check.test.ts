import {createHash} from 'node:crypto';
import {copyFile,link,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createReusableHomeCheck} from '../../src/estimation/reusable-home-check.js';
const roots:string[]=[], owners:ReturnType<typeof createReusableHomeCheck>[]=[];
afterEach(async()=>{for(const owner of owners.splice(0))await owner.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const parentDirectory=await mkdtemp(join(tmpdir(),'hud-reusable-check-'));roots.push(parentDirectory);
  const scriptPath=join(parentDirectory,'pinned-helper.ps1');await copyFile(resolve('scripts/windows/observer-home.ps1'),scriptPath);
  const config={parentDirectory,scriptPath,scriptSha256:createHash('sha256').update(await readFile(scriptPath)).digest('hex'),powershell:join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')};
  const owner=createReusableHomeCheck(config);owners.push(owner);return {owner,config};
}
it.skipIf(process.platform!=='win32')('revalidates pinned bytes even while a successful helper remains resident',async()=>{
  const {owner,config}=await fixture(); const signal=new AbortController().signal;
  await owner.check(false,signal);expect(owner.status()).toMatchObject({checking:false,resident:true});
  await writeFile(config.scriptPath,'# changed fixture');
  await expect(owner.check(true,signal)).rejects.toThrow('OBSERVER_HOME_UNAVAILABLE');
  expect(owner.status().resident).toBe(false);
});
it.skipIf(process.platform!=='win32')('validates credential link count after every successful helper response',async()=>{
  const {owner,config}=await fixture(); const signal=new AbortController().signal;
  const target=await owner.check(false,signal);await writeFile(join(target,'synthetic'),'not a credential');
  await link(join(target,'synthetic'),join(target,'auth.json'));
  await expect(owner.check(true,signal)).rejects.toThrow('OBSERVER_HOME_UNAVAILABLE');
  expect(await readFile(join(target,'synthetic'),'utf8')).toBe('not a credential');
  expect(config.parentDirectory).not.toBe(target);
});
it.skipIf(process.platform!=='win32')('never starts or creates state for a pre-aborted check',async()=>{
  const {owner,config}=await fixture();const controller=new AbortController();controller.abort();
  await expect(owner.check(false,controller.signal)).rejects.toThrow('OBSERVER_HOME_UNAVAILABLE');
  expect(await readdir(config.parentDirectory)).toEqual(['pinned-helper.ps1']);
});
