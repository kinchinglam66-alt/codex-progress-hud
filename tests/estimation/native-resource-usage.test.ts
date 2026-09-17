import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeWorkerResources} from '../../src/estimation/native-worker-resources.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){
 if(!root.startsWith(join(tmpdir(),'hud-native-resource-usage-')))throw Error('UNSAFE_TEST_CLEANUP');
 await rm(root,{recursive:true,force:true});
}});

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hud-native-resource-usage-'));roots.push(root);
 const runtimeHome=join(root,'observer-auth'),snapshots=join(runtimeHome,'hud-native','snapshots'),custody=join(runtimeHome,'hud-native','custody');
 await mkdir(snapshots,{recursive:true});await mkdir(custody);await mkdir(join(runtimeHome,'sessions'));
 const invocation={executable:join(root,'codex.exe'),cwd:root,args:['app-server','--stdio'],env:{CODEX_HOME:runtimeHome},input:''};
 let exited=false;
 const resources=createNativeWorkerResources({runtimeHome,maxSourceBytes:10000,
  storage:{prepare:async()=>({snapshots,custody}),verify:async()=>{}},captureController:async()=>({pid:100,creationIdentity:'controller'}),
  isExited:async process=>process.pid===101&&exited,prepareCleanupInvocation:async()=>invocation,
  cleanupProcessFactory:()=>({start:async()=>({rpc:{call:async(method:string,params:unknown)=>{
   if(method==='initialize')return {};
   if(method==='thread/delete'){await unlink(join(runtimeHome,'sessions',`${(params as {threadId:string}).threadId}.jsonl`));return {};}
   throw Error('UNEXPECTED_MODEL_OR_RPC');},notify:()=>{},subscribe:()=>()=>{}}}),close:async()=>{},disable:()=>{}}),
 });
 const usage=()=> (resources as typeof resources&{usage():Promise<{requests:number;knownBytes:number}>}).usage();
 const path=join(snapshots,'.native-source-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp');
 const source={currentTurnId:'current',snapshot:{kind:'native' as const,sourceThreadId:'source',sourceTurnId:'current',sourceEpoch:1,revision:1,path,byteLength:4,close:async()=>{}}};
 return {root,runtimeHome,snapshots,custody,invocation,resources,usage,source,exited:()=>{exited=true;}};
}

it('reports only owned snapshot, manifest, and tagged fork-log bytes',async()=>{
 const f=await fixture(),target=await f.resources.destination(new AbortController().signal);
 await writeFile(f.source.snapshot.path,'');await target.beforeCopy!(f.source.snapshot.path);await writeFile(f.source.snapshot.path,'DATA');target.copySettled?.();
 const claim=await f.resources.claim(f.source,f.invocation,{pid:101,creationIdentity:'child'},new AbortController().signal);
 await writeFile(join(f.runtimeHome,'sessions','fork.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'fork',thread_source:claim.tag}})+'\nFORK');
 await claim.recordFork('fork');
 await expect(f.usage()).resolves.toMatchObject({requests:1,knownBytes:expect.any(Number)});
});

it('fails closed when a cached owned snapshot is replaced',async()=>{
 const f=await fixture(),target=await f.resources.destination(new AbortController().signal);
 await writeFile(f.source.snapshot.path,'');await target.beforeCopy!(f.source.snapshot.path);await writeFile(f.source.snapshot.path,'DATA');target.copySettled?.();
 await f.usage();
 const replacement=join(f.root,'replacement.tmp');await writeFile(replacement,'ATTACKER');await rm(f.source.snapshot.path);await (await import('node:fs/promises')).link(replacement,f.source.snapshot.path);
 await expect(f.usage()).rejects.toThrow('NATIVE_RESOURCE_');
});
