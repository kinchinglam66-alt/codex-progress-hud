import {expect, it} from 'vitest';
import {correctPace, type PaceInterval, type WorkBreakdown} from '../../src/estimation/pace-correction.js';

const work: WorkBreakdown = {composition:'serial',changeReason:'routine',parts:[
  {workClass:'file_processing',unit:'file',remainingUnits:4,priorSeconds:80},
  {workClass:'other',unit:'unknown',remainingUnits:null,priorSeconds:20},
]};
const intervals: PaceInterval[] = [
  {workClass:'file_processing',unit:'file',startActiveSeconds:0,endActiveSeconds:10,completedUnits:1,complete:true,serial:true},
  {workClass:'file_processing',unit:'file',startActiveSeconds:10,endActiveSeconds:22,completedUnits:1,complete:true,serial:true},
  {workClass:'file_processing',unit:'file',startActiveSeconds:22,endActiveSeconds:122,completedUnits:1,complete:true,serial:true},
];

it('uses the median compatible pace for the remaining work',()=>{
  expect(correctPace(100,work,intervals)).toEqual({seconds:68,reason:'eligible'});
});

it('uses the arithmetic median for an even number of intervals',()=>{
  const even=[...intervals,{workClass:'file_processing' as const,unit:'file' as const,
    startActiveSeconds:122,endActiveSeconds:136,completedUnits:1,complete:true,serial:true}];
  expect(correctPace(100,work,even)).toEqual({seconds:72,reason:'eligible'});
});

it('abstains when the work unit is not concrete',()=>{
  const unknownUnit={...work,parts:[{...work.parts[0]!,unit:'unknown' as const},work.parts[1]!]};
  const unknownIntervals=intervals.map(interval=>({...interval,unit:'unknown' as const}));
  expect(correctPace(100,unknownUnit,unknownIntervals)).toMatchObject({seconds:null,reason:'incompatible_units'});
});

it('abstains when fewer than three intervals are available',()=>{
  expect(correctPace(100,work,intervals.slice(0,2))).toEqual({seconds:null,reason:'insufficient_intervals'});
});

it.each([
  ['overlap', [{...intervals[0]!,startActiveSeconds:5}] ],
  ['duplicate', [intervals[0]!,intervals[0]!,intervals[1]!]],
  ['incomplete', [intervals[0]!,intervals[1]!,{...intervals[2]!,complete:false}]],
  ['zero units', [intervals[0]!,intervals[1]!,{...intervals[2]!,completedUnits:0}]],
  ['incompatible class', [intervals[0]!,intervals[1]!,{...intervals[2]!,workClass:'batch_processing'}]],
] as const)('abstains for %s interval history',(_name,history)=>{
  expect(correctPace(100,work,history)).toMatchObject({seconds:null});
});

it('abstains for unknown composition and a prior total that disagrees with raw ETA',()=>{
  expect(correctPace(100,{...work,composition:'unknown'},intervals).seconds).toBeNull();
  expect(correctPace(100,{...work,parts:work.parts.map(part=>({...part,priorSeconds:part.priorSeconds+1}))},intervals)).toMatchObject({seconds:null,reason:'invalid_composition'});
});
