import {afterEach,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {createNativeSnapshotCustody,recoverNativeSnapshotCustody,type NativeSnapshotProcess} from '../../src/estimation/native-snapshot-custody.js';

const roots:string[]=[];
const key=(process:NativeSnapshotProcess)=>`${process.pid}:${process.creationIdentity}`;
const testRootParent=resolve(tmpdir());
const testRootName='hud-native-snapshot-custody-';

afterEach(async()=>{
 for(const root of roots.splice(0)){
  const resolved=resolve(root);
  if(dirname(resolved)!==testRootParent||!basename(resolved).startsWith(testRootName))throw Error('UNSAFE_TEST_CLEANUP');
  await fs.rm(resolved,{recursive:true,force:true});
 }
});

async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'hud-native-snapshot-custody-'));
 roots.push(root);
 const directory=join(root,'protected');
 await fs.mkdir(directory);
 const controller={pid:100,creationIdentity:'controller-birth'};
 const exited=new Map<string,boolean>();
 const options={directory,runtimeHome:root,verifyStorage:async()=>{},controller,isExited:async(process:NativeSnapshotProcess)=>exited.get(key(process))??false};
 const snapshotPath=join(directory,'.native-source-11111111-1111-4111-8111-111111111111.tmp');
 const createEmptySnapshot=async()=>{await fs.writeFile(snapshotPath,'');return snapshotPath;};
 return {root,directory,controller,exited,options,snapshotPath,createEmptySnapshot};
}

it('persists the exact empty snapshot identity before the pre-copy hook resolves',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 await f.createEmptySnapshot();
 await custody.beforeCopy(f.snapshotPath);
 const manifests=(await fs.readdir(f.directory)).filter(name=>name.includes('native-snapshot-custody'));
 expect(manifests).toHaveLength(1);
 const manifest=await fs.readFile(join(f.directory,manifests[0]!), 'utf8');
 expect(manifest).toContain('"basename":".native-source-11111111-1111-4111-8111-111111111111.tmp"');
 expect(manifest).toContain('"linkCount":"1"');
});

it('does not clean a registered copy while a child is live, then retries after exit',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 await f.createEmptySnapshot();
 await custody.beforeCopy(f.snapshotPath);
 const child={pid:101,creationIdentity:'child-birth'};
 await custody.bindChild(child);
 await expect(custody.close()).rejects.toMatchObject({code:'NATIVE_SNAPSHOT_CUSTODY_PROCESS_NOT_EXITED'});
 expect(await fs.readFile(f.snapshotPath,'utf8')).toBe('');
 f.exited.set(key(child),true);
 await custody.close();
 await expect(fs.access(f.snapshotPath)).rejects.toMatchObject({code:'ENOENT'});
 expect((await fs.readdir(f.directory))).toEqual([]);
});

it('joins concurrent close calls and keeps a failed close retryable',async()=>{
 const f=await fixture();
 let fail=false;
 const custody=await createNativeSnapshotCustody({...f.options,verifyStorage:async()=>{if(fail)throw Object.assign(new Error('storage unavailable'),{code:'STORAGE_UNAVAILABLE'});}} as typeof f.options);
 fail=false;
 await f.createEmptySnapshot();
 await custody.beforeCopy(f.snapshotPath);
 fail=true;
 const first=custody.close();
 const second=custody.close();
 expect(second).toBe(first);
 await expect(first).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
 fail=false;
 await custody.close();
 expect(await fs.readdir(f.directory)).toEqual([]);
});

it('rejects storage whose ancestor is a reparse point',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),testRootName));roots.push(root);
 const actual=join(root,'actual'),link=join(root,'linked-storage'),directory=join(link,'protected');
 await fs.mkdir(actual);await fs.mkdir(join(actual,'protected'));
 await fs.symlink(actual,link,'junction');
 await expect(createNativeSnapshotCustody({directory,runtimeHome:root,verifyStorage:async()=>{},controller:{pid:100,creationIdentity:'controller-birth'},isExited:async()=>true}))
  .rejects.toMatchObject({code:'NATIVE_SNAPSHOT_CUSTODY_REPARSE'});
});

it('rejects a replacement manifest before using its snapshot records',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 await f.createEmptySnapshot();await custody.beforeCopy(f.snapshotPath);
 const manifestName=(await fs.readdir(f.directory)).find(name=>name.startsWith('native-snapshot-custody-'))!;
 const manifestPath=join(f.directory,manifestName),original=await fs.readFile(manifestPath);
 await fs.unlink(manifestPath);await fs.writeFile(manifestPath,original);
 await expect(custody.close()).rejects.toMatchObject({code:'NATIVE_SNAPSHOT_CUSTODY_REPLACED'});
 expect(await fs.readFile(f.snapshotPath,'utf8')).toBe('');
});

