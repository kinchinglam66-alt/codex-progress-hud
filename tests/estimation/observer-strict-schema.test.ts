import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {observerResponseSchema} from '../../src/estimation/observer-contract.js';

it('declares every object property required for strict provider output, including nested parts',()=>{
 const schema=JSON.parse(readFileSync(new URL('../../src/estimation/assets/observer.schema.json',import.meta.url),'utf8'));
 const visit=(node:any,path:string)=>{
  if(!node || typeof node!=='object')return;
  if(node.properties){
   expect(node.additionalProperties,path).toBe(false);
   expect([...(node.required??[])].sort(),path).toEqual(Object.keys(node.properties).sort());
  }
  for(const [key,value] of Object.entries(node))visit(value,`${path}.${key}`);
 };
 visit(schema,'root');
});

it('accepts a null wire reference as absent without changing downstream reference types',()=>{
 const value=observerResponseSchema.parse({relation:'continue',status:'running',summary:'work',basis:'remaining_work',estimate:{remainingSeconds:20,errorPercent:30},work:{composition:'serial',changeReason:'routine',parts:[{workClass:'other',unit:'unknown',remainingUnits:null,priorSeconds:20,measurementRef:null}]}});
 expect(value.work?.parts[0]?.measurementRef).toBeUndefined();
});

it('permits null in the wire measurement reference schema',()=>{
 const schema=JSON.parse(readFileSync(new URL('../../src/estimation/assets/observer.schema.json',import.meta.url),'utf8'));
 expect(schema.properties.work.properties.parts.items.properties.measurementRef.type).toContain('null');
});
