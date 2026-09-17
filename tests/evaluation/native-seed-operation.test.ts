import {expect,it} from 'vitest';
import {runSyntheticSeedOperation} from '../../src/evaluation/native-seed-operation.js';
function fixture(){
 const evidence:string[]=[],result={terminalConfirmed:true,cancelled:false,usageCompleteness:'missing'};
 const options={beforeDispatch:async()=>{evidence.push('before');},dispatch:async(onDispatch:()=>void)=>{onDispatch();evidence.push('dispatch');return result;},
  terminal:async(state:string)=>{evidence.push(`terminal:${state}`);},settleConfirmed:async()=>{evidence.push('settle-confirmed');},
  settleUnconfirmed:async()=>{evidence.push('settle-unconfirmed');},cancelBeforeDispatch:async()=>{evidence.push('cancel');}};
 return {evidence,result,options};
}
it('separates confirmed completion from unknown compression usage',async()=>{
 const {evidence,result,options}=fixture();expect(await runSyntheticSeedOperation(options)).toBe(result);
 expect(evidence).toEqual(['before','dispatch','terminal:completed','settle-confirmed']);
});
it.each([false,true])('does not retry a failed terminal append, including ambiguous durable writes (%s)',async written=>{
 const {evidence,options}=fixture();let attempts=0;
 options.terminal=async state=>{attempts++;if(written)evidence.push(`terminal:${state}`);throw Error('RECEIPT_FAILED');};
 await expect(runSyntheticSeedOperation(options)).rejects.toThrow('RECEIPT_FAILED');
 expect(attempts).toBe(1);expect(evidence.filter(row=>row.startsWith('settle'))).toEqual([]);
});
it('does not rewrite completion or retry a failed settlement',async()=>{
 const {evidence,options}=fixture();options.settleConfirmed=async()=>{evidence.push('settle-confirmed');throw Error('SETTLEMENT_FAILED');};
 await expect(runSyntheticSeedOperation(options)).rejects.toThrow('SETTLEMENT_FAILED');
 expect(evidence).toEqual(['before','dispatch','terminal:completed','settle-confirmed']);
});
it('cancels pre-dispatch failure without classifying it as a billed unknown',async()=>{
 const {evidence,options}=fixture();options.beforeDispatch=async()=>{throw Error('ABORTED');};
 await expect(runSyntheticSeedOperation(options)).rejects.toThrow('ABORTED');
 expect(evidence).toEqual(['terminal:cancelled','cancel']);
});
it('preserves a dispatched failed operation as unconfirmed and never retries',async()=>{
 const {evidence,options}=fixture();options.dispatch=async dispatched=>{dispatched();evidence.push('dispatch');throw Error('RPC_FAILED');};
 await expect(runSyntheticSeedOperation(options)).rejects.toThrow('RPC_FAILED');
 expect(evidence).toEqual(['before','dispatch','terminal:unconfirmed','settle-unconfirmed']);
});