it('rejects a manifest without a complete final record newline',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 const manifestName=(await fs.readdir(f.directory)).find(name=>name.startsWith('native-snapshot-custody-'))!;
 const manifestPath=join(f.directory,manifestName);
 await fs.appendFile(manifestPath,JSON.stringify({type:'child',process:{pid:101,creationIdentity:'child-birth'}}));
 await f.createEmptySnapshot();
 await expect(custody.beforeCopy(f.snapshotPath)).rejects.toMatchObject({code:'NATIVE_SNAPSHOT_CUSTODY_METADATA_INVALID'});
});

it('recovers an exact file only after controller and child exit are confirmed',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 await f.createEmptySnapshot();
 await custody.beforeCopy(f.snapshotPath);
 const child={pid:101,creationIdentity:'child-birth'};
 await custody.bindChild(child);
 f.exited.set(key(f.controller),true);
 expect((await recoverNativeSnapshotCustody(f.options)).pending).toBe(1);
 f.exited.set(key(child),true);
 expect(await recoverNativeSnapshotCustody(f.options)).toEqual({cleaned:1,pending:0});
 expect(await fs.readdir(f.directory)).toEqual([]);
});

it('retains evidence for a live or unknown controller, and for a live child',async()=>{
 const live=await fixture();
 const liveCustody=await createNativeSnapshotCustody(live.options);
 await live.createEmptySnapshot();await liveCustody.beforeCopy(live.snapshotPath);
 expect((await recoverNativeSnapshotCustody(live.options)).pending).toBe(1);
 await expect(fs.access(live.snapshotPath)).resolves.toBeUndefined();

 const unknown=await fixture();
 const unknownCustody=await createNativeSnapshotCustody(unknown.options);
 await unknown.createEmptySnapshot();await unknownCustody.beforeCopy(unknown.snapshotPath);
 expect((await recoverNativeSnapshotCustody({...unknown.options,isExited:async()=>{throw new Error('probe unavailable');}})).pending).toBe(1);
 await expect(fs.access(unknown.snapshotPath)).resolves.toBeUndefined();
});

it('refuses external registration and does not sweep unregistered files',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 const external=join(f.root,'external.tmp');
 await fs.writeFile(external,'PRIVATE SYNTHETIC HISTORY');
 await expect(custody.beforeCopy(external)).rejects.toMatchObject({code:'NATIVE_SNAPSHOT_CUSTODY_PATH'});
 f.exited.set(key(f.controller),true);
 await recoverNativeSnapshotCustody(f.options);
 expect(await fs.readFile(external,'utf8')).toBe('PRIVATE SYNTHETIC HISTORY');
});

it('fails closed when the registered file is replaced by a hardlink',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 await f.createEmptySnapshot();await custody.beforeCopy(f.snapshotPath);
 const replacement=join(f.root,'replacement.tmp');
 await fs.writeFile(replacement,'attacker-owned');
 await fs.unlink(f.snapshotPath);
 await fs.link(replacement,f.snapshotPath);
 f.exited.set(key(f.controller),true);
 await expect(recoverNativeSnapshotCustody(f.options)).rejects.toMatchObject({code:'NATIVE_SNAPSHOT_CUSTODY_OWNERSHIP_MISMATCH'});
 expect(await fs.readFile(f.snapshotPath,'utf8')).toBe('attacker-owned');
});

it('allows recovery when the controller died before any child was bound',async()=>{
 const f=await fixture();
 const custody=await createNativeSnapshotCustody(f.options);
 await f.createEmptySnapshot();await custody.beforeCopy(f.snapshotPath);
 f.exited.set(key(f.controller),true);
 await recoverNativeSnapshotCustody(f.options);
 expect(await fs.readdir(f.directory)).toEqual([]);
});

it('serializes recovery probes while keeping normal manifest lanes independent',async()=>{
 const f=await fixture();
 const first=await createNativeSnapshotCustody(f.options);
 const second=await createNativeSnapshotCustody(f.options);
 const secondPath=join(f.directory,'.native-source-22222222-2222-4222-8222-222222222222.tmp');
 await f.createEmptySnapshot();await fs.writeFile(secondPath,'');
 await first.beforeCopy(f.snapshotPath);await second.beforeCopy(secondPath);
 f.exited.set(key(f.controller),true);
 let active=0,maxActive=0;
 const probe=async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return true;};
 await recoverNativeSnapshotCustody({...f.options,isExited:probe});
 expect(maxActive).toBe(1);
});
