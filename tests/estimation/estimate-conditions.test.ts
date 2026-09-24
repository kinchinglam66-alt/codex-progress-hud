import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {assessEstimateCondition,estimateConditionsInstructions,estimateConditionsSchema} from '../../src/estimation/estimate-conditions.js';
import {observerResponseSchema,type ObserverInput,type ObserverResponse} from '../../src/estimation/observer-contract.js';
import {collectTurnEvidence,validateCompletionOutlook,estimateUncertain} from '../../src/estimation/completion-outlook.js';
const estimate={remainingSeconds:10,errorPercent:100};
const conditions={selectedPath:'report_blocker' as const,continueWork:{remainingSeconds:600,errorPercent:100},reportBlocker:estimate,milestonePath:'report_blocker' as const};
const response:ObserverResponse={relation:'continue',status:'running',summary:'repair',estimate,estimateConditions:conditions,
 completionOutlook:{path:'uncertain',reason:'failed command does not establish abandonment',evidenceRefs:[]}};
describe('conditional ETA consistency',()=>{
 it('keeps a failed-tool short estimate conditional without inventing a longer ETA or altering runtime',()=>{
  const input:ObserverInput={goalSummary:null,activeSeconds:30,runtime:'running',messages:[],truncated:false,
   turnEvidence:collectTurnEvidence([{id:'1',turnId:'t',kind:'tool_result',atMs:100,text:'failed',exitCode:1}],'t',200)};
  const raw={...response,completionOutlook:{path:'report_blocker' as const,reason:'will stop',evidenceRefs:[input.turnEvidence!.facts[1]!.ref]}};
  const result=validateCompletionOutlook(raw,input);
  expect(assessEstimateCondition(result)).toEqual({selectedPath:'report_blocker',displayPath:'report_blocker',issue:'conditional'});
  expect(result.estimate).toEqual(estimate);expect(result.status).toBe('running');expect(estimateUncertain(result)).toBe(true);
  expect(assessEstimateCondition(validateCompletionOutlook(result,input))).toEqual(assessEstimateCondition(result));
 });
 it('allows one unknown branch without manufacturing a number or summing alternatives',()=>{
  expect(observerResponseSchema.parse({...response,estimateConditions:{...conditions,continueWork:null}}).estimate).toEqual(estimate);
  expect(assessEstimateCondition({...response,estimateConditions:{...conditions,continueWork:null}})?.displayPath).toBe('report_blocker');
 });
 it.each([
  ['missing_conditions',null],
  ['unknown_path',{...conditions,selectedPath:'unknown'}],
  ['missing_branch',{...conditions,reportBlocker:null}],
  ['estimate_mismatch',{...conditions,reportBlocker:{...estimate,remainingSeconds:20}}],
  ['estimate_mismatch',{...conditions,reportBlocker:{...estimate,errorPercent:50}}],
 ] as const)('marks %s but retains original numeric coverage',(issue,c)=>{
  const r={...response,estimateConditions:c};expect(assessEstimateCondition(r)).toMatchObject({displayPath:'unknown',issue});expect(r.estimate).toEqual(estimate);
 });
 it('rejects outlook-path disagreement instead of picking whichever scenario is faster',()=>{
  expect(assessEstimateCondition({...response,completionOutlook:{path:'deliver_result',reason:'delivery expected',evidenceRefs:[]}})?.issue).toBe('outlook_mismatch');
 });
 it('checks the milestone belongs to the same scenario and cannot exceed turn duration',()=>{
  const nextMilestone={definition:'inspect',completionCriterion:'semantic' as const,criterion:'inspected',operationRef:null,estimate:{remainingSeconds:5,errorPercent:50}};
  expect(assessEstimateCondition({...response,nextMilestone,estimateConditions:{...conditions,milestonePath:'continue_work'}})?.issue).toBe('milestone_mismatch');
  expect(assessEstimateCondition({...response,nextMilestone:{...nextMilestone,estimate:{remainingSeconds:20,errorPercent:50}}})?.issue).toBe('milestone_exceeds_turn');
 });
 it('preserves no-estimate, old-response compatibility, and unknown conditions on legacy numbers',()=>{
  expect(assessEstimateCondition({...response,estimate:null})).toBeUndefined();
  const {estimateConditions:_conditions,completionOutlook:_outlook,...old}=response;
  expect(observerResponseSchema.parse(old)).toEqual(old);expect(assessEstimateCondition(old)?.issue).toBe('missing_conditions');
 });
 it('rejects extra keys and invalid alternative numbers',()=>{
  expect(estimateConditionsSchema.safeParse({...conditions,reportBlocker:{remainingSeconds:-1,errorPercent:1}}).success).toBe(false);
  expect(estimateConditionsSchema.safeParse({...conditions,secret:'private'}).success).toBe(false);
 });
 it('keeps source and pinned JSON schema aligned',()=>{
  const schema=JSON.parse(readFileSync(new URL('../../src/estimation/assets/observer.schema.json',import.meta.url),'utf8'));
  expect(schema.required).toContain('estimateConditions');
  expect(schema.properties.estimateConditions.properties.selectedPath.enum).toEqual(['continue_work','report_blocker','unknown']);
  expect(readFileSync(new URL('../../src/estimation/assets/observer-instructions.md',import.meta.url),'utf8')).toContain(estimateConditionsInstructions);
 });
});
