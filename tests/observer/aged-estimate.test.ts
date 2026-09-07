import {expect,it} from 'vitest';
import {createConversationSource} from '../../src/observer/conversation-source.js';
import {PassiveGoals} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';

const answer={relation:'replace',status:'running',summary:'obsolete summary',estimate:{remainingSeconds:100,errorPercent:50}};
async function setup(){
  let now=0,records:ConversationRecord[]=[{id:'user',turnId:'current',atMs:0,kind:'user',text:'Implement the requested report'}];
  const envelope=normalizeHookInput('UserPromptSubmit',{session_id:'session',turn_id:'current'},0,
    'aged-source-test-token-123456789012345').envelope;
  const source=createConversationSource({now:()=>now,wallNow:()=>now,turnKeyFor:(_host,turn)=>turn==='current'?envelope.turnKey!:turn,
    source:{read:async()=>({records,caughtUp:true,partialLine:false,reset:false}),remove:()=>{},close:async()=>{}}});
  const goals=new PassiveGoals(new PassiveContextStore(),source.goals);
  source.attach(envelope.sessionKey,'session',envelope.turnKey!);goals.observe(envelope,true,0);
  async function advance(next:ConversationRecord[]){records=next;now+=5500;source.tick();await new Promise<void>(r=>setImmediate(r));}
  await advance(records);
  return {source,goals,envelope,advance};
}
it('displays an aged first numeric prediction without applying obsolete goal semantics',async()=>{
  const f=await setup();try{
    const request=f.goals.request(f.envelope.sessionKey,15000)!;
    await f.advance([{id:'tool',turnId:'current',atMs:16000,kind:'tool_result',text:'progress made'}]);
    expect(f.goals.settle(request.ticket,answer,20000)).toBe(true);
    expect(f.goals.view(f.envelope.sessionKey,20000)).toMatchObject({generation:0,status:'unknown',
      prediction:{remainingSeconds:100,errorPercent:50,observedActiveSeconds:15}});
    expect(f.goals.request(f.envelope.sessionKey,21000)?.input.goalSummary).toBeNull();
  }finally{await f.source.close();}
});
it('rejects an aged estimate when persisted user instructions changed even before a hook arrives',async()=>{
  const f=await setup();try{
    const request=f.goals.request(f.envelope.sessionKey,15000)!;
    await f.advance([{id:'amendment',turnId:'current',atMs:16000,kind:'user',text:'Change the target to another report'}]);
    expect(f.goals.settle(request.ticket,answer,20000)).toBe(false);
    expect(f.goals.view(f.envelope.sessionKey,20000)?.prediction).toBeNull();
  }finally{await f.source.close();}
});
it('never applies stale completion even while the host is waiting',async()=>{
  const f=await setup();try{
    f.goals.runtime(f.envelope.sessionKey,f.envelope.turnKey!,'waiting',14000);
    const request=f.goals.request(f.envelope.sessionKey,15000)!;
    await f.advance([{id:'tool',turnId:'current',atMs:16000,kind:'tool_result',text:'new result'}]);
    expect(f.goals.settle(request.ticket,{...answer,status:'completed',estimate:null},20000)).toBe(false);
    expect(f.goals.view(f.envelope.sessionKey,20000)?.status).not.toBe('completed');
  }finally{await f.source.close();}
});
it('rejects old numeric snapshots if a new-turn user message precedes its hook without leaking that message',async()=>{
  const f=await setup();try{
    const request=f.goals.request(f.envelope.sessionKey,15000)!;
    await f.advance([{id:'new-turn-user',turnId:'next',atMs:16000,kind:'user',text:'Different objective'}]);
    expect(f.goals.settle(request.ticket,answer,20000)).toBe(false);
    expect(f.goals.view(f.envelope.sessionKey,20000)?.prediction).toBeNull();
    expect(f.goals.request(f.envelope.sessionKey,21000)?.input.messages.some(m=>m.text==='Different objective')).toBe(false);
  }finally{await f.source.close();}
});
it.each(['stopped','interrupted','paused'] as const)('does not revive an aged prediction after %s',async state=>{
  const f=await setup();try{
    const request=f.goals.request(f.envelope.sessionKey,15000)!;
    await f.advance([{id:'tool',turnId:'current',atMs:16000,kind:'tool_result',text:'progress'}]);
    f.goals.runtime(f.envelope.sessionKey,f.envelope.turnKey!,state,17000);
    expect(f.goals.settle(request.ticket,answer,20000)).toBe(false);
    expect(f.goals.view(f.envelope.sessionKey,20000)?.prediction).toBeNull();
  }finally{await f.source.close();}
});
