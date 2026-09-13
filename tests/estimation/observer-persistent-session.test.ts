import {expect,it} from 'vitest';
import {createPersistentObserverSession,type SessionRpc} from '../../src/estimation/observer-persistent-session.js';
import type {ObserverInput} from '../../src/estimation/observer-contract.js';
const input:ObserverInput={goalSummary:'current goal',runtime:'running',activeSeconds:10,messages:[{kind:'user',text:'goal',truncated:false}],truncated:false};
const answer={relation:'continue',status:'running',summary:'current goal',estimate:{remainingSeconds:90,errorPercent:20}};
const usage={totalTokens:110,inputTokens:100,outputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:2};
function fixture(options:{delayTurnStart?:boolean}={}){
 const listeners=new Set<(n:{method:string;params:Record<string,unknown>})=>void>();
 const calls:Array<{method:string;params:any}>=[];let count=0;
 const emit=(method:string,params:Record<string,unknown>)=>{for(const l of listeners)l({method,params});};
 let respond=(id:string)=>{
   emit('item/completed',{threadId:'thread',turnId:id,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(answer)}});
   emit('thread/tokenUsage/updated',{threadId:'thread',turnId:id,tokenUsage:{total:Object.fromEntries(Object.entries(usage).map(([k,v])=>[k,v*count])),last:usage}});
   emit('turn/completed',{threadId:'thread',turn:{id,status:'completed'}});
 };
 const rpc:SessionRpc={call:async(method,params:any)=>{calls.push({method,params});
   if(method==='thread/start')return {thread:{id:'thread'}};
   if(method==='turn/start'){const id=`turn-${++count}`;respond(id);if(options.delayTurnStart)await new Promise(resolve=>setTimeout(resolve,10));return {turn:{id}};}
   if(method==='turn/interrupt')emit('turn/completed',{threadId:'thread',turn:{id:params.turnId,status:'interrupted'}});
   return {};
 },subscribe:l=>{listeners.add(l);return()=>listeners.delete(l);}};
 return {rpc,calls,emit,setRespond:(f:typeof respond)=>{respond=f;},listeners};
}
it('retains acknowledged source history and thread across estimates without repeating imports',async()=>{
 const f=fixture(),s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{type:'object'}}),signal=new AbortController().signal;
 await s.start();await s.append([{ordinal:0,text:'duration=100'}],signal);
 const first=await s.estimate(input,signal);
 await s.append([{ordinal:0,text:'duration=100'},{ordinal:1,text:'new source turn, elapsed 10'}],signal);
 const second=await s.estimate({...input,goalSummary:'new goal'},signal);
 expect(first.interpretation).toEqual(answer);expect(second.usage?.inputTokens).toBe(100);
 expect(f.calls.filter(c=>c.method==='thread/start')).toHaveLength(1);
 expect(f.calls.filter(c=>c.method==='thread/inject_items')).toHaveLength(2);
 expect((f.calls.filter(c=>c.method==='turn/start').at(-1)!.params.input[0].text)).toContain('new goal');
 expect(f.listeners.size).toBe(0);
});
it('does not lose final messages when more than 256 notifications occur',async()=>{
 const f=fixture();f.setRespond(id=>{for(let i=0;i<600;i++)f.emit('item/completed',{threadId:'thread',turnId:id,item:{type:'reasoning'}});
 f.emit('item/completed',{threadId:'thread',turnId:id,item:{type:'agentMessage',text:JSON.stringify(answer)}});
 f.emit('turn/completed',{threadId:'thread',turn:{id,status:'completed'}});});
 const s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}});await s.start();
 const r=await s.estimate(input,new AbortController().signal);expect(r.interpretation).toEqual(answer);expect(r.usage).toBeNull();
});
it('rejects changed acknowledged history before importing again',async()=>{
 const f=fixture(),s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}}),signal=new AbortController().signal;await s.start();
 await s.append([{ordinal:0,text:'original'}],signal);
 await expect(s.append([{ordinal:0,text:'changed'}],signal)).rejects.toThrow('SOURCE_REWRITE');
 expect(f.calls.filter(c=>c.method==='thread/inject_items')).toHaveLength(1);
});
it('cancels a model operation without accepting its stale result and retains the thread',async()=>{
 const f=fixture(),controller=new AbortController();f.setRespond(()=>controller.abort());
 const s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}});await s.start();
 const r=await s.estimate(input,controller.signal);
 expect(r.interpretation).toBeNull();expect(r.cancelled).toBe(true);expect(r.terminalConfirmed).toBe(true);
 expect(f.calls.filter(c=>c.method==='turn/interrupt')).toHaveLength(1);expect(f.listeners.size).toBe(0);
});
it('retains anomalous compaction usage snapshots without treating them as complete usage',async()=>{
 const f=fixture();
 f.setRespond(id=>{
   f.emit('item/completed',{threadId:'thread',turnId:id,item:{type:'agentMessage',text:JSON.stringify(answer)}});
   f.emit('thread/tokenUsage/updated',{threadId:'thread',turnId:id,tokenUsage:{total:{totalTokens:6641,inputTokens:6597,outputTokens:44,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:21},last:{totalTokens:6641,inputTokens:6597,outputTokens:44,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:21}}});
   f.emit('thread/tokenUsage/updated',{threadId:'thread',turnId:id,tokenUsage:{total:{totalTokens:6641,inputTokens:6597,outputTokens:44,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:21},last:{totalTokens:9845,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}});
   f.emit('item/completed',{threadId:'thread',turnId:id,item:{type:'contextCompaction'}});
   f.emit('thread/tokenUsage/updated',{threadId:'thread',turnId:id,tokenUsage:{total:{totalTokens:13585,inputTokens:13499,outputTokens:86,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:40},last:{totalTokens:6944,inputTokens:6902,outputTokens:42,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:19}}});
   f.emit('turn/completed',{threadId:'thread',turn:{id,status:'completed'}});
 });
 const s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}});await s.start();
 const r=await s.estimate(input,new AbortController().signal);
 expect(r.usage).toBeNull();expect(r.compactions).toBe(1);expect(r.usageCompleteness).toBe('compaction_observed');
 expect(r.usageSnapshots).toHaveLength(3);
 expect(r.usageSnapshots[1]!.last.totalTokens).toBe(9845);
 expect(r.usageSnapshots[1]!.last.inputTokens).toBe(0);
});
it('records a gap when a token usage snapshot is malformed',async()=>{
 const f=fixture();f.setRespond(id=>{
   f.emit('thread/tokenUsage/updated',{threadId:'thread',turnId:id,tokenUsage:{total:{unexpected:true},last:null}});
   f.emit('turn/completed',{threadId:'thread',turn:{id,status:'completed'}});
 });
 const s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}});await s.start();
 const r=await s.estimate(input,new AbortController().signal);
 expect(r.usage).toBeNull();expect(r.usageCompleteness).toBe('malformed_snapshot');
 expect(r.usageGaps).toEqual([{observedAt:expect.any(Number),source:'thread/tokenUsage/updated',reason:'malformed_token_snapshot'}]);
});
it('rejects a usage evidence callback failure even after turn completion',async()=>{
 const f=fixture(),s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}});await s.start();
 await expect(s.estimate(input,new AbortController().signal,async()=>{throw Error('private journal detail');})).rejects.toMatchObject({
 code:'SESSION_USAGE_EVIDENCE_FAILED',turnId:'turn-1',reason:'usage_evidence_write_failed',terminalConfirmed:true
   ,terminalStatus:'completed'
 });
});
it('handles usage evidence failure before a delayed turn start acknowledgement',async()=>{
 const f=fixture({delayTurnStart:true}),s=createPersistentObserverSession(f.rpc,{cwd:'empty',outputSchema:{}});await s.start();
 await expect(s.estimate(input,new AbortController().signal,async()=>{throw Error('private journal detail');})).rejects.toMatchObject({
   code:'SESSION_USAGE_EVIDENCE_FAILED',turnId:'turn-1',reason:'usage_evidence_write_failed',terminalConfirmed:true,terminalStatus:'completed'
 });
});
