import { expect, it } from "vitest";
import { createCodexProbe, createObserverRuntimeProbe } from "../../src/estimation/codex-probe.js";
import { resolve } from "node:path";
import type { Invocation, OwnedProcessResult } from "../../src/estimation/owned-process.js";
const output=(stdout:string,stderr=""):OwnedProcessResult=>({reason:"exited",exitCode:0,closed:true,stdout,stderr});
const fixtures=[output("codex-cli 0.153.3\n"),output("hooks\tstable\ttrue\n"),output("","Logged in using ChatGPT\n")];
const runtimeFixtures=[fixtures[0]!,fixtures[1]!];
function runner(values=fixtures) {
  const calls:Invocation[]=[];let disabled=false;
  return {calls,status:()=>({active:false,disabled,poisoned:false}),disable:()=>{disabled=true;},
    run:async(invocation:Invocation)=>{calls.push(invocation);return values[calls.length-1]!;}};
}
it('recognizes exact 0.153.4 read-only version evidence', async () => {
  const probe = createCodexProbe({}, runner([output('codex-cli 0.153.4'), ...fixtures.slice(1)]));
  expect((await probe.probe(process.execPath, process.cwd())).version).toBe('codex-cli 0.153.4');
});
it("dispatches only the fixed read-only commands with isolated environment",async()=>{
  const r=runner(),p=createCodexProbe({HTTPS_PROXY:"http://proxy.invalid",CODEX_HOME:"login",GITHUB_TOKEN:"secret"},r);
  expect(await p.probe(process.execPath,process.cwd())).toEqual({version:"codex-cli 0.153.3",features:"hooks\tstable\ttrue",login:"Logged in using ChatGPT"});
  expect(r.calls.map(c=>c.args)).toEqual([["--version"],["features","list"],["login","status"]]);
  expect(r.calls.every(c=>c.input==="" && c.env.HTTPS_PROXY==="http://proxy.invalid" && !("GITHUB_TOKEN" in c.env))).toBe(true);
});
it("probes only version and features in an isolated observer home with file credentials",async()=>{
  const r=runner(runtimeFixtures),observerHome=resolve("observer-runtime-home");
  const p=createObserverRuntimeProbe({HTTPS_PROXY:"http://proxy.invalid",CODEX_HOME:resolve("main-home"),
    codex_home:resolve("other-main"),OPENAI_API_KEY:"secret",openai_api_key:"secret2",
    codex_api_key:"secret3",GITHUB_TOKEN:"secret4"},observerHome,r);
  expect(await p.probe(process.execPath,process.cwd())).toEqual({version:"codex-cli 0.153.3",features:"hooks\tstable\ttrue"});
  expect(r.calls.map(c=>c.args)).toEqual([["--version"],["features","list","-c",'cli_auth_credentials_store="file"']]);
  expect(r.calls.every(c=>c.input==="" && c.env.HTTPS_PROXY==="http://proxy.invalid" &&
    c.env.CODEX_HOME===observerHome && Object.keys(c.env).every(key=>
      key.toUpperCase()!=="CODEX_HOME" || key==="CODEX_HOME") &&
    !Object.keys(c.env).some(key=>/api[_-]?key|token|secret/i.test(key)))).toBe(true);
});
it("stops on command failure and disables further probes without exposing text",async()=>{
  const r=runner([{...output("private path"),exitCode:1}]),p=createCodexProbe({},r);
  await expect(p.probe(process.execPath,process.cwd())).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
  await expect(p.probe(process.execPath,process.cwd())).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
  expect(r.calls).toHaveLength(1);
});
it("rejects concurrent probes and suppresses results after disable",async()=>{
  let finish!:(value:OwnedProcessResult)=>void;
  const r={...runner(),run:()=>new Promise<OwnedProcessResult>(resolve=>{finish=resolve;})};
  const p=createCodexProbe({},r),first=p.probe(process.execPath,process.cwd());
  await expect(p.probe(process.execPath,process.cwd())).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
  p.disable();finish(fixtures[0]!);
  await expect(first).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
});
it("cancels the bounded observer runtime probe through disable",async()=>{
  let finish!:(value:OwnedProcessResult)=>void;
  const calls:Invocation[]=[];
  const r={...runner(),run:(invocation:Invocation)=>{
    calls.push(invocation);
    return new Promise<OwnedProcessResult>(resolve=>{finish=resolve;});
  }};
  const p=createObserverRuntimeProbe({},resolve("observer-runtime-home"),r),first=p.probe(process.execPath,process.cwd());
  p.disable();finish(runtimeFixtures[0]!);
  await expect(first).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
  expect(calls).toHaveLength(1);
});
it.each(["unexpected private text","x".repeat(257)])("rejects invalid version output without returning it",async text=>{
  const p=createCodexProbe({},runner([output(text)]));
  await expect(p.probe(process.execPath,process.cwd())).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
});
it.each([
  [output("codex-cli 0.153.3"+" ".repeat(256))],
  [output("codex-cli 0.153.3","unexpected diagnostic")],
  [fixtures[0]!,output("hooks\tstable\ttrue"+" ".repeat(65536))],
  [fixtures[0]!,output("hooks\tstable\ttrue","unexpected diagnostic")],
  [fixtures[0]!,fixtures[1]!,output("","Logged in using ChatGPT"+" ".repeat(1024))]
])("rejects raw padded excess or unexpected streams",async(...values)=>{
  await expect(createCodexProbe({},runner([...values,...fixtures.slice(values.length)])).probe(process.execPath,process.cwd())).rejects.toThrow(/^CODEX_PROBE_FAILED$/);
});
