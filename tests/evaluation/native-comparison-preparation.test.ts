import {expect,it} from 'vitest';
import {createMeasuredComparisonPreparation} from '../../src/evaluation/native-comparison-preparation.js';
import {createApprovedComparisonConsent} from '../../src/evaluation/native-comparison-consent.js';
import {createNativeContextPhaseClock} from '../../src/estimation/native-context-phase-clock.js';

it('refreshes expired evidence before acquisition, counts preparation time and consumes it only once',async()=>{
 let now=0,calls=0;
 const evidence={accountFingerprint:'a'.repeat(64),routeFingerprint:'b'.repeat(64),assetsFingerprint:'c'.repeat(64),observedAt:0,expiresAt:300000};
 const consent=createApprovedComparisonConsent(evidence,{now:()=>now,onInvalidate:()=>{throw Error('invalidated');}});
 now=300001;
 const phase=createNativeContextPhaseClock(()=>now);
 const adapter=createMeasuredComparisonPreparation({
  accountPhase:()=>phase.enter('accountProcessMs'),
  prepare:async()=>{calls++;now+=7000;consent.refresh({...evidence,observedAt:now,expiresAt:now+300000});return {call:calls};},
  disposeUnused:()=>{throw Error('unexpected unused preparation');},
 });
 const signal=new AbortController().signal;
 await adapter.runMeasured(signal,async()=>{
  expect(consent.authorized()).toBe(true); // nativeSourceDestination guard
  phase.enter('snapshotMs');now+=100;
  phase.enter('accountProcessMs');
  expect(await adapter.prepareSession(signal)).toEqual({call:1});
  expect(calls).toBe(1);
  // A later compaction must obtain its own fresh preparation, not this ticket.
  expect(await adapter.prepareSession(signal)).toEqual({call:2});
  phase.enter('forkImportMs');phase.noCompaction();phase.enter('inferenceMs');phase.enter('deliveryMs');
 });
 expect(phase.finish().accountProcessMs).toBe(14000);
 expect(calls).toBe(2);
});

it('discards unused preparation on cancellation and never carries it into a new request',async()=>{
 let calls=0,disposed=0,ran=false;
 const controller=new AbortController();
 const adapter=createMeasuredComparisonPreparation({
  accountPhase:()=>{},
  prepare:async()=>{calls++;if(calls===1)controller.abort();return calls;},
  disposeUnused:()=>{disposed++;},
 });
 await expect(adapter.runMeasured(controller.signal,async()=>{ran=true;})).rejects.toThrow();
 expect(ran).toBe(false);expect(disposed).toBe(1);
 await adapter.runMeasured(new AbortController().signal,async()=>{
  expect(await adapter.prepareSession(new AbortController().signal)).toBe(2);
 });
 expect(calls).toBe(2);expect(disposed).toBe(1);
});

it('does not enter the worker on failed account preparation',async()=>{
 let ran=false;
 const adapter=createMeasuredComparisonPreparation({
  accountPhase:()=>{},prepare:async()=>{throw Error('metadata failed');},disposeUnused:()=>{},
 });
 await expect(adapter.runMeasured(new AbortController().signal,async()=>{ran=true;})).rejects.toThrow('metadata failed');
 expect(ran).toBe(false);
});
