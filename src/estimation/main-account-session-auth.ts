import type {ObserverAppServerRpc} from './observer-app-server-rpc.js';
import type {createMainAccountLease} from './main-account-lease.js';
import {identityPreparationError,type IdentityPreparationCode} from './identity-preparation-error.js';

/** After experimental initialization, before importing history or creating a
 * model turn. Caller owns the trusted ephemeral invocation and process cleanup.
 * A local token decode is not proof that the remote session uses that account. */
export async function authenticateMainAccountSession(
 rpc:Pick<ObserverAppServerRpc,'call'|'close'|'subscribe'>,
 lease:ReturnType<typeof createMainAccountLease>,signal:AbortSignal,
):Promise<void>{
 const guard=AbortSignal.any([signal,lease.signal]);
 const stop=()=>rpc.close('MAIN_ACCOUNT_SESSION_AUTH_FAILED');
 guard.addEventListener('abort',stop,{once:true});
 const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 let failureCode:IdentityPreparationCode='MAIN_AUTH_CREDENTIALS_FAILED';
 let accountTransition:'pending'|'ready'|'failed'='pending';
 const transition=()=>accountTransition as 'pending'|'ready'|'failed';
 const unsubscribe=rpc.subscribe(notification=>{
  if(notification.method==='account/updated'&&object(notification.params)&&notification.params.authMode==='chatgpt')accountTransition='ready';
  if(notification.method==='account/login/completed'&&object(notification.params))
   accountTransition=notification.params.success===true?'ready':notification.params.success===false?'failed':accountTransition;
 });
 try{
  guard.throwIfAborted();
  const credentials=await lease.refresh({reason:'unauthorized'},guard);
  guard.throwIfAborted();
  failureCode='MAIN_AUTH_LOGIN_FAILED';
  const login=await rpc.call('account/login/start',{type:'chatgptAuthTokens',
   accessToken:credentials.accessToken,chatgptAccountId:credentials.chatgptAccountId,
   ...(credentials.chatgptPlanType==null?{}:{chatgptPlanType:credentials.chatgptPlanType})});
  guard.throwIfAborted();
  if(!object(login)||login.type!=='chatgptAuthTokens')throw Error('unexpected login');
  // New app-server builds publish the account transition asynchronously. Do
  // not race authenticated RPCs against that transition; older builds that do
  // not notify remain bounded by this one-time startup delay.
  if(transition()==='pending')await new Promise<void>((resolve,reject)=>{
   const aborted=()=>{clearInterval(poll);clearTimeout(timer);guard.removeEventListener('abort',aborted);reject(Error('cancelled'));};
   const finish=()=>{clearInterval(poll);clearTimeout(timer);guard.removeEventListener('abort',aborted);resolve();};
   const poll=setInterval(()=>{if(transition()!=='pending')finish();},10);poll.unref?.();
   const timer=setTimeout(finish,2000);timer.unref?.();
   guard.addEventListener('abort',aborted,{once:true});if(guard.aborted)aborted();
  });
  if(transition()==='failed')throw Error('account login failed');
  failureCode='MAIN_AUTH_RATE_LIMITS_FAILED';
  let remote:unknown;
  try{remote=await rpc.call('account/rateLimits/read',{});}
  catch{
   // Some qualified app-server builds can authenticate an externally supplied
   // ChatGPT session while their usage endpoint is temporarily unavailable.
   // Fall back only to a second authenticated server RPC; login success alone
   // is never sufficient, and the local lease is still revalidated below.
   failureCode='MAIN_AUTH_ACCOUNT_READ_FAILED';
   const account=await rpc.call('account/read',{refreshToken:false});
   if(!object(account)||account.requiresOpenaiAuth!==true||!object(account.account)||account.account.type!=='chatgpt')throw Error('remote account unavailable');
   remote=null;
  }
  guard.throwIfAborted();
  if(remote!==null){
   failureCode='MAIN_AUTH_IDENTITY_MISMATCH';
   if(!object(remote)||remote.accountId!==credentials.chatgptAccountId||!object(remote.rateLimits))throw Error('remote identity mismatch');
  }
  failureCode='MAIN_AUTH_REVALIDATION_FAILED';
  if(!await lease.validate(guard))throw Error('stale account');
  guard.throwIfAborted();
 }catch{
  const cancelled=signal.aborted;
  lease.close();stop();
  throw identityPreparationError('MAIN_ACCOUNT_SESSION_AUTH_FAILED',cancelled?'MAIN_AUTH_CANCELLED':failureCode);
 }finally{
  unsubscribe();
  guard.removeEventListener('abort',stop);
 }
}
