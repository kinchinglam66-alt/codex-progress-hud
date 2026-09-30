import {expect,it} from 'vitest';
import type {HistorySnapshot} from '../../src/observer/history-snapshot.js';
import {verifyHistoryFallback,assertCompleteHistoryWindow} from '../../src/observer/verified-history-fallback.js';

function fixture(){let text='first',valid=true,closed=0;
 const snapshot:HistorySnapshot={identity:'source',sourceEpoch:1,revision:1,coverage:{complete:true,gaps:[]},
  async *records(){yield {ordinal:0,record:{id:'first',turnId:'one',atMs:0,kind:'user',text}};},close:async()=>{closed++;}};
 return {snapshot,check:async()=>{if(!valid)throw Error('STALE_TICKET');},change:()=>{text='other';},invalidate:()=>{valid=false;},closed:()=>closed};
}

it('requires complete coverage and rejects oversized full projections without a checkpoint',async()=>{
 const f=fixture(),signal=new AbortController().signal;
 await assertCompleteHistoryWindow(f.snapshot,signal);
 f.snapshot.coverage.gaps.push('unreadable_record');
 await expect(assertCompleteHistoryWindow(f.snapshot,signal)).rejects.toThrow('history_incomplete');
 f.snapshot.coverage.gaps=[];
 f.snapshot.records=async function*(){yield {ordinal:0,record:{id:'large',turnId:'one',atMs:0,kind:'user',text:'x'.repeat(8*1024*1024)}};};
 await expect(assertCompleteHistoryWindow(f.snapshot,signal)).rejects.toMatchObject({message:expect.stringContaining('context_too_large')});
});
it('requires a complete bounded snapshot and rechecks its exact content before reuse',async()=>{
 const f=fixture(),signal=new AbortController().signal;
 const verified=await verifyHistoryFallback({snapshot:f.snapshot,currentTurnId:'one'},signal,f.check);
 await verified.validate(signal);f.change();
 await expect(verified.validate(signal)).rejects.toThrow('HISTORY_FALLBACK_CHANGED');expect(f.closed()).toBe(0);
});
it('retains source ownership with the caller and checks its ticket on later validation',async()=>{
 const f=fixture(),signal=new AbortController().signal;
 const verified=await verifyHistoryFallback({snapshot:f.snapshot,currentTurnId:'one'},signal,f.check);f.invalidate();
 await expect(verified.validate(signal)).rejects.toThrow('STALE_TICKET');expect(f.closed()).toBe(0);
});
it('rejects incomplete history before worker/model preparation',async()=>{
 const f=fixture();f.snapshot.coverage.complete=false;
 await expect(verifyHistoryFallback({snapshot:f.snapshot,currentTurnId:'one'},new AbortController().signal,f.check)).rejects.toThrow('history_incomplete');
});

it('verifies the records actually consumed by the importer, not only a separate later scan',async()=>{
 const f=fixture(),signal=new AbortController().signal;
 const verified=await verifyHistoryFallback({snapshot:f.snapshot,currentTurnId:'one'},signal,f.check);f.change();
 await expect((async()=>{for await(const _item of verified.snapshot.records(signal)){} })()).rejects.toThrow('HISTORY_FALLBACK_CHANGED');
});
