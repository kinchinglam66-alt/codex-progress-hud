import {expect,it} from 'vitest';
import {transitionComparisonNativeState} from '../../src/evaluation/native-comparison-transition.js';
const state={conversationKey:'source',turnKey:'turn',generation:0,running:true};
it('does not force an already retained runtime to close when the worker accepts a next-turn transition',async()=>{
 let releases=0,updated=false;
 await transitionComparisonNativeState({updateRetentionState:()=>{updated=true;},release:async()=>{releases++;},
  status:()=>({nativeLifecycle:{retained:updated}})},state,{...state,turnKey:'next',generation:1},new AbortController().signal);
 expect(updated).toBe(true);expect(releases).toBe(0);
});
it('joins prior-owner cleanup before returning a changed source state',async()=>{
 const order:string[]=[];let finish!:()=>void;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 const worker={updateRetentionState:()=>{order.push('revoke');},release:async()=>{await pending;order.push('closed');}};
 const operation=transitionComparisonNativeState(worker,state,{...state,turnKey:'next',generation:1},new AbortController().signal)
  .then(()=>{order.push('acquire');});
 await Promise.resolve();expect(order).toEqual(['revoke']);
 finish();await operation;expect(order).toEqual(['revoke','closed','acquire']);
});
it('does not retire a same-turn warm owner',async()=>{
 let releases=0,updates=0;
 await transitionComparisonNativeState({updateRetentionState:()=>{updates++;},release:async()=>{releases++;}},
  state,{...state},new AbortController().signal);
 expect(updates).toBe(1);expect(releases).toBe(0);
});
it('rejects failed cleanup or cancellation before a subsequent acquisition',async()=>{
 const controller=new AbortController();
 await expect(transitionComparisonNativeState({updateRetentionState:()=>{},release:async()=>{throw Error('close failed');}},
  state,{...state,generation:1},controller.signal)).rejects.toThrow('close failed');
 await expect(transitionComparisonNativeState({updateRetentionState:()=>{},release:async()=>{controller.abort();}},
  state,{...state,generation:1},controller.signal)).rejects.toThrow();
});
