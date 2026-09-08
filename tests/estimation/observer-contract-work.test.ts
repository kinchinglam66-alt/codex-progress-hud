import {expect, it} from 'vitest';
import {observerResponseSchema} from '../../src/estimation/observer-contract.js';

const base={relation:'replace' as const,status:'running' as const,summary:'current work',estimate:{remainingSeconds:100,errorPercent:20}};
const work={composition:'serial' as const,changeReason:'routine' as const,parts:[
  {workClass:'file_processing' as const,unit:'file' as const,remainingUnits:4,priorSeconds:80},
  {workClass:'other' as const,unit:'unknown' as const,remainingUnits:null,priorSeconds:20},
]};

it('accepts bounded optional nullable work and keeps legacy responses valid',()=>{
  expect(observerResponseSchema.parse(base)).toMatchObject(base);
  expect(observerResponseSchema.parse({...base,work})).toMatchObject({work});
  expect(observerResponseSchema.parse({...base,work:null})).toMatchObject({work:null});
});

it('accepts optional measurement references while preserving legacy work parts',()=>{
  const measurementRef='pm_0123456789abcdef0123456789abcdef';
  expect(observerResponseSchema.parse({...base,work:{...work,parts:[{...work.parts[0],measurementRef}]}}))
    .toMatchObject({work:{parts:[{measurementRef}]}});
  expect(observerResponseSchema.parse(base)).toEqual(base);
});

it('rejects actionable work on unknown or completed interpretations',()=>{
  expect(observerResponseSchema.safeParse({relation:'unknown',status:'unknown',summary:null,estimate:null,work}).success).toBe(false);
  expect(observerResponseSchema.safeParse({relation:'replace',status:'completed',summary:'done',estimate:null,work}).success).toBe(false);
});

it('rejects unbounded work fields and extra work keys',()=>{
  expect(observerResponseSchema.safeParse({...base,work:{...work,parts:[{...work.parts[0],remainingUnits:1_000_001}]}}).success).toBe(false);
  expect(observerResponseSchema.safeParse({...base,work:{...work,extra:'nope'}}).success).toBe(false);
});
