import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {milestoneSelectionInstructions} from '../../src/estimation/milestone-selection.js';
import {applyProgress,createProgressState,progressScope,progressStateSchema,nextMilestoneSchema} from '../../src/estimation/progress-state.js';
import {observerResponseSchema} from '../../src/estimation/observer-contract.js';

const total={remainingSeconds:120,errorPercent:40};
const next={definition:'Focused regression results',completionCriterion:'semantic' as const,
 criterion:'The focused tests return their result.',operationRef:null,estimate:total};
const state=()=>createProgressState(progressScope('synthetic','turn',1,0));

it('retains an independent checkpoint with exactly the same seconds as the turn',()=>{
 const s=state();expect(applyProgress(s,next,null,total,30)).toBeNull();
 expect(s.milestoneApplication?.outcome).toBe('accepted');
 expect(progressStateSchema.parse(s).milestone?.prediction).toEqual({...total,observedActiveSeconds:30});
});
it('clears an obsolete checkpoint without discarding the independent whole-turn estimate',()=>{
 const s=state();applyProgress(s,next,null,total,10);
 applyProgress(s,null,null,{remainingSeconds:200,errorPercent:50},20);
 expect(s.milestone).toBeNull();expect(s.previousTurnEstimate).toEqual({remainingSeconds:200,errorPercent:50,observedActiveSeconds:20});
 expect(s.observedEventSequence).toBe(0);expect(s.milestoneApplication?.outcome).toBe('hidden');
});
it('keeps existing operation-reference validation and does not invent a numeric milestone',()=>{
 const s=state();
 expect(applyProgress(s,{...next,completionCriterion:'operation_end',operationRef:'op_'+'a'.repeat(32)},null,total,10)).toBe('invalid_milestone');
 expect(s.milestone).toBeNull();expect(s.previousTurnEstimate?.remainingSeconds).toBe(120);
 applyProgress(s,{...next,estimate:null},null,null,20);expect(s.milestone?.prediction).toBeNull();
});
it('does not add explanation fields or change the existing wire contract',()=>{
 const wire=JSON.parse(readFileSync(new URL('../../src/estimation/assets/observer.schema.json',import.meta.url),'utf8'));
 expect(Object.keys(wire.properties.nextMilestone.properties).sort()).toEqual(Object.keys(nextMilestoneSchema.shape).sort());
 expect(wire.properties.nextMilestone.properties.selection).toBeUndefined();
 expect(observerResponseSchema.parse({relation:'continue',status:'running',summary:'Repair',estimate:total,nextMilestone:next}).nextMilestone).toEqual(next);
});
it('keeps readable and native policy identical on selection boundaries and numeric independence',()=>{
 const readable=readFileSync(new URL('../../src/estimation/assets/observer-instructions.md',import.meta.url),'utf8');
 expect(readable).toContain(milestoneSelectionInstructions);
 expect(milestoneSelectionInstructions).toContain('earliest supported observable result');
 expect(milestoneSelectionInstructions).toContain('The final reply itself is not an intermediate checkpoint');
 expect(milestoneSelectionInstructions).toContain('not itself a reason to withhold');
 expect(milestoneSelectionInstructions).toContain('best-effort numeric total');
 expect(milestoneSelectionInstructions).toContain('Equal milestone and whole-turn seconds are allowed');
 expect(Buffer.byteLength(milestoneSelectionInstructions)).toBeLessThan(1100);
});
