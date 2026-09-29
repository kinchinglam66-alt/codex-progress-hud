import {it,expect} from 'vitest';
import {objectiveState,TASK_OBJECTIVE_TARGET} from '../../src/core/task-objective.js';
import {createProductionPassiveGoals,type GoalContextSource} from '../../src/server/passive-goals.js';
import {PassiveContextStore} from '../../src/server/passive-context-store.js';
import {normalizeHookInput} from '../../src/hooks/schema.js';
import {buildConversationViews} from '../../src/ui/view-model.js';
import {etaClockTicks} from '../../src/ui/eta-clock-policy.js';
import {observerInputSchema} from '../../src/estimation/observer-contract.js';
type Evidence=NonNullable<ReturnType<NonNullable<GoalContextSource['execution']>>>;
function fixture(){
 let evidence:Evidence={state:'running',identity:'start',startedAtMs:0,wallClockBoundaryMs:0};
 const source:GoalContextSource={epoch:()=>1,read:()=>null,execution:()=>evidence};
 const contexts=new PassiveContextStore(),goals=createProductionPassiveGoals(contexts,source);
 const e=normalizeHookInput('UserPromptSubmit',{session_id:'objective-test',turn_id:'one'},0,'test-protected-token-1234567890123456789').envelope;
 e.content={kind:'user',text:'Repair all 100 files and validate them',truncated:false};
 contexts.ingest(e,0);goals.observe(e,true,0);goals.reconcileSource(e.sessionKey,0);
 return {goals,key:e.sessionKey,set:(v:Evidence,at:number)=>{evidence=v;goals.reconcileSource(e.sessionKey,at);},view:(at:number)=>goals.view(e.sessionKey,at)!};
}
it('normal native end defaults to product completion without an achievement certificate',()=>{
 const f=fixture();f.set({state:'waiting',outcome:'completed',identity:'end',wallClockBoundaryMs:1000},1000);
 expect(f.view(2000)).toMatchObject({predictionTarget:TASK_OBJECTIVE_TARGET,objectiveState:'completed',status:'completed',activeSeconds:1,prediction:null});
 expect(etaClockTicks(f.view(2000))).toBe(false);
});
it('approval with continuing work does not stop objective time',()=>{
 const f=fixture();f.set({state:'running',identity:'approval',wallClockBoundaryMs:1000,
 attention:{required:true,evidenceRef:'native:approval',relevantWorkRunning:true}},1000);
 expect(f.view(5000)).toMatchObject({objectiveState:'ongoing',attentionRequired:true,attentionWorkContinuing:true,activeSeconds:5,humanBlocked:false});
 expect(etaClockTicks(f.view(5000))).toBe(true);
});
it('contradictory full blockage cannot deduct confirmed background execution',()=>{
 const f=fixture();f.set({state:'waiting',identity:'overlap',wallClockBoundaryMs:1000,
 attention:{required:true,evidenceRef:'native:approval',relevantWorkRunning:true},
 humanBlock:{humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false,evidenceRef:'native:wait'}},1000);
 expect(f.view(5000)).toMatchObject({activeSeconds:5,humanBlocked:false});
});
it('confirmed complete human blockage pauses without completing the objective',()=>{
 const f=fixture();f.set({state:'waiting',identity:'blocked',wallClockBoundaryMs:1000,
 humanBlock:{humanActionRequired:true,wholeTurnBlocked:true,relevantWorkRunning:false,evidenceRef:'native:wait'}},1000);
 expect(f.view(5000)).toMatchObject({objectiveState:'ongoing',attentionRequired:true,activeSeconds:1,humanBlocked:true});
});
it('crash midway is interruption, never successful completion',()=>{
 const f=fixture();f.set({state:'failed',outcome:'failed',identity:'crash',wallClockBoundaryMs:1000},1000);
 expect(f.view(5000)).toMatchObject({objectiveState:'interrupted',activeSeconds:1,prediction:null});
});
it('bound negative evidence interrupts; missing or mismatched evidence defaults to completed',()=>{
 expect(objectiveState('a','completed',{targetId:'a',verdict:'achieved',evidenceRefs:['test:all100']})).toBe('completed');
 expect(objectiveState('a','completed',{targetId:'b',verdict:'achieved',evidenceRefs:['test:all100']})).toBe('completed');
 expect(objectiveState('a','completed',{targetId:'a',verdict:'achieved',evidenceRefs:[]})).toBe('completed');
 expect(objectiveState('a','completed',{targetId:'b',verdict:'not_achieved',evidenceRefs:['other:turn']})).toBe('completed');
 expect(objectiveState('a','completed',{targetId:'a',verdict:'not_achieved',evidenceRefs:['check:50of100']})).toBe('interrupted');
 expect(objectiveState('a',undefined,{targetId:'a',verdict:'achieved',evidenceRefs:['claim']})).toBe('ongoing');
 expect(objectiveState('a','interrupted',{targetId:'a',verdict:'achieved',evidenceRefs:['claim']})).toBe('interrupted');
 expect(objectiveState('a','failed',{targetId:'a',verdict:'achieved',evidenceRefs:['claim']})).toBe('interrupted');
});
it('unknown source or elapsed time alone does not produce interruption',()=>{
 const f=fixture();f.set({state:'unknown',identity:'disconnected',wallClockBoundaryMs:1000},1000);
 expect(f.view(5000).objectiveState).toBe('ongoing');
});
it('normal completion leaves the active list, including legacy unverified snapshots',()=>{
 const f=fixture();f.set({state:'waiting',outcome:'completed',identity:'end',wallClockBoundaryMs:1000},1000);
 const rows=[{conversationKey:'key',task:{id:'t'},name:{value:'task',freshness:'fresh'},goal:f.view(2000),eta:null}];
 const views=buildConversationViews(rows as unknown as Parameters<typeof buildConversationViews>[0]);
 expect(views).toHaveLength(0);
 rows[0]!.goal={...rows[0]!.goal,objectiveState:'unverified',status:'unknown'};
 expect(buildConversationViews(rows as unknown as Parameters<typeof buildConversationViews>[0])).toHaveLength(0);
});
it('same native turn keeps its target across new process instances',()=>{
 expect(fixture().view(0).objectiveTargetId).toBe(fixture().view(0).objectiveTargetId);
});
it('marks actual requests and rejects blocker ETA and model-only completion',()=>{
 const contexts=new PassiveContextStore(),goals=createProductionPassiveGoals(contexts);
 const e=normalizeHookInput('UserPromptSubmit',{session_id:'input-test',turn_id:'one'},0,'test-protected-token-1234567890123456789').envelope;
 e.content={kind:'user',text:'Repair all 100 files',truncated:false};contexts.ingest(e,0);goals.observe(e,true,0);
 const request=goals.request(e.sessionKey,0)!;
 expect(request.input).toMatchObject({predictionTarget:TASK_OBJECTIVE_TARGET,objectiveTargetId:goals.view(e.sessionKey,0)?.objectiveTargetId});
 expect(observerInputSchema.safeParse(request.input).success).toBe(true);
 expect(observerInputSchema.safeParse({...request.input,objectiveTargetId:undefined}).success).toBe(false);
 const estimate={remainingSeconds:120,errorPercent:40};
 expect(goals.settle(request.ticket,{relation:'replace',status:'running',summary:'Repair 100 files',estimate,
 estimateConditions:{selectedPath:'report_blocker',continueWork:null,reportBlocker:estimate,milestonePath:'unknown'}},1000)).toBe(false);
 expect(goals.view(e.sessionKey,1000)?.objectiveState).toBe('ongoing');
});
