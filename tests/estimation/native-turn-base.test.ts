import {expect,it} from 'vitest';
import {createNativeTurnBaseOwner} from '../../src/estimation/native-turn-base.js';

const signal=()=>new AbortController().signal;
const source=(overrides:Record<string,unknown>={})=>({identity:'source-file',sourceEpoch:1,currentTurnId:'seven',baseKey:'source-six-seven',
 boundary:{currentTurnId:'seven',currentStartOffset:30,watermark:60,completed:{turnId:'six',endOffset:30}},
 validate:async(s:AbortSignal)=>{s.throwIfAborted();},...overrides});

it('creates once for concurrent and later same-turn captures with increasing watermarks',async()=>{
 const owner=createNativeTurnBaseOwner();let calls=0;
 const create=async()=>{calls++;return 'base';};
 const [a,b]=await Promise.all([owner.acquire(source(),signal(),create),owner.acquire(source(),signal(),create)]);
 expect(a).toEqual({key:'source-six-seven',threadId:'base',lastTurnId:'six'});expect(b).toEqual(a);
 expect(await owner.acquire(source({boundary:{...source().boundary,watermark:99}}),signal(),create)).toEqual(a);
 expect(calls).toBe(1);expect(Object.isFrozen(a)).toBe(true);
});

it('represents a verified first turn without creating any historical base',async()=>{
 const owner=createNativeTurnBaseOwner();let calls=0;
 const result=await owner.acquire(source({boundary:{currentTurnId:'seven',currentStartOffset:10,watermark:60,completed:null}}),signal(),async()=>{calls++;return 'wrong';});
 expect(result).toEqual({key:'source-six-seven',threadId:null,lastTurnId:null});expect(calls).toBe(0);
});

it.each([
 {baseKey:'changed'}, {identity:'replacement'}, {sourceEpoch:2}, {currentTurnId:'eight'},
 {boundary:{currentTurnId:'seven',currentStartOffset:31,watermark:60,completed:{turnId:'six',endOffset:31}}},
])('rejects a different binding rather than reusing or replacing the live base: %j',async changed=>{
 const owner=createNativeTurnBaseOwner();let calls=0;const create=async()=>{calls++;return 'base';};
 await owner.acquire(source(),signal(),create);
 await expect(owner.acquire(source(changed),signal(),create)).rejects.toThrow('NATIVE_BASE_BINDING_CHANGED');expect(calls).toBe(1);
});

it('does not retry a failed base creation in the same owner generation',async()=>{
 const owner=createNativeTurnBaseOwner();let calls=0;
 await expect(owner.acquire(source(),signal(),async()=>{calls++;throw Error('RPC_LOST');})).rejects.toThrow('RPC_LOST');
 await expect(owner.acquire(source(),signal(),async()=>{calls++;return 'second';})).rejects.toThrow('NATIVE_BASE_UNAVAILABLE');expect(calls).toBe(1);
});

it('validates every capture before returning a cached base',async()=>{
 const owner=createNativeTurnBaseOwner();await owner.acquire(source(),signal(),async()=> 'base');
 await expect(owner.acquire(source({validate:async()=>{throw Error('SOURCE_REWRITTEN');}}),signal(),async()=> 'second')).rejects.toThrow('SOURCE_REWRITTEN');
 await expect(owner.acquire(source(),signal(),async()=> 'second')).rejects.toThrow('NATIVE_BASE_UNAVAILABLE');
});

it('close waits for in-flight creation and rejects its late result without hiding custody work',async()=>{
 const owner=createNativeTurnBaseOwner();let finish!:(id:string)=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const acquiring=owner.acquire(source(),signal(),async()=>{entered();return new Promise<string>(resolve=>{finish=resolve;});});
 const result=acquiring.catch(error=>error);await started;
 let closed=false;const closing=owner.close().then(()=>{closed=true;});
 await Promise.resolve();expect(closed).toBe(false);finish('base');
 expect((await result).message).toBe('NATIVE_BASE_UNAVAILABLE');await closing;
 await expect(owner.acquire(source(),signal(),async()=> 'second')).rejects.toThrow('NATIVE_BASE_UNAVAILABLE');
});

it('cancellation after base creation fences reuse and leaves disposal to resource custody',async()=>{
 const owner=createNativeTurnBaseOwner(),controller=new AbortController();let calls=0;
 await expect(owner.acquire(source(),controller.signal,async()=>{calls++;controller.abort();return 'base';})).rejects.toThrow();
 await expect(owner.acquire(source(),signal(),async()=>{calls++;return 'second';})).rejects.toThrow('NATIVE_BASE_UNAVAILABLE');expect(calls).toBe(1);await owner.close();
});
