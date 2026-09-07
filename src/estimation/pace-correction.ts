import type {PaceReason} from './forecast-record.js';

const YEAR=31_536_000;
const MAX_PARTS=8;
const MAX_UNITS=1_000_000;

export interface WorkPart {
  workClass:'file_processing'|'batch_processing'|'other';
  unit:'file'|'batch'|'unknown';
  remainingUnits:number|null;
  priorSeconds:number;
}
export interface WorkBreakdown {
  composition:'serial'|'unknown';
  changeReason:'routine'|'scope_change'|'failure'|'unknown';
  parts:readonly WorkPart[];
}
export interface PaceInterval {
  workClass:WorkPart['workClass'];
  unit:WorkPart['unit'];
  startActiveSeconds:number;
  endActiveSeconds:number;
  completedUnits:number;
  complete:boolean;
  serial:boolean;
}

const finiteBounded=(value:number,max=YEAR)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max;
const validClass=(value:unknown):value is WorkPart['workClass']=>value==='file_processing'||value==='batch_processing'||value==='other';
const validUnit=(value:unknown):value is WorkPart['unit']=>value==='file'||value==='batch'||value==='unknown';
const concretePair=(workClass:WorkPart['workClass'],unit:WorkPart['unit'])=>
  (workClass==='file_processing'&&unit==='file')||(workClass==='batch_processing'&&unit==='batch');

function invalid(reason:PaceReason):{seconds:number|null;reason:PaceReason} {return {seconds:null,reason};}

export function correctPace(rawSeconds:number,work:WorkBreakdown|null,intervals:readonly PaceInterval[]):{seconds:number|null;reason:PaceReason} {
  if(!finiteBounded(rawSeconds))return invalid('invalid_composition');
  if(work===null)return invalid('missing_measurements');
  if(!work || work.composition!=='serial')return invalid('invalid_composition');
  if(work.changeReason!=='routine')return invalid('invalid_composition');
  if(!Array.isArray(work.parts)||work.parts.length<1||work.parts.length>MAX_PARTS)return invalid('invalid_composition');

  let target:WorkPart|undefined;
  let priorTotal=0;
  for(const part of work.parts){
    if(!part||!validClass(part.workClass)||!validUnit(part.unit)||
      !finiteBounded(part.priorSeconds)||
      (part.remainingUnits!==null && (!Number.isSafeInteger(part.remainingUnits)||part.remainingUnits<1||part.remainingUnits>MAX_UNITS)))
      return invalid('invalid_composition');
    priorTotal+=part.priorSeconds;
    if(!finiteBounded(priorTotal))return invalid('invalid_composition');
    if(part.remainingUnits!==null){
      if(target!==undefined)return invalid('invalid_composition');
      target=part;
    }
  }
  if(target===undefined)return invalid('missing_measurements');
  if(!concretePair(target.workClass,target.unit))return invalid('incompatible_units');
  if(Math.abs(priorTotal-rawSeconds)>Math.max(1,rawSeconds*0.01))return invalid('invalid_composition');
  if(!Array.isArray(intervals)||intervals.length===0)return invalid('missing_measurements');
  if(intervals.length<3)return invalid('insufficient_intervals');

  const ordered:PaceInterval[]=[];
  for(const interval of intervals){
    if(!interval||!validClass(interval.workClass)||!validUnit(interval.unit))return invalid('invalid_composition');
    if(!concretePair(interval.workClass,interval.unit)||interval.workClass!==target.workClass||interval.unit!==target.unit)return invalid('incompatible_units');
    if(!finiteBounded(interval.startActiveSeconds)||!finiteBounded(interval.endActiveSeconds)||
      interval.endActiveSeconds<=interval.startActiveSeconds||!Number.isSafeInteger(interval.completedUnits)||interval.completedUnits<1||
      interval.completedUnits>MAX_UNITS)return invalid('invalid_composition');
    if(!interval.complete)return invalid('invalid_composition');
    if(!interval.serial)return invalid('parallel_work');
    ordered.push(interval);
  }
  ordered.sort((left,right)=>left.startActiveSeconds-right.startActiveSeconds||left.endActiveSeconds-right.endActiveSeconds);
  for(let index=1;index<ordered.length;index++){
    const previous=ordered[index-1]!,current=ordered[index]!;
    if(current.startActiveSeconds<previous.endActiveSeconds)return invalid('invalid_composition');
    if(current.startActiveSeconds===previous.startActiveSeconds&&current.endActiveSeconds===previous.endActiveSeconds&&
      current.completedUnits===previous.completedUnits)return invalid('invalid_composition');
  }
  const latest=ordered.sort((left,right)=>right.endActiveSeconds-left.endActiveSeconds).slice(0,5);
  if(latest.length<3)return invalid('insufficient_intervals');
  const rates=latest.map(interval=>(interval.endActiveSeconds-interval.startActiveSeconds)/interval.completedUnits).sort((a,b)=>a-b);
  const middle=Math.floor(rates.length/2);
  const median=rates.length%2===1?rates[middle]!:(rates[middle-1]!+rates[middle]!)/2;
  const corrected=priorTotal-target.priorSeconds+median*target.remainingUnits!;
  if(!finiteBounded(corrected))return invalid('invalid_composition');
  return {seconds:corrected,reason:'eligible'};
}
