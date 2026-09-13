import {expect,it} from 'vitest';
import {parseCodexCheckpoint} from '../../src/observer/codex-checkpoint.js';

function fixture(){return {type:'compacted',payload:{message:'',replacement_history:[
  {type:'message',role:'user',content:[{type:'input_text',text:'Keep retained request'},{type:'input_image',image_url:'data:image/png;base64,AA=='}]},
  {type:'compaction',id:'opaque-item',encrypted_content:'opaque-native-content'},
  {type:'message',role:'developer',content:[{type:'input_text',text:'Source instruction data'}]}
],guardian_history:[{private:'must not replace canonical window'}]}};}

it('preserves the complete native window including opaque summary and images without lifting guardian history',()=>{
 const source=fixture();
 const result:any=parseCodexCheckpoint(source);
 expect(result).toMatchObject({kind:'native_compacted_window',sourceRepresentation:'upstream_compacted',itemCount:3,encryptedSummaryCount:1});
 expect(result.items).toEqual(source.payload.replacement_history);
 expect(JSON.stringify(result.items)).not.toContain('must not replace');
 expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
 expect(result.encodedBytes).toBe(Buffer.byteLength(JSON.stringify(source.payload.replacement_history)));
});

it('does not expose mutable aliases into the original parsed source',()=>{
 const source=fixture(),result:any=parseCodexCheckpoint(source);
 source.payload.replacement_history[1]!.encrypted_content='changed';
 expect(result.items[1].encrypted_content).toBe('opaque-native-content');
});

it('returns no checkpoint for ordinary events',()=>{
 expect(parseCodexCheckpoint({type:'event_msg',payload:{type:'task_started'}})).toBeNull();
});

it.each([
 {type:'compacted',payload:{}},
 {type:'compacted',payload:{replacement_history:[]}},
 {type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:''}]}},
 {type:'compacted',payload:{replacement_history:[{type:'message',role:'user',content:[{type:'input_text',text:'no summary'}]}]}},
 {type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'opaque'},{type:'future_item',value:'must not silently discard'}]}}
])('rejects unusable checkpoints instead of silently dropping unsupported context %#',source=>{
 expect(()=>parseCodexCheckpoint(source)).toThrow('CHECKPOINT_UNSUPPORTED');
});

it('binds fingerprint to the encrypted content and retained messages',()=>{
 const first:any=parseCodexCheckpoint(fixture()),changed=fixture();
 changed.payload.replacement_history[1]!.encrypted_content='different-opaque';
 expect((parseCodexCheckpoint(changed) as any).fingerprint).not.toBe(first.fingerprint);
});
