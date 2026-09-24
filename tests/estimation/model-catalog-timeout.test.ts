import {it,expect,vi} from 'vitest';
import {createModelCatalogTimeoutReader} from '../../src/estimation/model-catalog-timeout.js';
import {assertSubscriptionModelAvailable} from '../../src/estimation/subscription-model.js';
const supported={data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
it('bounds and discards raw stderr, ignores unrelated timeout and handles split lines',()=>{
 const reader=createModelCatalogTimeoutReader();
 reader.push(Buffer.from('network timeout secret\nmodels_manager time'));
 reader.push(Buffer.from('out private-token\n'));
 expect(reader.count()).toBe(1);
 reader.push(Buffer.from('x'.repeat(8193)+'models_manager timeout\n'));
 expect(reader.count()).toBe(1);
 expect(JSON.stringify(reader)).not.toContain('private');
});
it.each([1,2,3])('recovers after %i fresh timeout metadata failures only',async failures=>{
 let count=0;
 const call=vi.fn(async(method:string,_params:unknown)=>{expect(method).toBe('model/list');if(count<failures){count++;return {data:[]};}return supported;});
 await assertSubscriptionModelAvailable({call,modelCatalogTimeoutCount:()=>count},'gpt-6-sol');
 expect(call).toHaveBeenCalledTimes(failures+1);
 expect(call.mock.calls.every(c=>c.length===2)).toBe(true);
});
it('caps supplemental checks at three and preserves bounded diagnostic attempts',async()=>{
 let count=0;const call=vi.fn(async()=>{count++;return {data:[]};});
 await expect(assertSubscriptionModelAvailable({call,modelCatalogTimeoutCount:()=>count},'gpt-6-sol')).rejects.toMatchObject({transient:true,attempts:Array.from({length:4},()=>expect.objectContaining({catalogTimedOut:true}))});
 expect(call).toHaveBeenCalledTimes(4);
});
it('does not reuse an old timeout to justify another query',async()=>{
 const call=vi.fn(async()=>({data:[]}));
 await expect(assertSubscriptionModelAvailable({call,modelCatalogTimeoutCount:()=>1},'gpt-6-sol')).rejects.toMatchObject({transient:false});
 expect(call).toHaveBeenCalledTimes(1);
});
it.each([{data:null},{data:[null]},{data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}])('does not retry malformed entries or effort mismatch',async response=>{
 let count=0;const call=vi.fn(async()=>{count++;return response;});
 await expect(assertSubscriptionModelAvailable({call,modelCatalogTimeoutCount:()=>count},'gpt-6-sol')).rejects.toThrow();
 expect(call).toHaveBeenCalledTimes(1);
});
it('propagates authorization rejection without retry even with a timeout hint',async()=>{
 let count=0;const error=Error('DENIED');const call=vi.fn(async()=>{count++;throw error;});
 await expect(assertSubscriptionModelAvailable({call,modelCatalogTimeoutCount:()=>count},'gpt-6-sol')).rejects.toBe(error);
 expect(call).toHaveBeenCalledTimes(1);
});
it('honors cancellation before and after metadata without dispatching another query',async()=>{
 const controller=new AbortController();let count=0;
 const call=vi.fn(async()=>{count++;controller.abort();return {data:[]};});
 await expect(assertSubscriptionModelAvailable({call,modelCatalogTimeoutCount:()=>count},'gpt-6-sol',controller.signal)).rejects.toThrow();
 await expect(assertSubscriptionModelAvailable({call},'gpt-6-sol',controller.signal)).rejects.toThrow();
 expect(call).toHaveBeenCalledTimes(1);
});
it('does not share timeout evidence across simultaneous sessions',async()=>{
 let count=0;
 const a=vi.fn(async()=>{if(count===0){count++;return {data:[]};}return supported;});
 const b=vi.fn(async()=>({data:[]}));
 const results=await Promise.allSettled([
  assertSubscriptionModelAvailable({call:a,modelCatalogTimeoutCount:()=>count},'gpt-6-sol'),
  assertSubscriptionModelAvailable({call:b,modelCatalogTimeoutCount:()=>0},'gpt-6-sol'),
 ]);
 expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
 expect(a).toHaveBeenCalledTimes(2);expect(b).toHaveBeenCalledTimes(1);
});
