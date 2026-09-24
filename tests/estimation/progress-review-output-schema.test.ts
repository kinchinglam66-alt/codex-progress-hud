import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {bindProgressReviewOutputSchema} from '../../src/estimation/progress-review-output-schema.js';
import {createProgressState,progressScope,applyProgress,observeProgress} from '../../src/estimation/progress-state.js';
import {serializeObserverTransport} from '../../src/estimation/context-compression.js';
const schema=JSON.parse(readFileSync(new URL('../../src/estimation/assets/observer.schema.json',import.meta.url),'utf8'));
function state(task='one'){
 const s=createProgressState(progressScope(task,'turn',1,0));
 observeProgress(s,[{kind:'tool',text:'tests',event:{kind:'tool_start',ordinal:1,atMs:1000,pairOrdinal:0}}]);
 applyProgress(s,{definition:'tests',completionCriterion:'semantic',criterion:'reviewed',operationRef:null,estimate:null},null,null,0);
 return s;
}
const bind=(progressState?:ReturnType<typeof state>)=>bindProgressReviewOutputSchema(schema,{progressState}) as any;
it('binds exact milestone and current refs while retaining nullable review and other output fields',()=>{
 const s=state(),result=bind(s),p=result.properties.progressReview;
 expect(p.type).toEqual(['object','null']);
 expect(p.properties.milestoneId.enum).toEqual([s.milestone!.id]);
 expect(p.properties.evidenceRefs.items.enum).toEqual(s.operations.map(o=>o.evidenceRef));
 expect(p.properties.assessment).toEqual(schema.properties.progressReview.properties.assessment);
 expect(result.properties.estimate).toEqual(schema.properties.estimate);
 expect(result.properties.completionOutlook).toEqual(schema.properties.completionOutlook);
 expect(p.properties.evidenceRefs.maxItems).toBe(8);
});
it('isolates successive task and turn schemas without mutating a shared template or input',()=>{
 const a=state(),before=structuredClone(a),original=structuredClone(schema),b=state('two');
 const left=bind(a),right=bind(b);
 expect(left.properties.progressReview.properties.evidenceRefs.items.enum).not.toEqual(right.properties.progressReview.properties.evidenceRefs.items.enum);
 expect(schema).toEqual(original);expect(a).toEqual(before);
 right.properties.progressReview.properties.evidenceRefs.items.enum.push('forged');
 expect(bind(b).properties.progressReview.properties.evidenceRefs.items.enum).not.toContain('forged');
});
it.each([false,true])('permits only null review without a current milestone (legacy=%s)',legacy=>{
 const s=createProgressState(progressScope('a','turn',1,0));
 expect(bind(legacy?undefined:s).properties.progressReview.type).toBe('null');
});
it('permits only empty refs for a milestone without supplied operations; never emits empty enum',()=>{
 const s=state();s.operations=[];
 const field=bind(s).properties.progressReview.properties.evidenceRefs;
 expect(field.maxItems).toBe(0);expect(field.items.enum).toBeUndefined();
});
it('removes an old running reference when its result arrives',()=>{
 const s=state(),old=s.operations[0]!.evidenceRef;
 observeProgress(s,[{kind:'tool',text:'tests',event:{kind:'tool_start',ordinal:1,atMs:1000,pairOrdinal:0}},
 {kind:'tool',text:'passed',event:{kind:'tool_result',ordinal:2,atMs:2000,pairOrdinal:0}}]);
 expect(bind(s).properties.progressReview.properties.evidenceRefs.items.enum).not.toContain(old);
});
it('retains custom schemas without a progress-review contract and rejects invalid supplied state',()=>{
 expect(bindProgressReviewOutputSchema({},{})).toEqual({});
 expect(()=>bindProgressReviewOutputSchema(schema,{progressState:{}})).toThrow();
});
it('includes request-bound refs in the real API serialization and capacity bytes',()=>{
 const s=state(),input={goalSummary:'test',activeSeconds:1,runtime:'running',messages:[{kind:'user',text:'test',truncated:false}],truncated:false,progressState:s};
 const body=JSON.parse(serializeObserverTransport(input,{model:'test',instructions:'test',schema,maxOutputTokens:200}));
 expect(body.text.format.schema).toEqual(bind(s));expect(body.text.format.strict).toBe(true);
});
