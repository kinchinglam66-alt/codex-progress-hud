import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,readdir,open,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeForkCustody,recoverNativeForkCustody} from '../../src/estimation/native-fork-custody.js';
const roots:string[]=[];
// Count real filesystem operations, without replacing their side effects.
vi.mock('node:fs/promises',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs/promises')>();
 return {...actual,readdir:vi.fn(actual.readdir),open:vi.fn(actual.open)};
});
afterEach(async()=>{for(const root of roots.splice(0)){if(!root.startsWith(join(tmpdir(),'hud-native-custody-')))throw Error('UNSAFE_TEST_CLEANUP');await rm(root,{recursive:true,force:true});}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hud-native-custody-'));roots.push(root);
 const directory=join(root,'custody'),sessions=join(root,'sessions');await mkdir(directory);await mkdir(sessions);
 let exited=false;const deleted:string[]=[],files=new Map<string,string>();
 const options={directory,runtimeHome:root,verifyStorage:async()=>{},isExited:async()=>exited,
  rpc:{subscribe:()=>()=>{},call:async(method:string,params:unknown)=>{
   if(method!=='thread/delete')throw Error('UNEXPECTED_RPC');const id=(params as {threadId:string}).threadId;
   const path=files.get(id);if(!path)throw Error('UNOWNED_DELETE');deleted.push(id);await unlink(path);return {};
  }}};
 const writeFork=async(id:string,tag:string)=>{const path=join(sessions,`${id}.jsonl`);files.set(id,path);
  await writeFile(path,JSON.stringify({type:'session_meta',payload:{id,thread_source:tag}})+'\nPRIVATE SYNTHETIC HISTORY\n');return path;};
 return {root,options,deleted,writeFork,exit:()=>{exited=true;}};
}
it('recovers only its tagged fork after confirmed owner exit, including a missing fork acknowledgement',async()=>{
 const f=await fixture();
 const custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth-1'}});
 expect(await custody.isRetired()).toBe(false);
 const own=await f.writeFork('owned',custody.tag),other=await f.writeFork('other','unrelated-tag');
 const active=await recoverNativeForkCustody(f.options);expect(active.pending).toBe(1);expect(f.deleted).toEqual([]);
 f.exit();const recovered=await recoverNativeForkCustody(f.options);
 expect(await custody.isRetired()).toBe(true);
 expect(recovered).toMatchObject({cleaned:1,pending:0});expect(f.deleted).toEqual(['owned']);
 await expect(readFile(own)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(other,'utf8')).toContain('PRIVATE SYNTHETIC HISTORY');
});
it('refuses source task deletion even if it carries a matching tag',async()=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth-1'}});
 await f.writeFork('source',custody.tag);f.exit();
 await expect(recoverNativeForkCustody(f.options)).rejects.toThrow('NATIVE_CUSTODY_SOURCE_COLLISION');expect(f.deleted).toEqual([]);
});
it('keeps cleanup pending if owner liveness cannot be established',async()=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth-1'}});
 await f.writeFork('owned',custody.tag);
 const result=await recoverNativeForkCustody({...f.options,isExited:async()=>{throw Error('UNKNOWN');}});
 expect(result.pending).toBe(1);expect(f.deleted).toEqual([]);
});
it('does not accept an ambiguous delete acknowledgement as cleanup success',async()=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth-1'}});
 await f.writeFork('owned',custody.tag);f.exit();
 await expect(recoverNativeForkCustody({...f.options,rpc:{subscribe:()=>()=>{},call:async()=>null}})).rejects.toThrow('NATIVE_CUSTODY_DELETE_UNCONFIRMED');
 expect((await recoverNativeForkCustody(f.options)).cleaned).toBe(1);
});
it('requires attested storage before recording any custody intent',async()=>{
 const f=await fixture();
 await expect(createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth-1'},verifyStorage:async()=>{throw Error('ACL_INVALID');}})).rejects.toThrow('ACL_INVALID');
 expect(resolve(f.options.directory)).toBe(f.options.directory);
});

it('persists the root source exclusion for child-of-base recovery with a lost reply',async()=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'base',rootSourceThreadId:'root',process:{pid:123,creationIdentity:'birth-1'}});
 await expect(custody.recordFork('root')).rejects.toThrow('NATIVE_CUSTODY_SOURCE_COLLISION');
 await f.writeFork('root',custody.tag);f.exit();
 await expect(recoverNativeForkCustody(f.options)).rejects.toThrow('NATIVE_CUSTODY_SOURCE_COLLISION');
 expect(f.deleted).toEqual([]);
});

it('enumerates and reads unrelated rollout metadata once for several retired owners',async()=>{
 const f=await fixture();
 for(let i=0;i<3;i++){
  const custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123+i,creationIdentity:`birth-${i}`}});
  await f.writeFork(`owned-${i}`,custody.tag);
 }
 const other=await f.writeFork('unrelated','other');f.exit();
 vi.mocked(readdir).mockClear();vi.mocked(open).mockClear();
 expect(await recoverNativeForkCustody(f.options)).toEqual({cleaned:3,pending:0});
 expect(f.deleted.sort()).toEqual(['owned-0','owned-1','owned-2']);
 expect(vi.mocked(readdir).mock.calls.filter(([path])=>path===join(f.root,'sessions'))).toHaveLength(1);
 expect(vi.mocked(open).mock.calls.filter(([path])=>path===other)).toHaveLength(1);
 expect(await readFile(other,'utf8')).toContain('PRIVATE SYNTHETIC HISTORY');
});

