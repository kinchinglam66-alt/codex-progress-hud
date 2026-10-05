import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {numericEtaPolicyInstructions} from '../../src/estimation/numeric-eta-policy.js';
import {observerResponseSchema} from '../../src/estimation/observer-contract.js';

it('keeps readable and native policies identical without replacing task evidence',()=>{
 const text=readFileSync(new URL('../../src/estimation/assets/observer-instructions.md',import.meta.url),'utf8');
 expect(text).toContain(numericEtaPolicyInstructions);
 expect(text).toContain('Only return null top-level estimate when the task cannot be identified');
 expect(text).toContain('A pending approval while relevant work continues is running');
 expect(text).not.toContain('return null estimate when no defensible basis exists');
});
it('preserves uncertainty and host lifecycle authority rather than fabricating certainty',()=>{
 expect(numericEtaPolicyInstructions).toContain('do not invent observed facts');
 expect(numericEtaPolicyInstructions).toContain('no extra output fields or chain of thought');
 expect(numericEtaPolicyInstructions).toContain('never substitute only the next milestone');
 expect(numericEtaPolicyInstructions).toContain('explicitly blocked solely on required user action');
 expect(numericEtaPolicyInstructions).toContain('remain exclusively host-controlled');
});
it('leaves protocol handling for null and uncertain estimates backward compatible',()=>{
 expect(observerResponseSchema.parse({relation:'unknown',status:'unknown',summary:null,estimate:null}).estimate).toBeNull();
 expect(observerResponseSchema.parse({relation:'continue',status:'running',summary:'Approximate remaining work',estimate:{remainingSeconds:900,errorPercent:100}}).estimate?.remainingSeconds).toBe(900);
});
