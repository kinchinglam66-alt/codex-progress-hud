import {afterEach,expect,it,vi} from 'vitest';
import {createMainAccountFollower} from '../../src/desktop/main-account-follower.js';
afterEach(()=>vi.useRealTimers());
it('checks locally without rebuilding same-account sessions and follows a changed account',async()=>{
 vi.useFakeTimers();let actual='a',bound:string|null='a',reads=0,refreshes=0,enabled=true;
 const follower=createMainAccountFollower({enabled:()=>enabled,currentFingerprint:()=>bound,
  readFingerprint:async()=>{reads++;return actual;},refresh:async()=>{refreshes++;bound=actual;return true;}});
 follower.start();await vi.advanceTimersByTimeAsync(2000);expect(reads).toBe(1);expect(refreshes).toBe(0);
 actual='b';await vi.advanceTimersByTimeAsync(2000);expect(refreshes).toBe(1);expect(bound).toBe('b');
 enabled=false;await vi.advanceTimersByTimeAsync(10000);expect(reads).toBe(2);
 await follower.close();
});
it('backs off failed replacements and retries without overlapping work',async()=>{
 vi.useFakeTimers();let refreshes=0;
 const follower=createMainAccountFollower({enabled:()=>true,currentFingerprint:()=> 'a',readFingerprint:async()=> 'b',refresh:async()=>{refreshes++;return false;}});
 follower.start();follower.start();await vi.advanceTimersByTimeAsync(2000);expect(refreshes).toBe(1);
 await vi.advanceTimersByTimeAsync(29999);expect(refreshes).toBe(1);
 await vi.advanceTimersByTimeAsync(1);expect(refreshes).toBe(2);await follower.close();
});
it('does not act on a local read delivered after close',async()=>{
 vi.useFakeTimers();let release!:(value:string)=>void,refreshes=0;
 const follower=createMainAccountFollower({enabled:()=>true,currentFingerprint:()=> 'a',readFingerprint:async()=>new Promise<string>(resolve=>{release=resolve;}),refresh:async()=>{refreshes++;return true;}});
 follower.start();await vi.advanceTimersByTimeAsync(2000);const closing=follower.close();release('b');await closing;
 await vi.advanceTimersByTimeAsync(60000);expect(refreshes).toBe(0);
});
