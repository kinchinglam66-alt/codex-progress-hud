import {expect,it} from 'vitest';
import {createConversationSource} from '../../src/observer/conversation-source.js';
import type {ReadBatch,RunningTurnDiscovery} from '../../src/observer/conversation-record.js';

async function fixture({at=11000,explicit=true,partial=false,truncated=false,terminal=false}={}){
  let now=1000,wall=10000;
  const records:ReadBatch['records']=[{id:'start',turnId:'native',
    sourceTurnId:explicit?'native':null,atMs:at,kind:'runtime',runtime:'running'},
    {id:'user',turnId:'native',atMs:at,kind:'user',text:'Native task'}];
  if(terminal)records.push({id:'end',turnId:'native',atMs:at+1,kind:'runtime',runtime:'waiting',outcome:'completed'});
  const source=createConversationSource({source:{read:async()=>({records,caughtUp:true,reset:false,
    partialLine:partial,historyTruncated:truncated}),remove(){},async close(){}},
    now:()=>now,wallNow:()=>wall,turnKeyFor:(_host,id)=>`key-${id}`,taskHandleFor:(_host,id)=>`task-${id}`});
  source.attach('session','host','key-missing');
  now=3000;wall=12000;source.tick();await new Promise(resolve=>setImmediate(resolve));
  return source;
}
it('recovers an absent Hook turn only onto a subsequent explicit native running turn',async()=>{
  const source=await fixture();
  try{
    expect(source.goals.read('session','key-missing',{goalSummary:null,activeSeconds:0,runtime:'running',previousEstimate:null})).toBeNull();
    expect(source.goals.takeover?.('session','key-missing')).toMatchObject({turnKey:'key-native',taskHandle:'task-native',startedAtMs:2000});
    expect(source.turnKey('session')).toBe('key-native');
    expect(source.goals.takeover?.('session','key-missing')).toBeNull();
  }finally{await source.close();}
});
it.each([
  {at:9000},{at:10000},{at:13000},{explicit:false},{partial:true},{truncated:true},{terminal:true}
])('does not guess ownership from unsafe native evidence %j',async options=>{
  const source=await fixture(options);
  try{expect(source.goals.takeover?.('session','key-missing')).toBeNull();expect(source.turnKey('session')).toBe('key-missing');}
  finally{await source.close();}
});

it.each([11000,5000])('recovers native identity starting at %s after projection failure without aliasing Hook context',async startedAtMs=>{
  let now=1000,wall=10000;
  let recovered:unknown=null;
  const source=createConversationSource({source:{read:async()=>{throw Error('source_unobserved');},
    discoverRunningTurn:async()=>({turnId:'native',startedAtMs,confirm:async()=>true}),remove(){},async close(){}},
    now:()=>now,wallNow:()=>wall,turnKeyFor:(_host,id)=>`key-${id}`,
    onChange:()=>{recovered=source.goals.takeover?.('session','key-missing')??recovered;}});
  source.attach('session','host','key-missing');now=3000;wall=12000;source.tick();await new Promise(resolve=>setImmediate(resolve));
  try{
    expect(recovered).toMatchObject({turnKey:'key-native',startedAtMs:startedAtMs-9000});
    expect(source.goals.read('session','key-missing',{goalSummary:null,activeSeconds:0,runtime:'running',previousEstimate:null})).toBeNull();
    expect(source.goals.read('session','key-native',{goalSummary:null,activeSeconds:0,runtime:'running',previousEstimate:null})).toBeNull();
  }finally{await source.close();}
});
it.each(['pause','rebind','remove','stop'] as const)('ignores a late discovery after %s',async action=>{
  let resolve!:(result:RunningTurnDiscovery)=>void,now=1000,wall=10000,calls=0;
  const source=createConversationSource({source:{read:async()=>{throw Error('source_unobserved');},
    discoverRunningTurn:()=>{calls++;return new Promise(done=>{resolve=done;});},remove(){},async close(){}},
    now:()=>now,wallNow:()=>wall,turnKeyFor:(_host,id)=>`key-${id}`});
  source.attach('session','host','key-missing');now=3000;wall=12000;source.tick();
  if(action==='pause')source.setActive('session',false);
  if(action==='rebind')source.attach('session','host','key-new');
  if(action==='remove')source.remove('session');
  if(action==='stop')source.stop('session');
  resolve({turnId:'native',startedAtMs:11000,confirm:async()=>true});await new Promise(done=>setImmediate(done));
  try{
    expect(source.goals.takeover?.('session','key-missing')).toBeNull();
    expect(source.turnKey('session')).not.toBe('key-native');
    if(action==='pause'||action==='stop'){now=10000;source.tick();expect(calls).toBe(1);}
  }finally{await source.close();}
});
it.each([false,true])('does not retain a stale or unconsumed discovery (confirmation %s)',async confirmed=>{
  let now=1000,wall=10000;
  const source=createConversationSource({source:{read:async()=>{throw Error('source_unobserved');},
    discoverRunningTurn:async()=>({turnId:'native',startedAtMs:5000,confirm:async()=>confirmed}),remove(){},async close(){}},
    now:()=>now,wallNow:()=>wall,turnKeyFor:(_host,id)=>`key-${id}`});
  source.attach('session','host','key-missing');now=3000;wall=12000;source.tick();await new Promise(resolve=>setImmediate(resolve));
  try{expect(source.goals.takeover?.('session','key-missing')).toBeNull();expect(source.turnKey('session')).toBe('key-missing');}
  finally{await source.close();}
});
