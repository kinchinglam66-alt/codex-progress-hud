import {expect,it} from 'vitest';
import {createNativeTurnTiming,type NativeTurnTiming} from '../../src/estimation/native-turn-timing.js';

it('records bounded phase duration and cold/warm provenance without context data',async()=>{
 let now=10;const events:NativeTurnTiming[]=[];
 const timing=createNativeTurnTiming(()=>now,event=>events.push(event));
 expect(await timing.measure('base_copy',async()=>{now=35;return 'private return value';},'cold')).toBe('private return value');
 expect(events).toEqual([{phase:'base_copy',elapsedMs:25,outcome:'ok',baseState:'cold'}]);
});
it('records failure without hiding the original exception or its cleanup path',async()=>{
 let now=2;const events:NativeTurnTiming[]=[];
 const timing=createNativeTurnTiming(()=>now,event=>events.push(event));
 await expect(timing.measure('child_fork',async()=>{now=7;throw Error('ORIGINAL');})).rejects.toThrow('ORIGINAL');
 expect(events).toEqual([{phase:'child_fork',elapsedMs:5,outcome:'failed'}]);
});
it('does not convert invalid clocks to zero or make diagnostics an authorization gate',async()=>{
 const events:NativeTurnTiming[]=[];let now=20;
 const timing=createNativeTurnTiming(()=>now,event=>{events.push(event);throw Error('DIAGNOSTIC_FAILURE');});
 expect(await timing.measure('source_validation',async()=>{now=10;return 1;})).toBe(1);
 expect(events[0]!.elapsedMs).toBeNull();
 expect(await createNativeTurnTiming(()=>{throw Error('CLOCK');},()=>{}).measure('supplement_import',async()=>2)).toBe(2);
});
