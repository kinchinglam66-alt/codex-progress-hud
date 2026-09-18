import type {MainCodexAccountSnapshot} from './main-codex-account-source.js';
import type {ChatgptAuthRefreshHandler,ChatgptAuthRefreshResult} from './observer-auth-refresh-rpc.js';

export interface MainAccountSource {
  inspect(signal?:AbortSignal):Promise<MainCodexAccountSnapshot>;
  credentials(expectedFingerprint:string,signal?:AbortSignal):Promise<ChatgptAuthRefreshResult>;
}
export type MainAccountInvalidation='account_changed'|'account_unavailable';

/** One account binding for one private session. It never authenticates or
 * creates another session. The provider owner must retire old work and open a
 * fresh binding; a refresh is never a way to move an old request to a new user.
 */
export function createMainAccountLease(options:{source:MainAccountSource;accountFingerprint:string;
  pollIntervalMs?:number;onInvalidated?:(reason:MainAccountInvalidation)=>void}) {
  if(!/^[a-f0-9]{64}$/.test(options.accountFingerprint))throw Error('MAIN_ACCOUNT_BINDING_INVALID');
  const interval=options.pollIntervalMs??2000;
  if(!Number.isSafeInteger(interval)||interval<100||interval>30000)throw Error('MAIN_ACCOUNT_POLL_INTERVAL_INVALID');
  const lifetime=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const close=()=>{clearTimeout(timer);timer=undefined;lifetime.abort();};
  const invalidate=(reason:MainAccountInvalidation)=>{
    if(lifetime.signal.aborted)return;
    close();try{options.onInvalidated?.(reason);}catch{/* Invalidation remains authoritative. */}
  };
  const combined=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
  const check=(signal:AbortSignal)=>{
    if(lifetime.signal.aborted)throw Error('MAIN_ACCOUNT_LEASE_CLOSED');
    if(signal.aborted)throw Error('MAIN_ACCOUNT_CANCELLED');
  };
  const validate=async(signal?:AbortSignal):Promise<boolean>=>{
    const guard=combined(signal);
    if(guard.aborted)return false;
    try {
      const current=await options.source.inspect(guard);
      if(guard.aborted)return false;
      if(current.accountFingerprint!==options.accountFingerprint){invalidate('account_changed');return false;}
      return true;
    } catch {
      if(!guard.aborted)invalidate('account_unavailable');
      return false;
    }
  };
  const refresh:ChatgptAuthRefreshHandler=async(params,signal)=>{
    const guard=combined(signal);check(guard);
    try {
      const value=await options.source.credentials(options.accountFingerprint,guard);
      check(guard);
      if(params.previousAccountId!=null&&params.previousAccountId!==value.chatgptAccountId){
        invalidate('account_changed');throw Error('MAIN_ACCOUNT_CHANGED');
      }
      if(!await validate(guard)){check(guard);throw Error('MAIN_ACCOUNT_UNAVAILABLE');}
      check(guard);return value;
    } catch(error) {
      if(!guard.aborted){invalidate(error instanceof Error&&error.message==='MAIN_ACCOUNT_CHANGED'?'account_changed':'account_unavailable');}
      if(error instanceof Error&&['MAIN_ACCOUNT_CHANGED','MAIN_ACCOUNT_LEASE_CLOSED','MAIN_ACCOUNT_CANCELLED'].includes(error.message))throw error;
      throw Error('MAIN_ACCOUNT_UNAVAILABLE');
    }
  };
  const schedule=()=>{
    if(lifetime.signal.aborted)return;
    timer=setTimeout(()=>{timer=undefined;void validate().finally(schedule);},interval);
    timer.unref?.();
  };
  schedule();
  return {accountFingerprint:options.accountFingerprint,signal:lifetime.signal,validate,refresh,close};
}
