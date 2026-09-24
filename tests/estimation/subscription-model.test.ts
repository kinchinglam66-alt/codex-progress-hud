import {it,expect,vi} from 'vitest';
import {resolveSubscriptionModel,assertSubscriptionModelAvailable,inspectSubscriptionModelAvailable,subscriptionModels} from '../../src/estimation/subscription-model.js';
it('keeps the installed default and rejects unconfigured aliases',()=>{
 expect(resolveSubscriptionModel()).toBe('gpt-5.6-luna');
 for(const model of subscriptionModels)expect(resolveSubscriptionModel(model)).toBe(model);
 for(const value of ['latest','gpt-6-astra-latest','gpt-6-sol\n',null,{}])expect(()=>resolveSubscriptionModel(value)).toThrow('SUBSCRIPTION_MODEL_INVALID');
});
it.each([
 [{data:[]},'model_not_listed'],
 [{data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]},'effort_not_listed'],
 [{data:[{model:'gpt-6-sol',supportedReasoningEfforts:null}]},'entry_invalid'],
 [{data:[null]},'entry_invalid'],
])('retains safe failure detail without changing the error code',async(response,reason)=>{
 const rpc={call:async()=>response};
 expect((await inspectSubscriptionModelAvailable(rpc,'gpt-6-sol')).reason).toBe(reason);
 await expect(assertSubscriptionModelAvailable(rpc,'gpt-6-sol')).rejects.toMatchObject({message:'SUBSCRIPTION_MODEL_UNAVAILABLE',diagnostic:{reason}});
});
it('does not expose arbitrary metadata and preserves a valid supported match',async()=>{
 const result=await inspectSubscriptionModelAvailable({call:async()=>({data:[null,{model:'gpt-6-sol',secret:'private',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]})},'gpt-6-sol');
 expect(result).toMatchObject({reason:'supported',pages:1,entries:2,matches:1,invalidEntries:1});
 expect(JSON.stringify(result)).not.toContain('private');
});
it('checks the exact model and medium on subsequent metadata pages',async()=>{
 const call=vi.fn().mockResolvedValueOnce({data:[],nextCursor:'page2'}).mockResolvedValueOnce({data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null});
 await assertSubscriptionModelAvailable({call},'gpt-6-sol');expect(call).toHaveBeenCalledTimes(2);
 expect(call.mock.calls.every(c=>c[0]==='model/list')).toBe(true);
});
it.each([
 {data:[{model:'gpt-5.6-luna',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]},
 {data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]},
])('does not substitute another model or reasoning effort',async response=>{
 await expect(assertSubscriptionModelAvailable({call:async()=>response},'gpt-6-sol')).rejects.toThrow('SUBSCRIPTION_MODEL_UNAVAILABLE');
});
it('rejects malformed or looping model lists',async()=>{
 await expect(assertSubscriptionModelAvailable({call:async()=>({data:null})},'gpt-6-sol')).rejects.toThrow('SUBSCRIPTION_MODEL_LIST_INVALID');
 await expect(assertSubscriptionModelAvailable({call:async()=>({data:[],nextCursor:'same'})},'gpt-6-sol')).rejects.toThrow('SUBSCRIPTION_MODEL_LIST_INVALID');
});
