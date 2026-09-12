import {afterEach,expect,it,vi} from 'vitest';
import {openResearchBounded,closeResearchBounded} from '../../../src/estimation/residual/availability.js';
afterEach(()=>vi.useRealTimers());
it('does not wait indefinitely for startup and closes a late research owner',async()=>{
  vi.useFakeTimers();let resolve!:(value:{close:()=>Promise<void>})=>void;
  const close=vi.fn(async()=>{}),pending=new Promise<{close:()=>Promise<void>}>(r=>{resolve=r;});
  const result=openResearchBounded(()=>pending,50);
  await vi.advanceTimersByTimeAsync(50);expect(await result).toBeUndefined();
  resolve({close});await vi.advanceTimersByTimeAsync(0);expect(close).toHaveBeenCalledOnce();
});
it('bounds slow shutdown, catches failures, and preserves prompt owners',async()=>{
  vi.useFakeTimers();const owner={close:()=>new Promise<void>(()=>{})};
  expect(await openResearchBounded(async()=>owner,50)).toBe(owner);
  const result=closeResearchBounded(owner,50);await vi.advanceTimersByTimeAsync(50);await result;
  expect(await openResearchBounded(async()=>{throw Error('disk');},50)).toBeUndefined();
  await closeResearchBounded({close:async()=>{throw Error('disk');}},50);
  expect(vi.getTimerCount()).toBe(0);
});
