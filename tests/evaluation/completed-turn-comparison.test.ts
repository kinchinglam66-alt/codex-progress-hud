import {expect,it} from 'vitest';
import {createCompletedTurnComparisonFixtures,evaluateSourceCorrection} from '../../src/evaluation/native-comparison-fixture.js';
import {createCompletedTurnForkRegistry} from '../../src/evaluation/native-comparison-input.js';
it('uses long active workloads and a fresh early prefix for paired qualification without leaking answers',()=>{
 const options={sourceThreadId:'77777777-7777-4777-8777-777777777777',cwd:process.cwd(),targetBytes:85*1024,qualification:true,qualificationNonce:'11111111-1111-4111-8111-111111111111'};
 const fixtures=createCompletedTurnComparisonFixtures(options);
 const workloads=fixtures.map(f=>f.rollout.trim().split('\n').map(line=>JSON.parse(line).payload)
  .filter(row=>row.type==='function_call_output'&&row.output.startsWith('{')).map(row=>JSON.parse(row.output)).at(-1));
 expect(workloads.map(row=>row?.remainingUnits)).toEqual([15,12,20]);
 expect(workloads.every(row=>row.activeSecondsPerUnit===100&&row.parallelism===1&&row.requiredBeforeTurnEnds===true)).toBe(true);
 expect(fixtures[1]!.rollout.startsWith(fixtures[0]!.rollout)).toBe(true);
 expect(fixtures[2]!.rollout.startsWith(fixtures[1]!.rollout)).toBe(true);
 const firstUser=fixtures[0]!.rollout.trim().split('\n').map(line=>JSON.parse(line).payload).find(row=>row.role==='user');
 expect(firstUser.content[0].text).toContain(options.qualificationNonce);
 const other=createCompletedTurnComparisonFixtures({...options,qualificationNonce:'22222222-2222-4222-8222-222222222222'});
 expect(other[0]!.contextHash).not.toBe(fixtures[0]!.contextHash);
 for(const row of fixtures)expect(row.requestText+row.sourceGoal).not.toMatch(/1500|1200|2000|AMBER/);
 const {qualificationNonce:unusedNonce,...missingNonce}=options;
 expect(()=>createCompletedTurnComparisonFixtures(missingNonce)).toThrow();
 expect(()=>createCompletedTurnComparisonFixtures({...options,sourceCorrection:true})).toThrow();
});
it.each([
 [180,7200,'passed'],[999,7000,'passed'],[180,6999,'failed'],[1000,7200,'inconclusive'],
 [undefined,7200,'inconclusive'],[180,undefined,'inconclusive'],[NaN,7200,'failed'],[180,Infinity,'failed'],[-1,7200,'failed']
] as const)('scores source correction %s → %s as %s without treating missing evidence as success',(before,after,status)=>{
 expect(evaluateSourceCorrection(before,after).status).toBe(status);
});
it('appends changed workload facts without rewriting earlier source or leaking the expected horizon into the request',()=>{
 const options={sourceThreadId:'77777777-7777-4777-8777-777777777777',cwd:process.cwd(),targetBytes:85*1024};
 const normal=createCompletedTurnComparisonFixtures(options);
 const corrected=createCompletedTurnComparisonFixtures({...options,sourceCorrection:true});
 expect(corrected[0]!.rollout).toBe(normal[0]!.rollout);
 expect(corrected[1]!.rollout.startsWith(corrected[0]!.rollout)).toBe(true);
 expect(corrected[2]!.rollout.startsWith(corrected[1]!.rollout)).toBe(true);
 const suffix=corrected[1]!.rollout.slice(corrected[0]!.rollout.length).trim().split('\n').map(line=>JSON.parse(line).payload);
 const output=suffix.find(row=>row.type==='function_call_output');
 expect(output).toBeDefined();
 const workload=JSON.parse(output.output);
 expect(workload).toMatchObject({workloadId:'SAPPHIRE-9082',remainingUnits:72,activeSecondsPerUnit:100,parallelism:1});
 expect(suffix.some(row=>row.type==='function_call'&&row.call_id===output.call_id)).toBe(true);
 expect(corrected[1]!.expectedMarkers).toContain('SAPPHIRE-9082');
 expect(corrected[0]!.expectedMarkers).not.toContain('SAPPHIRE-9082');
 for(const row of corrected)expect(row.requestText).not.toMatch(/SAPPHIRE|7200|7,200|7000|7,000/);
 expect(createCompletedTurnComparisonFixtures({...options,sourceCorrection:false})).toEqual(normal);
});
it('records reuse only for a child bound to the same owner, source turn and cutoff',()=>{
 const r=createCompletedTurnForkRegistry(true);r.begin('first','root','six','process','seven');
 r.record('first',{threadId:'root',path:'snapshot',lastTurnId:'six'},'base');
 r.record('first',{threadId:'base',lastTurnId:'six'},'child');
 r.begin('second','root','six','process','seven');r.reuse('second','child');
 expect(r.require('second')).toBe('child');
 expect(r.snapshot().at(-1)).toEqual({request:'second',role:'reused-child',forkId:'child'});
 expect(()=>r.reuse('second','child')).toThrow();
 for(const [label,cutoff,owner,turn] of [['turn','six','process','eight'],['owner','six','other','seven'],['cutoff','five','process','seven']]){
  r.begin(label!,'root',cutoff!,owner!,turn!);expect(()=>r.reuse(label!,'child')).toThrow();
 }
 const control=createCompletedTurnForkRegistry();control.begin('x','root','six','process');
 expect(()=>control.reuse('x','child')).toThrow();
});
it.each([85*1024,1024*1024])('builds append-only completed history and current supplements for %i bytes',target=>{
 const fixtures=createCompletedTurnComparisonFixtures({sourceThreadId:'77777777-7777-4777-8777-777777777777',cwd:process.cwd(),targetBytes:target});
 expect(fixtures).toHaveLength(3);expect(Buffer.byteLength(fixtures[0]!.rollout)).toBeGreaterThanOrEqual(target);
 expect(fixtures[1]!.rollout.startsWith(fixtures[0]!.rollout)).toBe(true);expect(fixtures[2]!.rollout.startsWith(fixtures[1]!.rollout)).toBe(true);
 const first=fixtures[0]!.rollout.trimEnd().split('\n').map(x=>JSON.parse(x));
 expect(first.filter(x=>x.payload.type==='task_complete')).toHaveLength(6);
 expect(new Set(fixtures.map(x=>x.contextHash)).size).toBe(3);
 const started=first.length-1-[...first].reverse().findIndex(x=>x.payload.type==='task_started');
 expect(JSON.stringify(first.slice(started))).not.toContain(fixtures[0]!.expectedMarkers[0]);
 expect(fixtures[0]!.lastCompletedTurnId).toBe(fixtures[1]!.lastCompletedTurnId);
 expect(fixtures[2]!.lastCompletedTurnId).toBe(fixtures[1]!.currentTurnId);
});
it('counts only one fresh ETA child per request, retaining base per process and cutoff',()=>{
 const r=createCompletedTurnForkRegistry();r.begin('first','root','six','process-1');
 r.record('first',{threadId:'root',path:'snapshot',lastTurnId:'six'},'base');
 r.record('first',{threadId:'base',lastTurnId:'six'},'child-1');expect(r.require('first')).toBe('child-1');
 r.begin('second','root','six','process-1');r.record('second',{threadId:'base',lastTurnId:'six'},'child-2');
 expect(r.require('second')).toBe('child-2');expect(r.snapshot().filter(x=>x.role==='base')).toHaveLength(1);
 expect(()=>r.record('second',{threadId:'base',lastTurnId:'six'},'child-3')).toThrow();
 r.begin('third','root','six','process-2');expect(()=>r.record('third',{threadId:'child-1',lastTurnId:'six'},'child-4')).toThrow();
 expect(()=>r.record('third',{threadId:'root',path:'snapshot',lastTurnId:'wrong'},'base-2')).toThrow();
});