it('does not scan rollout directories when all owners remain live',async()=>{
 const f=await fixture();
 await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth'}});
 vi.mocked(readdir).mockClear();
 expect(await recoverNativeForkCustody(f.options)).toEqual({cleaned:0,pending:1});
 expect(vi.mocked(readdir).mock.calls.filter(([path])=>path===join(f.root,'sessions'))).toHaveLength(0);
});

it('rechecks metadata after enumeration before deleting a candidate',async()=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth'}});
 const path=await f.writeFork('owned',custody.tag);f.exit();let checks=0;
 await expect(recoverNativeForkCustody({...f.options,verifyStorage:async()=>{
  if(++checks===2)await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'unrelated',thread_source:'other'}})+'\n');
 }})).rejects.toThrow('NATIVE_CUSTODY_REPLACED');
 expect(f.deleted).toEqual([]);expect(await custody.isRetired()).toBe(false);
});

it('keeps an owner that exits after initial classification pending until the next recovery',async()=>{
 const f=await fixture();
 const first=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth-1'}});
 const later=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:124,creationIdentity:'birth-2'}});
 await f.writeFork('first',first.tag);await f.writeFork('later',later.tag);
 const result=await recoverNativeForkCustody({...f.options,isExited:async p=>p.pid===123});
 expect(result).toEqual({cleaned:1,pending:1});expect(f.deleted).toEqual(['first']);
 expect(await later.isRetired()).toBe(false);f.exit();
 expect(await recoverNativeForkCustody(f.options)).toEqual({cleaned:1,pending:0});
 expect(f.deleted).toEqual(['first','later']);
});

it('retains custody if the pre-delete owner-exit recheck is no longer confirmed',async()=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth'}});
 await f.writeFork('owned',custody.tag);let probes=0;
 await expect(recoverNativeForkCustody({...f.options,isExited:async()=>++probes===1})).rejects.toThrow('NATIVE_OWNER_EXIT_UNCONFIRMED');
 expect(f.deleted).toEqual([]);expect(await custody.isRetired()).toBe(false);
});

it('does not reuse the rollout snapshot across recovery calls',async()=>{
 const f=await fixture();f.exit();
 expect(await recoverNativeForkCustody(f.options)).toEqual({cleaned:0,pending:0});
 const custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth'}});
 await f.writeFork('new-fork',custody.tag);
 expect(await recoverNativeForkCustody(f.options)).toEqual({cleaned:1,pending:0});
 expect(f.deleted).toEqual(['new-fork']);
});

it.each(['missing','archived'] as const)('preserves custody when a scanned candidate becomes %s without a confirmed ancestor delete',async kind=>{
 const f=await fixture(),custody=await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth'}});
 const path=await f.writeFork('owned',custody.tag);f.exit();let checks=0;
 await expect(recoverNativeForkCustody({...f.options,verifyStorage:async()=>{
  if(++checks!==2)return;
  if(kind==='missing')await unlink(path);
  else{const archive=join(f.root,'archived_sessions');await mkdir(archive);await rename(path,join(archive,'owned.jsonl'));}
 }})).rejects.toMatchObject({code:'ENOENT'});
 expect(f.deleted).toEqual([]);expect(await custody.isRetired()).toBe(false);
});

it('accepts a child removed by an acknowledged deletion of its owned direct parent',async()=>{
 const f=await fixture(),leases=[];
 for(let i=0;i<2;i++)leases.push(await createNativeForkCustody({...f.options,sourceThreadId:'source',process:{pid:123,creationIdentity:'birth'}}));
 const names=await readdir(f.options.directory);
 const parent=leases.find(c=>c.manifestPath===join(f.options.directory,names[0]!))!;
 const child=leases.find(c=>c!==parent)!;
 // Fix the synthetic relationship before recovery, without imposing UUID order.
 const childIntent=JSON.parse((await readFile(child.manifestPath,'utf8')).trim());
 childIntent.sourceThreadId='base';childIntent.rootSourceThreadId='source';
 await writeFile(child.manifestPath,JSON.stringify(childIntent)+'\n');
 const parentPath=await f.writeFork('base',parent.tag),childPath=await f.writeFork('child',child.tag);f.exit();
 const calls:string[]=[];
 expect(await recoverNativeForkCustody({...f.options,rpc:{subscribe:()=>()=>{},call:async(method,params)=>{
  expect(method).toBe('thread/delete');const id=(params as {threadId:string}).threadId;calls.push(id);
  expect(id).toBe('base');await unlink(parentPath);await unlink(childPath);return {};
 }}})).toEqual({cleaned:2,pending:0});
 expect(calls).toEqual(['base']);expect(await child.isRetired()).toBe(true);
});
