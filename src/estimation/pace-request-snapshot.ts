import {randomBytes} from 'node:crypto';
import {packObserverInput} from './observer-input.js';
import type {ObserverInput} from './observer-contract.js';
import type {PaceGroup} from './pace-measurements.js';
import type {PaceInterval} from './pace-correction.js';

const MAX_SECONDS=31_536_000;

export interface FrozenPaceRequest {
  input: ObserverInput;
  intervals: ReadonlyMap<string,readonly PaceInterval[]>;
}

function median(values:readonly number[]):number {
  const sorted=[...values].sort((left,right)=>left-right);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2===1?sorted[middle]!:((sorted[middle-1]!+sorted[middle]!)/2);
}

function ref():string {return `pm_${randomBytes(16).toString('hex')}`;}

function validGroup(group:PaceGroup):boolean {
  return group.workClass==='file_processing'&&group.unit==='file'&&
    group.intervals.length>=3&&group.intervals.length<=5&&
    group.intervals.every(interval=>Number.isFinite(interval.startActiveSeconds)&&
      Number.isFinite(interval.endActiveSeconds)&&interval.endActiveSeconds>interval.startActiveSeconds&&
      Number.isSafeInteger(interval.completedUnits)&&interval.completedUnits>0);
}

export function freezePaceRequest(input:ObserverInput,groups:readonly PaceGroup[]):FrozenPaceRequest {
  const candidates=groups.filter(validGroup).slice(0,8).map(group=>{
    const measurementRef=ref();
    const intervals=Object.freeze(group.intervals.map(interval=>Object.freeze({...interval})));
    const rates=intervals.map(interval=>(interval.endActiveSeconds-interval.startActiveSeconds)/interval.completedUnits);
    const medianSecondsPerUnit=median(rates);
    return {measurementRef,intervals,medianSecondsPerUnit,summary:Object.freeze({measurementRef,workClass:'file_processing' as const,
      unit:'file' as const,sampleCount:intervals.length,medianSecondsPerUnit,
      clock:'tool_execution' as const})};
  }).filter(candidate=>candidate.medianSecondsPerUnit>=0&&candidate.medianSecondsPerUnit<=MAX_SECONDS);
  const packet=JSON.parse(packObserverInput({...input,...(candidates.length?{paceMeasurements:candidates.map(candidate=>candidate.summary)}:{})})) as ObserverInput;
  const retained=new Set(packet.paceMeasurements?.map(measurement=>measurement.measurementRef)??[]);
  const intervals=new Map<string,readonly PaceInterval[]>();
  for(const candidate of candidates)if(retained.has(candidate.measurementRef))intervals.set(candidate.measurementRef,candidate.intervals);
  return {input:packet,intervals};
}
