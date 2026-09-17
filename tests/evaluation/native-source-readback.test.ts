import {expect,it} from 'vitest';
import {compareFirstSourceUserReadback,collectSourceReadback} from '../../src/evaluation/native-source-readback.js';
const user=(text:string)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
const source=[user('original synthetic requirement CERULEAN-7421'),user('current repair')];
it('matches the original user message, not a marker echoed by an observer',()=>{
 const actual=[{type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'policy'}]}},...source];
 expect(compareFirstSourceUserReadback(source,actual)).toMatchObject({status:'observed',firstUserExact:true,sourceUserOccurrences:1});
 expect(compareFirstSourceUserReadback(source,[user('current repair'),{type:'response_item',payload:{type:'message',role:'assistant',content:source[0]!.payload.content}}])).toMatchObject({firstUserExact:false,sourceUserOccurrences:0});
});
it('distinguishes a later copy from the actual first user message',()=>{
 expect(compareFirstSourceUserReadback(source,[user('injected earlier user'),...source])).toMatchObject({firstUserExact:false,sourceUserOccurrences:1});
 expect(compareFirstSourceUserReadback(source,[source[0],source[0]])).toMatchObject({firstUserExact:true,sourceUserOccurrences:2});
});
it.each(['compacted','rollback'])('does not infer active model history from a rollout containing %s',kind=>{
 const event=kind==='compacted'?{type:'compacted',payload:{replacement_history:[]}}:{type:'event_msg',payload:{type:'thread_rolled_back',num_turns:1}};
 expect(compareFirstSourceUserReadback(source,[...source,event])).toMatchObject({status:'reconstruction_unverified',firstUserExact:null});
});
it('keeps raw user text out of evidence and detects missing source',()=>{
 const result=compareFirstSourceUserReadback(source,source);
 expect(JSON.stringify(result)).not.toContain('CERULEAN');
 expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
 expect(compareFirstSourceUserReadback([],source)).toMatchObject({status:'source_user_missing',firstUserExact:null});
 expect(compareFirstSourceUserReadback(source,[])).toMatchObject({status:'observed',firstUserExact:false,sourceUserOccurrences:0});
});
it('compares multimodal content and ignores transport message ids',()=>{
 const image={type:'input_image',image_url:'data:image/png;base64,AAAA'};
 const a={type:'response_item',payload:{type:'message',role:'user',id:'a',content:[{type:'input_text',text:'reference'},image]}};
 const b={...a,payload:{...a.payload,id:'b'}};
 expect(compareFirstSourceUserReadback([a],[b]).firstUserExact).toBe(true);
 expect(compareFirstSourceUserReadback([a],[{...b,payload:{...b.payload,content:[{...image,image_url:'data:image/png;base64,BBBB'}]}}]).firstUserExact).toBe(false);
});
it('preserves a bounded unavailable result and still reads the other owned target',async()=>{
 const results=await collectSourceReadback(source,[{role:'base',read:async()=>{throw Error('private path or raw data');}},{role:'child',read:async()=>source}]);
 expect(results).toHaveLength(2);
 expect(results[0]).toEqual({role:'base',status:'read_unavailable'});
 expect(results[1]).toMatchObject({role:'child',status:'observed',firstUserExact:true});
 expect(JSON.stringify(results)).not.toContain('private');
});
