import type {ObserverAppServerRpc} from './observer-app-server-rpc.js';
import type {createMainAccountLease} from './main-account-lease.js';
import {identityPreparationError,type IdentityPreparationCode} from './identity-preparation-error.js';

/** After experimental initialization, before importing history or creating a
 * model turn. Caller owns the trusted ephemeral invocation and process cleanup.
 * A local token decode is not proof that the remote session uses that account. */
export async function authenticateMainAccountSession(
 rpc:Pick<ObserverAppServerRpc,'call'|'close'>,
 lease:ReturnType<typeof createMainAccountLease>,signal:AbortSignal,
):Promise<void>{
 const guard=AbortSignal.any([signal,lease.signal]);
 const stop=()=>rpc.close('MAIN_ACCOUNT_SESSION_AUTH_FAILED');
 guard.addEventListener('abort',stop,{once:true});
 const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 let failureCode:IdentityPreparationCode='MAIN_AUTH_CREDENTIALS_FAILED';
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
  failureCode='MAIN_AUTH_RATE_LIMITS_FAILED';
  const remote=await rpc.call('account/rateLimits/read',{});
  guard.throwIfAborted();
  failureCode='MAIN_AUTH_IDENTITY_MISMATCH';
  if(!object(remote)||remote.accountId!==credentials.chatgptAccountId||!object(remote.rateLimits))throw Error('remote identity mismatch');
  failureCode='MAIN_AUTH_REVALIDATION_FAILED';
  if(!await lease.validate(guard))throw Error('stale account');
  guard.throwIfAborted();
 }catch{
  const cancelled=signal.aborted;
  lease.close();stop();
  throw identityPreparationError('MAIN_ACCOUNT_SESSION_AUTH_FAILED',cancelled?'MAIN_AUTH_CANCELLED':failureCode);
 }finally{
  guard.removeEventListener('abort',stop);
 }
}
