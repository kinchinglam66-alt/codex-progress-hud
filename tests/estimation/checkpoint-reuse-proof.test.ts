import {expect,it} from 'vitest';
import {captureCheckpointReuseProof,checkpointPrefixReusable,type CheckpointReuseProof} from '../../src/estimation/checkpoint-reuse-proof.js';
import {parseCodexCheckpoint} from '../../src/observer/codex-checkpoint.js';
import type {VerifiedHistoryFallback} from '../../src/observer/verified-history-fallback.js';
const proof=():CheckpointReuseProof=>({key:'task',generation:1,turn:'turn',identity:'file',epoch:1,revision:2,checkpoint:'digest',records:['a','b']});
it('requires complete accepted ordered prefix and allows only appended records',()=>{
 expect(checkpointPrefixReusable(proof(),{...proof(),revision:3,records:['a','b','c']},1)).toBe(true);
 expect(checkpointPrefixReusable(proof(),proof(),1)).toBe(true);
 expect(checkpointPrefixReusable(proof(),proof(),null)).toBe(false);
 expect(checkpointPrefixReusable(proof(),proof(),0)).toBe(false);
 expect(checkpointPrefixReusable(proof(),proof(),2)).toBe(false);
 expect(checkpointPrefixReusable(null,proof(),1)).toBe(false);
 expect(checkpointPrefixReusable(proof(),{...proof(),records:['a','b','c']},1)).toBe(false);
});
it.each(['key','generation','turn','identity','epoch','revision','checkpoint','records'] as const)('rejects changed %s',field=>{
 const value={...proof(),[field]:field==='generation'||field==='epoch'?2:field==='revision'?1:field==='records'?['b','a']:'other'};
 expect(checkpointPrefixReusable(proof(),value,1)).toBe(false);
});
it('rejects truncated histories',()=>expect(checkpointPrefixReusable(proof(),{...proof(),records:['a']},1)).toBe(false));
it.each(['valid','gap','changed','cancelled','incomplete'] as const)('captures immutable bounded proof: %s',async(mode)=>{
 const controller=new AbortController();
 const checkpoint=parseCodexCheckpoint({type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'opaque'}]}})!;
 const history:VerifiedHistoryFallback={currentTurnId:'turn',validate:async()=>{},snapshot:{identity:'file',sourceEpoch:1,revision:1,checkpoint,
  coverage:{complete:mode!=='incomplete',gaps:[]},close:async()=>{},async *records(){
   if(mode==='cancelled')controller.abort();
   yield {ordinal:mode==='gap'?2:0,record:{id:'a',kind:'user',turnId:'turn',atMs:0,text:'private text'}};
   if(mode==='changed')history.snapshot.revision++;
  }}};
 const pending=captureCheckpointReuseProof(history,'task',1,controller.signal);
 if(mode!=='valid'){await expect(pending).rejects.toThrow();return;}
 const captured=await pending;expect(captured?.records).toHaveLength(1);
 expect(Object.isFrozen(captured)).toBe(true);expect(Object.isFrozen(captured?.records)).toBe(true);
 expect(JSON.stringify(captured)).not.toContain('private text');
});
