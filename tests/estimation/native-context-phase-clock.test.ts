import {expect,it} from 'vitest';
import {createNativeContextPhaseClock} from '../../src/estimation/native-context-phase-clock.js';
it('partitions the entire request lifetime and sums repeated disjoint stages',()=>{
 let now=100;const clock=createNativeContextPhaseClock(()=>now);
 now=110;clock.enter('snapshotMs');now=130;clock.enter('accountProcessMs');
 now=160;clock.enter('forkImportMs');now=200;clock.enter('accountProcessMs');
 now=205;clock.enter('compactionMs');now=210;clock.enter('inferenceMs');
 now=280;clock.enter('deliveryMs');now=300;
 const result=clock.finish();
 expect(result).toEqual({queueMs:10,snapshotMs:20,accountProcessMs:35,forkImportMs:40,compactionMs:5,inferenceMs:70,deliveryMs:20});
 expect(Object.values(result).reduce((a,b)=>a+b,0)).toBe(200);expect(Object.isFrozen(result)).toBe(true);
 expect(()=>clock.enter('queueMs')).toThrow('PHASE_CLOCK_FINISHED');
});
it('does not fabricate zero for missing observations; only compaction may be explicitly absent',()=>{
 const clock=createNativeContextPhaseClock(()=>1);clock.noCompaction();
 expect(()=>clock.finish()).toThrow('PHASE_CLOCK_INCOMPLETE');
 for(const phase of ['snapshotMs','accountProcessMs','forkImportMs','inferenceMs','deliveryMs'] as const)clock.enter(phase);
 expect(clock.finish().compactionMs).toBe(0);
});
it('fails invalid or backwards clocks and cannot then report a usable duration',()=>{
 expect(()=>createNativeContextPhaseClock(()=>NaN)).toThrow('PHASE_CLOCK_INVALID');
 let now=1;const clock=createNativeContextPhaseClock(()=>now);
 now=0;expect(()=>clock.enter('snapshotMs')).toThrow('PHASE_CLOCK_INVALID');
 now=2;expect(()=>clock.enter('snapshotMs')).toThrow('PHASE_CLOCK_INVALID');
});
