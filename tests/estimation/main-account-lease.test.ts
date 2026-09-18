import {afterEach,describe,expect,it,vi} from 'vitest';
import {createMainAccountLease} from '../../src/estimation/main-account-lease.js';

const fingerprint='a'.repeat(64);
function fixture(){
  let identity=fingerprint,token='first',failed=false;
  const changes:string[]=[];
  const source={inspect:async()=>{if(failed)throw Error('unavailable');return {accountFingerprint:identity,expiresAt:Date.now()+600000};},
    credentials:async(expected:string)=>{if(expected!==identity)throw Error('MAIN_ACCOUNT_CHANGED');return {accessToken:token,chatgptAccountId:'account-a'};}};
  const lease=createMainAccountLease({source,accountFingerprint:fingerprint,onInvalidated:reason=>changes.push(reason)});
  return {lease,source,changes,setIdentity:(value:string)=>{identity=value;},setToken:(value:string)=>{token=value;},logout:()=>{failed=true;}};
}
afterEach(()=>vi.useRealTimers());
describe('main account session lease',()=>{
  it('keeps a session alive through same-account refresh and binds omitted previous account IDs',async()=>{
    const f=fixture();f.setToken('second');
    expect(await f.lease.refresh({reason:'unauthorized'},new AbortController().signal)).toEqual({accessToken:'second',chatgptAccountId:'account-a'});
    expect(f.lease.signal.aborted).toBe(false);expect(f.changes).toEqual([]);f.lease.close();
  });
  it('invalidates once when polling observes an account switch',async()=>{
    vi.useFakeTimers();const f=fixture();f.setIdentity('b'.repeat(64));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.lease.signal.aborted).toBe(true);expect(f.changes).toEqual(['account_changed']);
    expect(await f.lease.validate()).toBe(false);await vi.advanceTimersByTimeAsync(6000);expect(f.changes).toHaveLength(1);
  });
  it('invalidates old sessions on logout and never returns a different account token',async()=>{
    const f=fixture();f.logout();expect(await f.lease.validate()).toBe(false);
    expect(f.changes).toEqual(['account_unavailable']);
    await expect(f.lease.refresh({reason:'unauthorized'},new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_LEASE_CLOSED');
    const changed=fixture();changed.setIdentity('b'.repeat(64));
    await expect(changed.lease.refresh({reason:'unauthorized'},new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_CHANGED');
    expect(changed.lease.signal.aborted).toBe(true);
  });
  it('rejects an unrelated previous account ID and cancels the lease',async()=>{
    const f=fixture();await expect(f.lease.refresh({reason:'unauthorized',previousAccountId:'other'},new AbortController().signal)).rejects.toThrow('MAIN_ACCOUNT_CHANGED');
    expect(f.lease.signal.aborted).toBe(true);
  });
  it('discards refresh results delivered after close',async()=>{
    let deliver!:(value:any)=>void;const source={inspect:async()=>({accountFingerprint:fingerprint,expiresAt:Date.now()+1000}),
      credentials:async()=>new Promise<any>(resolve=>{deliver=resolve;})};
    const lease=createMainAccountLease({source,accountFingerprint:fingerprint});
    const pending=lease.refresh({reason:'unauthorized'},new AbortController().signal);
    lease.close();deliver({accessToken:'late',chatgptAccountId:'account-a'});
    await expect(pending).rejects.toThrow('MAIN_ACCOUNT_LEASE_CLOSED');
  });
  it('operation cancellation does not permanently invalidate an unchanged account',async()=>{
    const f=fixture(),controller=new AbortController();controller.abort();
    expect(await f.lease.validate(controller.signal)).toBe(false);expect(f.lease.signal.aborted).toBe(false);
    expect(await f.lease.validate()).toBe(true);f.lease.close();
  });
});
