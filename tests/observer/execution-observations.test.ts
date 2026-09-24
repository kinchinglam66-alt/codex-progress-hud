import {expect,it} from 'vitest';
import {executionObservations} from '../../src/observer/execution-observations.js';
import {assembleContext} from '../../src/observer/context-assembler.js';
import {packObserverInput} from '../../src/estimation/observer-input.js';
import type {ConversationRecord} from '../../src/observer/conversation-record.js';
import {observerInputSchema} from '../../src/estimation/observer-contract.js';
const r=(kind:ConversationRecord['kind'],atMs:number,actionId='a',turnId='t'):ConversationRecord=>
  ({id:`${kind}-${atMs}`,kind,atMs,actionId,turnId,text:'test'});
it('deduplicates repeated completions while allowing an explicit later start',()=>{
 const obs=executionObservations([r('tool_start',0),r('tool_result',1000),
  {...r('tool_result',1001),reportedExecutionSeconds:1},r('tool_start',2000),r('tool_result',3000)],'t',4000)!;
 expect(obs.samples).toHaveLength(2);expect(obs.reportedSamples).toEqual([]);
 const reported=executionObservations([{...r('tool_result',1000),reportedExecutionSeconds:1},
  {...r('tool_result',1001),reportedExecutionSeconds:1}],'t',2000)!;
 expect(reported.reportedSamples).toHaveLength(1);
});
it('stops at a regressing timestamp instead of inventing an ordered prefix',()=>{
 const obs=executionObservations([r('tool_start',2000),r('tool_result',1000),
  r('tool_start',3000,'b'),r('tool_result',4000,'b')],'t',5000)!;
 expect(obs.samples).toEqual([]);expect(obs.throughOrdinal).toBe(0);
});
it('rejects duplicated sample evidence at the model input boundary',()=>{
 const obs=executionObservations([r('tool_start',0),r('tool_result',1000),
  {...r('tool_result',2000,'b'),reportedExecutionSeconds:1}],'t',3000)!;
 const input={goalSummary:null,activeSeconds:3,runtime:'running',messages:[{kind:'user',text:'task',truncated:false}],truncated:false,executionObservations:obs};
 expect(observerInputSchema.safeParse(input).success).toBe(true);
 const paired=structuredClone(input);paired.executionObservations.samples.push({...obs.samples[0]!});
 expect(observerInputSchema.safeParse(paired).success).toBe(false);
 const reported=structuredClone(input);reported.executionObservations.reportedSamples.push({...obs.reportedSamples[0]!});
 expect(observerInputSchema.safeParse(reported).success).toBe(false);
});
it('does not double count paired and native-reported duration or import future results',()=>{
 const obs=executionObservations([r('tool_start',0),{...r('tool_result',1000),reportedExecutionSeconds:0.5},
  {...r('tool_result',3000,'b'),reportedExecutionSeconds:2}],'t',2000)!;
 expect(obs.samples).toHaveLength(1);expect(obs.reportedSamples).toEqual([]);
});
it('does not conflate argv boundaries or argv with a shell string',()=>{
 const records=[['echo','a b'],['echo','a','b'],'["echo","a b"]'].flatMap((command,i)=>[
  {...r('tool_start',i*2000),toolName:'CommandExecution',cwd:'/app',
    ...(typeof command==='string'?{command}:{commandArgv:command})},r('tool_result',i*2000+1000)]);
 const groups=executionObservations(records,'t',6000)!.comparableGroups;
 expect(groups).toHaveLength(3);expect(new Set(groups.map(g=>g.operationKey)).size).toBe(3);
});
it('summarizes only exact nonoverlapping operations with an explicit sample threshold',()=>{
 const records=[1,3,2].flatMap((duration,i)=>[
  {...r('tool_start',i*10000),toolName:'exec',cwd:'/app',command:'pytest tests/unit'},
  r('tool_result',i*10000+duration*1000)]);
 const obs=executionObservations(records,'t',30000)!;
 expect(obs.comparableGroups).toHaveLength(1);
 expect(obs.comparableGroups[0]).toMatchObject({count:3,medianSeconds:2,minSeconds:1,maxSeconds:3,minimumSampleCountMet:true,sampleEndOrdinals:[1,3,5]});
 expect(executionObservations(records.slice(0,4),'t',30000)!.comparableGroups[0]?.minimumSampleCountMet).toBe(false);
 expect(obs.extrapolationAllowed).toBe(false);
 const input={goalSummary:null,activeSeconds:30,runtime:'running',messages:[{kind:'user',text:'task',truncated:false}],truncated:false,executionObservations:obs};
 expect(observerInputSchema.safeParse(input).success).toBe(true);
 const tampered=structuredClone(input);tampered.executionObservations.comparableGroups[0]!.medianSeconds=99;
 expect(observerInputSchema.safeParse(tampered).success).toBe(false);
});
it('does not pool distinct commands, unknown locations, or concurrent samples',()=>{
 const start=(at:number,id:string,command:string,cwd='/app')=>({...r('tool_start',at,id),toolName:'exec',command,cwd});
 const obs=executionObservations([start(0,'a','test a'),r('tool_result',1000,'a'),
  start(2000,'b','test b'),r('tool_result',3000,'b'),start(4000,'c','test a',''),r('tool_result',5000,'c'),
  start(6000,'d','test a'),start(6500,'e','test a'),r('tool_result',7000,'d'),r('tool_result',7500,'e')],'t',8000)!;
 expect(obs.comparableGroups.map(g=>g.count)).toEqual([1,1]);
});
it('keeps the latest five observed pairs with prefix-local references',()=>{
 const records=Array.from({length:7},(_,i)=>[r('tool_start',i*2000),r('tool_result',i*2000+1000)]).flat();
 const result=executionObservations(records,'t',14000)!;
 expect(result.samples).toHaveLength(5);expect(result.samples[0]?.startOrdinal).toBe(4);
 expect(result.samples.every(s=>s.elapsedSeconds===1&&!s.overlapsOtherTool)).toBe(true);
 expect(result.extrapolationAllowed).toBe(false);
});
it('excludes unknown identity, old turns, waits, and ambiguous pairs',()=>{
 expect(executionObservations([],null,100)).toBeUndefined();
 const records=[r('tool_start',0),r('tool_start',1),r('tool_result',2),
  r('tool_start',3),{...r('runtime',4),runtime:'waiting' as const},r('tool_result',5),
  r('tool_start',6,'b','old'),r('tool_result',7,'b')];
 expect(executionObservations(records,'t',10)?.samples).toEqual([]);
});
it('does not include future outcomes or skip forward past future records',()=>{
 expect(executionObservations([r('tool_start',0),r('tool_result',20),r('tool_result',5)],'t',10)?.samples).toEqual([]);
});
it('marks overlapping and outstanding tools without summing them',()=>{
 const result=executionObservations([r('tool_start',0),r('tool_start',1,'b'),r('tool_result',2)],'t',3)!;
 expect(result.samples[0]?.overlapsOtherTool).toBe(true);
});
it('retains overlap evidence even when the other tool later crosses a wait boundary',()=>{
 const result=executionObservations([r('tool_start',0,'b'),r('tool_start',1),r('tool_result',2),
  {...r('runtime',3),runtime:'waiting'}],'t',4)!;
 expect(result.samples[0]?.overlapsOtherTool).toBe(true);
});
it('survives the actual observer input serialization path',()=>{
 const packet=assembleContext([r('user',0),r('tool_start',100),r('tool_result',1100)],{
  currentTurnId:'t',summary:null,summaryThroughSequence:0,sequence:3,activeSeconds:2,
  activeTimeKnown:true,historyComplete:true,nowMs:2000,previousEstimate:null});
 const encoded=JSON.parse(packObserverInput(packet));
 expect(encoded.executionObservations.samples[0].elapsedSeconds).toBe(1);
 expect(encoded.executionObservations.samples[0].startOrdinal).toBe(1);
});
