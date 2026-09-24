import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

// Local metadata only: never serialize this ID into the model input or use it
// as an authorization/accounting capability. Signal lifetime bounds ownership.
const requests=new WeakMap<AbortSignal,string>();
const context=new AsyncLocalStorage<string>();
export function requestCorrelation(signal:AbortSignal):string {
  let id=requests.get(signal);
  if(!id){id=randomUUID();requests.set(signal,id);}
  return id;
}
export function withRequestCorrelation<T>(signal:AbortSignal,work:()=>T):T {
  return context.run(requestCorrelation(signal),work);
}
export function currentRequestCorrelation():string|undefined{return context.getStore();}
export function projectRequestCorrelation(value:unknown):string|undefined {
  return typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)?value:undefined;
}
