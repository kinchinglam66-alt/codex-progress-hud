import { expect, it } from "vitest";
import { runControlledCall, collectionMustStop } from "../../src/evaluation/controlled-call.js";
import type { Invocation, OwnedProcessResult } from "../../src/estimation/owned-process.js";
import { createOwnedProcessRunner } from "../../src/estimation/owned-process.js";
import { runControlledTask } from '../../src/evaluation/controlled-task.js';
const invocation:Invocation={executable:process.execPath,cwd:process.cwd(),args:[],env:{},input:"fixture"};
const result:OwnedProcessResult={reason:"exited",exitCode:0,closed:true,stdout:"",stderr:""};
function setup(admitted:number|null=1) {
  const settlements:unknown[]=[];let launches=0;
  const ledger={reserve:async()=>admitted,settle:async(id:number,usage:unknown)=>{settlements.push({id,usage});}};
  const runner={run:async(i:Invocation)=>{
    launches++;
    i.onStdout!(Buffer.from([
      {type:"turn.started"},
      {type:"item.completed",item:{type:"agent_message",text:'{"sql":"SELECT 1"}'}},
      {type:"turn.completed",usage:{input_tokens:10,output_tokens:5}}
    ].map(x=>JSON.stringify(x)).join("\n")));
    return result;
  }};
  return {ledger,runner,settlements,launches:()=>launches};
}
it("never launches an unreserved call",async()=>{
  const s=setup(null);
  const value=await runControlledCall({...s,invocation,task:"sample_a",kind:"workload",signal:new AbortController().signal});
  expect(value.status).toBe("not_admitted");expect(s.launches()).toBe(0);expect(s.settlements).toEqual([]);
});
it('does not cancel an admitted workload when an optional estimator is refused',async()=>{
  const s=setup(null);
  const rejected=await runControlledCall({...s,invocation,task:'sample_a',kind:'estimator',signal:new AbortController().signal});
  expect(collectionMustStop('estimator',rejected,{unreconciledUnknown:0,overrun:false})).toBe(false);
  expect(collectionMustStop('workload',rejected,{unreconciledUnknown:0,overrun:false})).toBe(true);
  expect(collectionMustStop('estimator',rejected,{unreconciledUnknown:1,overrun:false})).toBe(true);
  expect(collectionMustStop('estimator',rejected,{unreconciledUnknown:0,overrun:true})).toBe(true);
  expect(collectionMustStop('estimator',{...rejected,reservationId:2},{unreconciledUnknown:0,overrun:false})).toBe(true);
  expect(s.launches()).toBe(0);
  for(const patch of [{closed:false},{requestedAt:'observed'},{deliveredAt:'observed'},
    {durationMs:0},{processReason:'exited'},
    {usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0}},{answer:{lowSeconds:1,highSeconds:2}}]){
    expect(collectionMustStop('estimator',{...rejected,...patch},{unreconciledUnknown:0,overrun:false})).toBe(true);
  }
});
it('finishes an admitted workload after optional sampling admission is denied',async()=>{
  const controller=new AbortController(),s=setup(),denied=setup(null);
  let release!:()=>void;
  const sampled=new Promise<void>(resolve=>{release=resolve;});
  const rows:Record<string,unknown>[]=[];
  const outcome=await runControlledTask({key:'sample_a',prompt:'fixture',sampleMs:[0],
    emit:async row=>{rows.push(row);},
    call:async kind=>{
      const dependencies=kind==='workload'?{
        ledger:s.ledger,
        runner:{run:async(i:Invocation)=>{await sampled;if(controller.signal.aborted)throw Error('cancelled');return s.runner.run(i);}}
      }:denied;
      const value=await runControlledCall({...dependencies,invocation,task:'sample_a',kind,signal:controller.signal});
      if(collectionMustStop(kind,value,{unreconciledUnknown:0,overrun:false}))controller.abort();
      if(kind==='estimator')release();
      return value;
    },validate:async()=>({passed:true,cases:8,passedCases:8,error:null})});
  expect(outcome.outcome).toBe('verified');
  expect(controller.signal.aborted).toBe(false);
  expect(s.launches()).toBe(1);expect(denied.launches()).toBe(0);
  expect(rows.find(x=>x.type==='prediction')).toMatchObject({result:{status:'not_admitted',reservationId:null}});
});
it("accounts the closed complete call and records measured request/delivery times",async()=>{
  const s=setup();
  const value=await runControlledCall({...s,invocation,task:"sample_a",kind:"workload",signal:new AbortController().signal});
  expect(value.status).toBe("answered");expect(value.answer).toEqual({sql:"SELECT 1"});
  expect(value.durationMs).toBeGreaterThanOrEqual(0);
  expect(s.settlements).toEqual([{id:1,usage:{inputTokens:10,outputTokens:5,cachedInputTokens:null}}]);
});
it("does not expose a prediction or trust usage until child closure",async()=>{
  const s=setup();const original=s.runner.run;
  s.runner.run=async i=>({...await original(i),closed:false,reason:"cleanup_timeout"});
  const value=await runControlledCall({...s,invocation,task:"sample_a",kind:"workload",signal:new AbortController().signal});
  expect(value.status).toBe("process_error");expect(value.answer).toBeNull();
  expect(s.settlements).toEqual([{id:1,usage:null}]);
});
it("settles an uncertain runner exception as unknown rather than free",async()=>{
  const s=setup();s.runner.run=async()=>{throw Error("private provider details");};
  const value=await runControlledCall({...s,invocation,task:"sample_a",kind:"estimator",signal:new AbortController().signal});
  expect(value.status).toBe("process_error");expect(JSON.stringify(value)).not.toContain("private");
  expect(s.settlements).toEqual([{id:1,usage:null}]);
});
it("signals the shared owner on unknown output and on settlement failure",async()=>{
  const s=setup();let stopped=0;
  s.runner.run=async()=>result;
  await runControlledCall({...s,invocation,task:"sample_a",kind:"workload",signal:new AbortController().signal,
    onUnsafe:()=>{stopped++;}});
  expect(stopped).toBeGreaterThan(0);
  stopped=0;const t=setup();t.ledger.settle=async()=>{throw Error("disk failure");};
  await expect(runControlledCall({...t,invocation,task:"sample_a",kind:"workload",signal:new AbortController().signal,
    onUnsafe:()=>{stopped++;}})).rejects.toThrow();
  expect(stopped).toBeGreaterThan(0);
});
it("parses and accounts a real isolated fixture child without model calls",async()=>{
  const s=setup();
  const events=[{type:"turn.started"},
    {type:"item.completed",item:{type:"agent_message",text:'{"lowSeconds":2,"highSeconds":8}'}},
    {type:"turn.completed",usage:{input_tokens:12,output_tokens:4,cached_input_tokens:3}}];
  const input={...invocation,args:["-e",`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(events.map(x=>JSON.stringify(x)).join("\n"))}));`]};
  const value=await runControlledCall({...s,runner:createOwnedProcessRunner({timeoutMs:5000}),
    invocation:input,task:"sample_a",kind:"estimator",signal:new AbortController().signal});
  expect(value.status).toBe("answered");expect(value.closed).toBe(true);
  expect(value.answer).toEqual({lowSeconds:2,highSeconds:8});
  expect(s.settlements).toEqual([{id:1,usage:{inputTokens:12,outputTokens:4,cachedInputTokens:3}}]);
});
it.each(["malformed","settlement","runner_exception"])("stops a live sibling on %s without waiting for its deadline",async fault=>{
  const controller=new AbortController();
  const sibling=createOwnedProcessRunner({timeoutMs:5000}),trigger=createOwnedProcessRunner({timeoutMs:5000});
  const stop=()=>{controller.abort();sibling.disable();trigger.disable();};
  let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  const s=setup();
  const siblingInvocation={...invocation,args:["-e",'process.stdout.write(JSON.stringify({type:"turn.started"})+"\\n");setInterval(()=>{},1000);']};
  const siblingPromise=runControlledCall({...s,task:"sample_peer",kind:"estimator",invocation:siblingInvocation,signal:controller.signal,onUnsafe:stop,
    runner:{run:(i,signal)=>sibling.run({...i,onStdout:chunk=>{ready();return i.onStdout!(chunk);}},signal)}});
  try {
    await started;
    const triggerInput={...invocation,args:["-e",fault==="malformed"?'process.stdout.write("not json\\n")':'process.stdout.write([JSON.stringify({type:"turn.started"}),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({sql:"SELECT 1"})}}),JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})].join("\\n"))']};
    if(fault==="settlement")s.ledger.settle=async()=>{throw Error("fixture accounting failure");};
    const failing=runControlledCall({...s,task:"sample_trigger",kind:"workload",invocation:triggerInput,signal:controller.signal,onUnsafe:stop,
      runner:fault==="runner_exception"?{run:async()=>{throw Error("fixture runner failure");}}:trigger});
    const results=await Promise.allSettled([failing,siblingPromise]);
    expect(controller.signal.aborted).toBe(true);
    expect(sibling.status().active).toBe(false);expect(trigger.status().active).toBe(false);
    if(results[1]!.status==="fulfilled")expect(results[1]!.value).toMatchObject({closed:true,processReason:"aborted"});
  }finally{stop();await siblingPromise.catch(()=>undefined);}
});
