import {expect,it} from 'vitest';
import {createSessionStartRecovery} from '../../src/observer/session-start-recovery.js';
import type {RunningTurnDiscovery} from '../../src/observer/conversation-record.js';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){let mono=0,wall=1000,confirmed=true,starts=0,scans=0;
 let resolve:((value:RunningTurnDiscovery|null)=>void)|undefined;
 const watcher=createSessionStartRecovery({now:()=>mono,wallNow:()=>wall,
  discover:async()=>{scans++;return new Promise(done=>{resolve=done;});},
  activate:async(_key,_host,_result,generation)=>{if(generation===7)starts++;}});
 return {watcher,at:(m:number,w:number)=>{mono=m;wall=w;},scans:()=>scans,starts:()=>starts,
  answer:async(startedAtMs=1100)=>{resolve?.({turnId:'native',startedAtMs,confirm:async()=>confirmed});await flush();},
  deny:()=>{confirmed=false;}};
}
it('does not create a turn from a session hint alone; only confirms a fresh native start',async()=>{
 const f=fixture();f.watcher.watch('session','host',7);f.watcher.tick();expect(f.starts()).toBe(0);
 f.at(1000,2000);await f.answer();expect(f.starts()).toBe(1);f.watcher.tick();expect(f.scans()).toBe(1);f.watcher.close();
});
it.each(['old','future','unconfirmed','generation'] as const)('does not activate %s evidence',async mode=>{
 const f=fixture();f.watcher.watch('session','host',mode==='generation'?8:7);f.watcher.tick();f.at(1000,2000);
 if(mode==='unconfirmed')f.deny();await f.answer(mode==='old'?999:mode==='future'?3000:1100);
 expect(f.starts()).toBe(0);f.watcher.close();
});
it.each(['cancel','close','expire','rebind'] as const)('rejects late completion after %s',async mode=>{
 const f=fixture();f.watcher.watch('session','host',7);f.watcher.tick();f.at(1000,2000);
 if(mode==='cancel')f.watcher.cancel('session');if(mode==='close')f.watcher.close();
 if(mode==='expire')f.at(15*60*1000,2000);if(mode==='rebind')f.watcher.watch('session','host',8);
 await f.answer();expect(f.starts()).toBe(0);f.watcher.close();
});
it('bounds pending hints and native scans instead of spawning work for every hint',()=>{
 const f=fixture();for(let n=0;n<40;n++)f.watcher.watch(`session-${n}`,`host-${n}`,7);
 f.watcher.tick();expect(f.scans()).toBe(2);f.watcher.close();
});
