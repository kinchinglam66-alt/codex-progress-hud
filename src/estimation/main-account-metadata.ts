import type {Invocation} from './owned-process.js';
import {createMainAccountLease,type MainAccountSource} from './main-account-lease.js';
import {createObserverSessionProcess} from './observer-session-process.js';
import {authenticateMainAccountSession} from './main-account-session-auth.js';
import {observerRouteFingerprint} from './observer-route.js';
import type {MainAccountSessionTransport,OpenMainAccountSession} from './main-account-session-transport.js';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const label=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\p{Cc}\p{Cf}]/u.test(value);
/** Only metadata RPCs. The trusted caller must preflight this isolated,
 * ephemeral invocation; this reader never creates a model thread or turn. */
export function createMainAccountMetadataReader(options:{invocation:Invocation;source:MainAccountSource;processFactory?:typeof createObserverSessionProcess;openMainAccountSession?:OpenMainAccountSession}){
 let disabled=false,busy=false,poisoned=false;
 let owner:ReturnType<typeof createObserverSessionProcess>|undefined;
 let cancel:AbortController|undefined;
 const disable=()=>{disabled=true;cancel?.abort();owner?.disable();};
 async function read(signal:AbortSignal):Promise<{accountFingerprint:string;accountLabel:string;routeFingerprint:string;mainAccountSession?:MainAccountSessionTransport}>{
  if(disabled||busy||poisoned||signal.aborted)throw Error('MAIN_ACCOUNT_METADATA_UNAVAILABLE');
  busy=true;cancel=new AbortController();const guard=AbortSignal.any([signal,cancel.signal]);
  let lease:ReturnType<typeof createMainAccountLease>|undefined;
  let borrowed:MainAccountSessionTransport|undefined;
  const abort=()=>{owner?.disable();borrowed?.rpc.close('MAIN_ACCOUNT_METADATA_CANCELLED');};guard.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>cancel?.abort(),15000);
  try{
   const binding=await options.source.inspect(guard);guard.throwIfAborted();
   let rpc:MainAccountSessionTransport['rpc'];
   if(options.openMainAccountSession){
    borrowed=await options.openMainAccountSession(options.invocation,guard);guard.throwIfAborted();
    if(borrowed.invocation!==options.invocation||borrowed.lease.accountFingerprint!==binding.accountFingerprint||borrowed.lease.signal.aborted)
     throw Error('MAIN_ACCOUNT_TRANSPORT_MISMATCH');
    lease=borrowed.lease;rpc=borrowed.rpc;
   }else{
    lease=createMainAccountLease({source:options.source,accountFingerprint:binding.accountFingerprint,onInvalidated:abort});
    owner=(options.processFactory??createObserverSessionProcess)({onChatgptAuthTokensRefresh:lease.refresh});
    ({rpc}=await owner.start(options.invocation));guard.throwIfAborted();
    await rpc.call('initialize',{clientInfo:{name:'codex_progress_hud_account',version:'0.2.1'},capabilities:{experimentalApi:true}});
    rpc.notify('initialized',{});
   }
   const route=async()=>{
    const result=await rpc.call('config/read',{includeLayers:false});
    if(!object(result))throw Error();
    return observerRouteFingerprint(result.config,'ephemeral');
   };
   const routeFingerprint=await route();
   await authenticateMainAccountSession(rpc,lease,guard);
   const result=await rpc.call('account/read',{refreshToken:false});
   if(!object(result)||result.requiresOpenaiAuth!==true||!object(result.account)||result.account.type!=='chatgpt')throw Error();
   const accountLabel=label(result.account.email)?result.account.email:'ChatGPT（跟随主 Codex）';
   if(await route()!==routeFingerprint||!await lease.validate(guard))throw Error();
   guard.throwIfAborted();
   return {accountFingerprint:binding.accountFingerprint,accountLabel,routeFingerprint,...(borrowed?{mainAccountSession:borrowed}:{})};
  }catch{borrowed?.rpc.close('MAIN_ACCOUNT_METADATA_FAILED');throw Error('MAIN_ACCOUNT_METADATA_UNAVAILABLE');}
  finally{
   clearTimeout(timer);guard.removeEventListener('abort',abort);if(!borrowed)lease?.close();
   try{await owner?.close();}catch{poisoned=true;throw Error('MAIN_ACCOUNT_METADATA_CLOSE_UNCONFIRMED');}
   finally{busy=false;cancel=undefined;}
  }
 }
 return {read,disable,ownership:():'termination_failed'|'reading'|'idle'=>poisoned?'termination_failed':busy?'reading':'idle'};
}
