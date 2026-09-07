import { expect,it } from "vitest";
import { createControlledOutputParser } from "../../src/evaluation/controlled-output.js";
function stream(text:string) {return [
  {type:"thread.started",thread_id:"synthetic"},
  {type:"turn.started"},
  {type:"item.completed",item:{id:"item",type:"agent_message",text}},
  {type:"turn.completed",usage:{input_tokens:20,output_tokens:10,cached_input_tokens:5}}
].map(row=>JSON.stringify(row)).join("\n")+"\n";}
it("retains accounting even when a workload answer fails its schema",()=>{
  const parser=createControlledOutputParser("workload");
  expect(parser.push(Buffer.from(stream("invalid answer")))).toBe(true);
  expect(parser.end()).toEqual({answer:null,usage:{inputTokens:20,outputTokens:10,cachedInputTokens:5},status:"invalid_answer"});
});
it("extracts only bounded workload SQL and numeric estimates",()=>{
  const parser=createControlledOutputParser("workload");
  parser.push(Buffer.from(stream(JSON.stringify({sql:"SELECT 1"}))));
  expect(parser.end()).toMatchObject({status:"answered",answer:{sql:"SELECT 1"}});
  const estimate=createControlledOutputParser("estimator");
  estimate.push(Buffer.from(stream(JSON.stringify({lowSeconds:3,highSeconds:10}))));
  expect(estimate.end()).toMatchObject({status:"answered",answer:{lowSeconds:3,highSeconds:10}});
});
it("rejects tools and does not invent usage when the stream is incomplete",()=>{
  const parser=createControlledOutputParser("workload");
  expect(parser.push(Buffer.from(JSON.stringify({type:"item.started",item:{type:"command_execution",id:"x"}})+"\n"))).toBe(false);
  expect(parser.end()).toMatchObject({status:"protocol_error",usage:null,answer:null});
});
it("keeps estimator abstentions distinct from invalid predictions",()=>{
  const parser=createControlledOutputParser("estimator");
  parser.push(Buffer.from(stream(JSON.stringify({lowSeconds:null,highSeconds:null}))));
  expect(parser.end()).toMatchObject({status:"abstained",answer:null});
});
it("preserves only an allowlisted failure category, not private provider text",()=>{
  const parser=createControlledOutputParser("estimator");
  parser.push(Buffer.from(JSON.stringify({type:"turn.failed",error:{message:"HTTP 403 Forbidden https://private.example/account SECRET"}})+"\n"));
  expect(parser.diagnostic()).toBe("http_403");
  expect(parser.end()).toMatchObject({status:"protocol_error",usage:null});
  expect(JSON.stringify(parser.end())).not.toContain("SECRET");
});
it("accepts message and usage events after thread start when turn.started is omitted",()=>{
  const parser=createControlledOutputParser("estimator");
  const input=stream(JSON.stringify({lowSeconds:2,highSeconds:4})).split("\n").filter(x=>!x.includes('"type":"turn.started"')).join("\n");
  expect(parser.push(Buffer.from(input))).toBe(true);
  expect(parser.end()).toMatchObject({status:"answered",usage:{inputTokens:20,outputTokens:10}});
});
it("does not discard valid token accounting because the CLI adds a usage metadata field",()=>{
  const parser=createControlledOutputParser("workload");
  const input=stream(JSON.stringify({sql:"SELECT 1"})).replace('"cached_input_tokens":5','"cached_input_tokens":5,"total_tokens":30');
  expect(parser.push(Buffer.from(input))).toBe(true);
  expect(parser.end()).toMatchObject({usage:{inputTokens:20,outputTokens:10,cachedInputTokens:5},status:"answered"});
});
