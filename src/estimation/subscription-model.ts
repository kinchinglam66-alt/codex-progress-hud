/** Host configuration only; never derive model selection from source messages. */
export const subscriptionModels=['gpt-5.6-luna','gpt-5.6-sol','gpt-6-luna','gpt-6-sol','gpt-6-astra'] as const;
export type SubscriptionModel=typeof subscriptionModels[number];
export const defaultSubscriptionModel:SubscriptionModel='gpt-5.6-luna';
export const subscriptionEffort='medium' as const;
export function resolveSubscriptionModel(value:unknown=defaultSubscriptionModel):SubscriptionModel {
 if(typeof value!=='string'||!subscriptionModels.includes(value as SubscriptionModel))throw Error('SUBSCRIPTION_MODEL_INVALID');
 return value as SubscriptionModel;
}
export type SubscriptionModelDiagnostic={model:SubscriptionModel;effort:'medium';pages:number;entries:number;matches:number;invalidEntries:number;reason:'supported'|'model_not_listed'|'effort_not_listed'|'entry_invalid'};
/** Bounded metadata only: no account fields, raw responses or arbitrary strings. */
export async function inspectSubscriptionModelAvailable(rpc:{call(method:string,params:unknown):Promise<unknown>},model:SubscriptionModel):Promise<SubscriptionModelDiagnostic>{
 resolveSubscriptionModel(model);
 let cursor:string|undefined;const seen=new Set<string>();let found=false;
 const diagnostic:SubscriptionModelDiagnostic={model,effort:subscriptionEffort,pages:0,entries:0,matches:0,invalidEntries:0,reason:'model_not_listed'};
 for(let page=0;page<20;page++){
  const response=await rpc.call('model/list',{limit:100,includeHidden:true,...(cursor?{cursor}:{})}) as {data?:Array<{model?:string;supportedReasoningEfforts?:Array<{reasoningEffort?:string}>}>;nextCursor?:unknown}|null;
  if(!response||!Array.isArray(response.data))throw Error('SUBSCRIPTION_MODEL_LIST_INVALID');
  diagnostic.pages++;diagnostic.entries+=response.data.length;
  for(const entry of response.data){
   if(!entry||typeof entry.model!=='string'){diagnostic.invalidEntries++;continue;}
   if(entry.model!==model)continue;
   diagnostic.matches++;
   if(!Array.isArray(entry.supportedReasoningEfforts)){diagnostic.invalidEntries++;continue;}
   for(const effort of entry.supportedReasoningEfforts){
    if(!effort||typeof effort.reasoningEffort!=='string'){diagnostic.invalidEntries++;continue;}
    if(effort.reasoningEffort===subscriptionEffort)found=true;
   }
  }
  if(response.nextCursor===null||response.nextCursor===undefined){
   diagnostic.reason=found?'supported':diagnostic.invalidEntries?'entry_invalid':diagnostic.matches?'effort_not_listed':'model_not_listed';
   return diagnostic;
  }
  if(typeof response.nextCursor!=='string'||!response.nextCursor||seen.has(response.nextCursor))throw Error('SUBSCRIPTION_MODEL_LIST_INVALID');
  cursor=response.nextCursor;seen.add(cursor);
 }
 throw Error('SUBSCRIPTION_MODEL_LIST_INCOMPLETE');
}
/** Preserve the legacy error code while retaining a safe detailed cause. */
export async function assertSubscriptionModelAvailable(rpc:{call(method:string,params:unknown):Promise<unknown>;modelCatalogTimeoutCount?:()=>number},model:SubscriptionModel,signal?:AbortSignal):Promise<void>{
 const attempts:Array<SubscriptionModelDiagnostic&{elapsedMs:number;catalogTimedOut:boolean}>=[];
 for(let attempt=0;attempt<4;attempt++){
  signal?.throwIfAborted();
  const before=rpc.modelCatalogTimeoutCount?.()??0,started=Date.now();
  const diagnostic=await inspectSubscriptionModelAvailable(rpc,model);
  signal?.throwIfAborted();
  const catalogTimedOut=(rpc.modelCatalogTimeoutCount?.()??0)>before;
  attempts.push({...diagnostic,elapsedMs:Date.now()-started,catalogTimedOut});
  if(diagnostic.reason==='supported')return;
  // Only a fresh catalog timeout can justify each additional metadata query.
  // Never retry an RPC rejection, invalid entry, or missing reasoning effort.
  if(diagnostic.reason!=='model_not_listed'||!catalogTimedOut||attempt===3)
   throw Object.assign(Error('SUBSCRIPTION_MODEL_UNAVAILABLE'),{diagnostic,attempts,transient:diagnostic.reason==='model_not_listed'&&catalogTimedOut});
 }
}
