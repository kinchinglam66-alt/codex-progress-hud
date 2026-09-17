import type {NativeContextPhaseDurations} from './native-context-metrics.js';
type Phase=keyof NativeContextPhaseDurations;
const phases:readonly Phase[]=['queueMs','accountProcessMs','snapshotMs','forkImportMs','compactionMs','inferenceMs','deliveryMs'];
/** Strict evaluation instrumentation, not a production authorization gate.
 * One monotonic clock and one active phase partition all elapsed preparation
 * and delivery time. Unknown/unobserved stages are not silently made zero. */
export function createNativeContextPhaseClock(now:()=>number){
 const durations:Record<Phase,number>={queueMs:0,accountProcessMs:0,snapshotMs:0,forkImportMs:0,compactionMs:0,inferenceMs:0,deliveryMs:0};
 let previous=now(),phase:Phase='queueMs',finished=false,invalid=false;
 if(!Number.isFinite(previous)||previous<0)throw Error('PHASE_CLOCK_INVALID');
 const seen=new Set<Phase>(['queueMs']);
 function tick(){
  if(finished)throw Error('PHASE_CLOCK_FINISHED');
  const current=now();
  if(invalid||!Number.isFinite(current)||current<previous){invalid=true;throw Error('PHASE_CLOCK_INVALID');}
  durations[phase]+=current-previous;previous=current;
 }
 return {
  enter(next:Phase){
   if(!phases.includes(next))throw Error('PHASE_CLOCK_STAGE_INVALID');
   tick();phase=next;seen.add(next);
  },
  noCompaction(){tick();seen.add('compactionMs');},
  finish():Readonly<NativeContextPhaseDurations>{
   tick();if(phases.some(name=>!seen.has(name)))throw Error('PHASE_CLOCK_INCOMPLETE');
   finished=true;return Object.freeze({...durations});
  },
 };
}
