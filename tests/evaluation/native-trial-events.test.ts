import {expect,it} from 'vitest';
import {classifyNativeTrialEvent,describeNativeTrialOutput} from '../../src/evaluation/native-trial-events.js';
it.each(['userMessage','agentMessage','reasoning','plan'])('does not mistake passive %s items for tool execution',type=>{
 expect(classifyNativeTrialEvent('item/started',type,'eta')).toBe('continue');
});
it.each(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','imageView','imageGeneration','sleep','hookPrompt','functionCallOutput','newUnknownType',undefined])('still stops unexpected executable or unknown %s items',type=>{
 expect(classifyNativeTrialEvent('item/started',type,'eta')).toBe('unexpected_item');
});
it('requires an admission for model turn starts and a dedicated admission for compaction',()=>{
 expect(classifyNativeTrialEvent('turn/started',undefined,undefined)).toBe('unexpected_turn');
 expect(classifyNativeTrialEvent('turn/started',undefined,'eta')).toBe('continue');
 expect(classifyNativeTrialEvent('item/started','contextCompaction','eta')).toBe('unexpected_compaction');
 expect(classifyNativeTrialEvent('item/started','contextCompaction','context_compression')).toBe('continue');
 expect(classifyNativeTrialEvent('thread/started',undefined,undefined)).toBe('continue');
});
it('distinguishes a valid ETA from malformed JSON without exposing answer text',()=>{
 const output=JSON.stringify({relation:'continue',status:'running',summary:'private source marker',estimate:{remainingSeconds:120,errorPercent:50}});
 expect(describeNativeTrialOutput(output)).toEqual({category:'valid',bytes:Buffer.byteLength(output),issues:[]});
 const bad=describeNativeTrialOutput('private not JSON');
 expect(bad).toEqual({category:'invalid_json',bytes:16,issues:[]});
 expect(JSON.stringify(bad)).not.toContain('private');
});
it('reports bounded schema field categories without values or raw validation messages',()=>{
 const output=JSON.stringify({relation:'secret relation',status:'secret status',summary:'private source marker',estimate:{remainingSeconds:-1,errorPercent:50}});
 const result=describeNativeTrialOutput(output);
 expect(result.category).toBe('invalid_schema');
 expect(result.issues.map(issue=>issue.field)).toEqual(expect.arrayContaining(['relation','status','estimate']));
 expect(result.issues.length).toBeLessThanOrEqual(12);
 expect(JSON.stringify(result)).not.toMatch(/private|secret|remainingSeconds/);
});
it('does not parse absent, empty or oversized diagnostic payloads',()=>{
 expect(describeNativeTrialOutput(undefined).category).toBe('missing');
 expect(describeNativeTrialOutput('').category).toBe('empty');
 expect(describeNativeTrialOutput('x'.repeat(262145)).category).toBe('oversize');
});
it('identifies conflicting unknown-state combinations without returning source values',()=>{
 const result=describeNativeTrialOutput(JSON.stringify({relation:'unknown',status:'unknown',summary:'private marker',estimate:null,work:null}));
 expect(result).toMatchObject({category:'invalid_schema',shape:{relation:'unknown',status:'unknown',summaryPresent:true,estimatePresent:false,workPresent:false}});
 expect(JSON.stringify(result)).not.toContain('private marker');
});
