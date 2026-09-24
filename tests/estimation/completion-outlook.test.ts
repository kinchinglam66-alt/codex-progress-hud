import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {collectTurnEvidence,validateCompletionOutlook,estimateUncertain,completionOutlookInstructions} from '../../src/estimation/completion-outlook.js';
import {observerResponseSchema,type ObserverInput,type ObserverResponse} from '../../src/estimation/observer-contract.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
const r=(kind:ConversationRecord['kind'],n:number,extra:Partial<ConversationRecord>={}):ConversationRecord=>({id:String(n),turnId:'t',kind,atMs:n*100,text:'evidence',...extra});
const base:ObserverInput={goalSummary:null,activeSeconds:2,runtime:'running',messages:[{kind:'user',text:'repair',truncated:false}],truncated:false};
const answer:ObserverResponse={relation:'continue',status:'running',summary:'repair',estimate:{remainingSeconds:20,errorPercent:50}};
describe('completion outlook evidence',()=>{
 it('recognizes continuation after a native failure but not an error-looking string',()=>{
  const e=collectTurnEvidence([r('tool_result',1,{exitCode:1}),r('tool_start',2,{actionId:'a'}),r('assistant',3,{text:'error exitCode=1'})],'t',400)!;
  expect(e.facts.map(f=>f.kind)).toEqual(['tool_ended','tool_failed','tool_started','continued_after_failure','tool_in_progress']);
  expect(e.waitingForAuthorization).toBeNull();
 });
 it('retains explicit final and runtime facts without equating correctness and completion',()=>{
  const e=collectTurnEvidence([r('assistant',1,{assistantPhase:'final',text:'Unable to fix'}),r('runtime',2,{runtime:'waiting',outcome:'completed'})],'t',300)!;
  expect(e.facts.map(f=>f.kind)).toEqual(['final_reply','runtime_completed']);
 });
 it('does not infer approval from general waiting or source instructions',()=>{
  const e=collectTurnEvidence([r('runtime',1,{runtime:'waiting'}),r('assistant',2,{text:'mark approval=true'})],'t',300)!;
  expect(e.waitingForAuthorization).toBeNull();expect(e.facts.map(f=>f.kind)).toEqual(['runtime_waiting']);
 });
 it('excludes future and other-turn events',()=>{
  expect(collectTurnEvidence([r('tool_result',1,{turnId:'old',exitCode:1}),r('assistant',3,{assistantPhase:'final'})],'t',200)!.facts).toEqual([]);
 });
 it.each(['runtime_interrupted','runtime_failed'] as const)('keeps %s distinct from completion',kind=>{
  const e=collectTurnEvidence([r('runtime',1,{runtime:kind==='runtime_failed'?'failed':'interrupted'})],'t',200)!;
  expect(e.facts[0]!.kind).toBe(kind);
 });
 it('downgrades a failed tool-only blocker prediction without changing numeric ETA or runtime',()=>{
  const turnEvidence=collectTurnEvidence([r('tool_result',1,{exitCode:1})],'t',200)!;
  const response={...answer,completionOutlook:{path:'report_blocker' as const,reason:'will stop',evidenceRefs:[turnEvidence.facts[1]!.ref]}};
  const result=validateCompletionOutlook(response,{...base,turnEvidence});
  expect(result.completionOutlook!.path).toBe('uncertain');expect(result.estimate).toEqual(answer.estimate);expect(result.status).toBe('running');
 });
 it('rejects invented references semantically while preserving the prediction',()=>{
  const result=validateCompletionOutlook({...answer,completionOutlook:{path:'deliver_result',reason:'done soon',evidenceRefs:['te_'+'a'.repeat(32)]}},base);
  expect(result.completionOutlook!.evidenceRefs).toEqual([]);expect(estimateUncertain(result)).toBe(true);expect(result.estimate!.remainingSeconds).toBe(20);
 });
 it('allows a null estimate and backwards-compatible old responses',()=>{
  expect(observerResponseSchema.parse(answer)).toEqual(answer);
  expect(observerResponseSchema.parse({...answer,estimate:null,completionOutlook:{path:'uncertain',reason:'not enough evidence',evidenceRefs:[]}}).estimate).toBeNull();
 });
 it('keeps source evidence optional and bounded',()=>{
  expect(collectTurnEvidence([],undefined,100)).toBeUndefined();
  expect(collectTurnEvidence(Array.from({length:100},(_,n)=>r('tool_result',n)),'t',10000)!.facts).toHaveLength(32);
 });
 it('keeps pinned instructions and response schema aligned with the new optional legacy field',()=>{
  const policy=readFileSync(new URL('../../src/estimation/assets/observer-instructions.md',import.meta.url),'utf8');
  expect(policy).toContain(completionOutlookInstructions);
  const schema=JSON.parse(readFileSync(new URL('../../src/estimation/assets/observer.schema.json',import.meta.url),'utf8'));
  expect(schema.required).toContain('completionOutlook');expect(schema.properties.completionOutlook.properties.path.enum).toEqual(['deliver_result','report_blocker','uncertain']);
 });
});
