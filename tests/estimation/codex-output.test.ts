import { expect, it } from "vitest";
import { createCodexOutputParser } from "../../src/estimation/codex-output.js";
const start={type:"turn.started"};
const message=(value:unknown)=>({type:"item.completed",item:{id:"item_1",type:"agent_message",text:JSON.stringify(value)}});
const done={type:"turn.completed",usage:{input_tokens:20,output_tokens:3,cached_input_tokens:5}};
const predict={lowSeconds:2,highSeconds:5};
it('accepts documented cache-write usage without adding it twice to input tokens',()=>{
 const result=parse([start,message(predict),{...done,usage:{...done.usage,cache_write_input_tokens:8,reasoning_output_tokens:1}}]);
 expect(result).toMatchObject({ok:true,prediction:predict,usage:{inputTokens:20,outputTokens:3,cachedInputTokens:5}});
});
it.each([-1,1.5,'8',null])('rejects malformed cache-write token count %j',value=>{
 expect(parse([start,message(predict),{...done,usage:{...done.usage,cache_write_input_tokens:value}}]).ok).toBe(false);
});
function parse(events:unknown[]) { const p=createCodexOutputParser(); p.push(Buffer.from(events.map(e=>JSON.stringify(e)).join("\n"))); return p.end(); }
it("parses complete output including a final line without newline",()=>{
  expect(parse([start,message(predict),done])).toEqual({ok:true,prediction:predict,usage:{kind:"subscription-tokens",inputTokens:20,outputTokens:3,cachedInputTokens:5},error:null});
});
it("handles UTF-8 split within a reasoning event without retaining reasoning",()=>{
  const p=createCodexOutputParser(); const bytes=Buffer.from([start,{type:"item.completed",item:{id:"item_0",type:"reasoning",text:"测试"}},message(predict),done].map(e=>JSON.stringify(e)).join("\n"));
  for (const b of bytes) expect(p.push(Uint8Array.of(b))).toBe(true);
  expect(p.end().prediction).toEqual(predict); expect(JSON.stringify(p.end())).not.toContain("测试");
});
it("represents an explicit unavailable estimate as null",()=>expect(parse([start,message({lowSeconds:null,highSeconds:null}),done])).toMatchObject({ok:true,prediction:null}));
it.each([{lowSeconds:5,highSeconds:2},{lowSeconds:null,highSeconds:2},{...predict,secret:"no"}])("rejects invalid estimates %j",value=>expect(parse([start,message(value),done]).ok).toBe(false));
it("rejects tool items immediately",()=>{ const p=createCodexOutputParser(); expect(p.push(Buffer.from(JSON.stringify({type:"item.started",item:{type:"command_execution"}})+"\n"))).toBe(false); expect(p.end().error).toBe("unexpected_tool"); });
it("rejects repeated completion and missing usage",()=>{
  expect(parse([start,message(predict),done,done]).ok).toBe(false);
  expect(parse([start,message(predict),{type:"turn.completed"}]).usage).toBeNull();
});
it("rejects malformed UTF-8 and non-JSON without returning raw input",()=>{
  const p=createCodexOutputParser(); expect(p.push(Uint8Array.of(0xff))).toBe(false); expect(p.end().error).toBe("encoding");
  const q=createCodexOutputParser(); expect(q.push(Buffer.from("secret\n"))).toBe(false); expect(JSON.stringify(q.end())).not.toContain("secret");
});
it("bounds oversized lines and total stream",()=>{
  const p=createCodexOutputParser(); expect(p.push(Buffer.alloc(16385,32))).toBe(false);
  const q=createCodexOutputParser(); expect(q.push(Buffer.alloc(262145))).toBe(false);
});
it("rejects duplicate thread starts and malformed retry events",()=>{
  expect(parse([{type:"thread.started",thread_id:"test"},{type:"thread.started",thread_id:"test2"},start,message(predict),done]).ok).toBe(false);
  expect(parse([start,{type:"error"},message(predict),done]).ok).toBe(false);
});
it("rejects additional event payloads and item fields",()=>{
  expect(parse([{...start,command:"untrusted"},message(predict),done]).ok).toBe(false);
  expect(parse([start,{type:"item.completed",item:{id:"item_1",type:"agent_message",text:JSON.stringify(predict),command:"untrusted"}},done]).ok).toBe(false);
});
it("accepts a synthetic documented lifecycle with a recoverable error notification",()=>{
  // Hand-authored contract fixture, NOT a captured live 0.153.3 transcript.
  const result=parse([{type:"thread.started",thread_id:"synthetic-thread"},start,
    {type:"error",message:"synthetic reconnect notification"},
    {type:"item.started",item:{id:"item_0",type:"reasoning",text:""}},
    {type:"item.updated",item:{id:"item_0",type:"reasoning",text:"synthetic reasoning"}},
    {type:"item.completed",item:{id:"item_0",type:"reasoning",text:"synthetic reasoning"}},
    message(predict),{...done,usage:{...done.usage,reasoning_output_tokens:0}}]);
  expect(result).toMatchObject({ok:true,prediction:predict});
  expect(JSON.stringify(result)).not.toMatch(/synthetic|reconnect|reasoning/);
});
