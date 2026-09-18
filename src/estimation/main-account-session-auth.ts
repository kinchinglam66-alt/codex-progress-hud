import type {ObserverAppServerRpc} from './observer-app-server-rpc.js';
import type {createMainAccountLease} from './main-account-lease.js';

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
 try{
  guard.throwIfAborted();
  const credentials=await lease.refresh({reason:'unauthorized'},guard);
  guard.throwIfAborted();
  const login=await rpc.call('account/login/start',{type:'chatgptAuthTokens',
   accessToken:credentials.accessToken,chatgptAccountId:credentials.chatgptAccountId,
   ...(credentials.chatgptPlanType==null?{}:{chatgptPlanType:credentials.chatgptPlanType})});
  guard.throwIfAborted();
  if(!object(login)||login.type!=='chatgptAuthTokens')throw Error('unexpected login');
  const remote=await rpc.call('account/rateLimits/read',{});
  guard.throwIfAborted();
  if(!object(remote)||remote.accountId!==credentials.chatgptAccountId||!object(remote.rateLimits))throw Error('remote identity mismatch');
  if(!await lease.validate(guard))throw Error('stale account');
  guard.throwIfAborted();
 }catch{
  lease.close();stop();
  throw Error('MAIN_ACCOUNT_SESSION_AUTH_FAILED');
 }finally{
  guard.removeEventListener('abort',stop);
 }
}
