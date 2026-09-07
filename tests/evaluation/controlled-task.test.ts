import { expect,it } from "vitest";
import { runControlledTask } from "../../src/evaluation/controlled-task.js";
import type { ControlledCallResult } from "../../src/evaluation/controlled-call.js";
const answer:ControlledCallResult={reservationId:1,status:"answered",answer:{sql:"SELECT 1"},usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0},requestedAt:"fixture",deliveredAt:"fixture",durationMs:1,closed:true,processReason:"exited"};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it("ends at independent validation, records late ETA and does not count it as timely",async()=>{
  const rows:any[]=[];
  await runControlledTask({key:"sample_a",prompt:"fixture",sampleMs:[0,5],emit:async row=>{rows.push(row);},
    call:async kind=>{await sleep(kind==="workload"?15:50);return {...answer,answer:kind==="workload"?{sql:"SELECT 1"}:{lowSeconds:1,highSeconds:2}};},
    validate:async()=>({passed:true,cases:8,passedCases:8,error:null})});
  expect(rows.find(x=>x.type==="end").outcome).toBe("verified");
  expect(rows.find(x=>x.type==="prediction").late).toBe(true);
  expect(rows.some(x=>x.type==="sample_skipped" && x.reason==="busy")).toBe(true);
  expect(rows.filter(x=>x.type==="workload")).toHaveLength(1);
});
it("permits exactly one validated repair and preserves the failed attempt",async()=>{
  const rows:any[]=[];let attempts=0;
  await runControlledTask({key:"sample_a",prompt:"fixture",sampleMs:[],emit:async row=>{rows.push(row);},call:async()=>answer,
    validate:async()=>({passed:++attempts===2,cases:8,passedCases:attempts===2?8:0,error:null})});
  expect(rows.filter(x=>x.type==="workload")).toHaveLength(2);
  expect(rows.find(x=>x.type==="end").outcome).toBe("verified");
});
it("does not retry transport failure or hide missing predictions",async()=>{
  const rows:any[]=[];
  await runControlledTask({key:"sample_a",prompt:"fixture",sampleMs:[],emit:async row=>{rows.push(row);},
    call:async()=>({...answer,status:"process_error",answer:null,usage:null}),
    validate:async()=>{throw Error("must not validate");}});
  expect(rows.filter(x=>x.type==="workload")).toHaveLength(1);
  expect(rows.find(x=>x.type==="end").outcome).toBe("interrupted");
});
it("records terminal-cancelled sampling opportunities separately from busy skips",async()=>{
  const rows:any[]=[];
  await runControlledTask({key:"sample_a",prompt:"fixture",sampleMs:[5000],emit:async row=>{rows.push(row);},
    call:async()=>answer,validate:async()=>({passed:true,cases:8,passedCases:8,error:null})});
  expect(rows.filter(x=>x.type==="sample_skipped")).toEqual([
    expect.objectContaining({key:"sample_a",plannedMs:5000,reason:"task_ended"})]);
});
