import {expect,it} from 'vitest';
import {observerInputSchema,isInferenceEligible} from '../../src/estimation/observer-contract.js';
const representation={mode:'full' as const,sourceComplete:true,originalRecords:1,compressedThroughOrdinal:null,sizing:'conservative' as const};
const input={goalSummary:'inspect',runtime:'running',activeSeconds:1,messages:[{kind:'user',text:'inspect',truncated:false}],truncated:false};
it('never treats explicit ineligibility as permission',()=>{
 expect(isInferenceEligible({...representation,inferenceEligible:false})).toBe(false);
});
it.each([
 {...representation,sourceGaps:['missing_image']},
 {...representation,sourceComplete:false,mode:'incomplete',missingImages:1,sourceGaps:[]},
 {...representation,sourceComplete:false,mode:'incomplete',missingImages:0,sourceGaps:['missing_image']}
])('rejects contradictory fidelity even without an eligible flag',quality=>{
 expect(observerInputSchema.safeParse({...input,representation:quality}).success).toBe(false);
});
