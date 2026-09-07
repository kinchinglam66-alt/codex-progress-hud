import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createOwnedProcessRunner, createOwnedLoginProcessRunner } from "../../src/estimation/owned-process.js";
import { createCodexOutputParser } from "../../src/estimation/codex-output.js";
const spec = (code: string) => ({ executable: process.execPath, cwd: process.cwd(), args:["-e",code], env:process.env, input:"" });
afterEach(() => vi.useRealTimers());
it('allows browser login time without extending ordinary model deadlines',async()=>{
  expect(()=>createOwnedProcessRunner({timeoutMs:60001})).toThrow('INVALID_PROCESS_DEADLINE');
  expect(()=>createOwnedLoginProcessRunner({timeoutMs:600001})).toThrow('INVALID_PROCESS_DEADLINE');
  vi.useFakeTimers();
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
  const runner=createOwnedLoginProcessRunner({spawn:()=>child as unknown as ChildProcessWithoutNullStreams});
  const pending=runner.run(spec(''),new AbortController().signal);
  await vi.advanceTimersByTimeAsync(60001);
  expect(runner.status().active).toBe(true);
  child.emit('close',0);
  expect(await pending).toMatchObject({reason:'exited',closed:true,exitCode:0});
});
it("collects bounded output and releases only after real exit", async () => {
  const r=createOwnedProcessRunner(); const value=await r.run(spec('process.stdout.write("ok"); process.stderr.write("warn")'),new AbortController().signal);
  expect(value).toMatchObject({reason:"exited",exitCode:0,closed:true,stdout:"ok",stderr:"warn"});
  expect(r.status().active).toBe(false);
});
it("reports nonzero exit without treating it as spawn failure", async () => {
  const r=createOwnedProcessRunner(); expect(await r.run(spec('process.exit(3)'),new AbortController().signal)).toMatchObject({reason:"exited",exitCode:3,closed:true});
});
it("never spawns a pre-aborted request", async () => {
  const r=createOwnedProcessRunner(); const c=new AbortController(); c.abort();
  expect(await r.run(spec('throw Error("must not run")'),c.signal)).toMatchObject({reason:"aborted",closed:true});
  expect(r.status().active).toBe(false);
});
it("cancels a real child and rejects a concurrent start", async () => {
  const r=createOwnedProcessRunner(); const c=new AbortController();
  const pending=r.run(spec('setInterval(()=>{},1000)'),c.signal);
  expect(await r.run(spec('process.exit(0)'),new AbortController().signal)).toMatchObject({reason:"busy"});
  c.abort(); expect(await pending).toMatchObject({reason:"aborted",closed:true,stdout:""});
});
it("terminates overflowing output without returning partial payload", async () => {
  const r=createOwnedProcessRunner(); expect(await r.run(spec('process.stdout.write("x".repeat(300000)); setInterval(()=>{},1000)'),new AbortController().signal)).toMatchObject({reason:"output_limit",closed:true,stdout:""});
});
it("poisons admission if an owned child will not close", async () => {
  vi.useFakeTimers(); const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
  const r=createOwnedProcessRunner({spawn:()=>child as unknown as ChildProcessWithoutNullStreams,timeoutMs:100,cleanupMs:50});
  const pending=r.run(spec(''),new AbortController().signal);
  await vi.advanceTimersByTimeAsync(150);
  expect(await pending).toMatchObject({reason:"cleanup_timeout",closed:false});
  expect(r.status()).toMatchObject({active:true,poisoned:true});
  child.emit("close",null,"SIGTERM");
  expect(r.status()).toMatchObject({active:false,poisoned:true});
  expect(await r.run(spec(''),new AbortController().signal)).toMatchObject({reason:"unavailable"});
});
it("retains direct-child termination after cleanup timeout until actual close",async()=>{
  vi.useFakeTimers();let kills=0;
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{kills++;return false;}});
  const r=createOwnedProcessRunner({spawn:()=>child as unknown as ChildProcessWithoutNullStreams,timeoutMs:10,cleanupMs:10});
  const pending=r.run(spec(''),new AbortController().signal);
  await vi.advanceTimersByTimeAsync(20);await pending;
  const before=kills;r.disable();expect(kills).toBe(before+1);
  child.emit("close",null,"SIGTERM");r.disable();expect(kills).toBe(before+1);
});
it("disable aborts current child and prevents future starts", async () => {
  const r=createOwnedProcessRunner(); const pending=r.run(spec('setInterval(()=>{},1000)'),new AbortController().signal); r.disable();
  expect(await pending).toMatchObject({reason:"disabled",closed:true});
  expect(await r.run(spec(''),new AbortController().signal)).toMatchObject({reason:"unavailable"});
});
it("reuses a slot after confirmed successful exit", async () => {
  const r=createOwnedProcessRunner();
  await r.run(spec('process.exit(0)'),new AbortController().signal);
  expect(await r.run(spec('process.stdout.write("second")'),new AbortController().signal)).toMatchObject({reason:"exited",closed:true,stdout:"second"});
});
it("bounds stderr as well as stdout", async () => {
  const r=createOwnedProcessRunner();
  expect(await r.run(spec('process.stderr.write("x".repeat(70000)); setInterval(()=>{},1000)'),new AbortController().signal)).toMatchObject({reason:"output_limit",closed:true,stderr:""});
});
it("times out an owned real child and confirms exit", async () => {
  const r=createOwnedProcessRunner({timeoutMs:200});
  expect(await r.run(spec('setInterval(()=>{},1000)'),new AbortController().signal)).toMatchObject({reason:"timeout",closed:true});
  expect(r.status().active).toBe(false);
});
it("does not expose a thrown spawn error", async () => {
  const r=createOwnedProcessRunner({spawn:()=>{throw new Error("secret path");}});
  expect(await r.run(spec(''),new AbortController().signal)).toEqual({reason:"spawn_error",exitCode:null,closed:true,stdout:"",stderr:""});
});
it("rejects relative executable before dispatch", async () => {
  const r=createOwnedProcessRunner();
  await expect(r.run({...spec(''),executable:"node"},new AbortController().signal)).rejects.toThrow("INVALID_PROCESS_INVOCATION");
  expect(r.status().active).toBe(false);
});
it("immediately stops rejected streamed output before process exit", async () => {
  const r=createOwnedProcessRunner({timeoutMs:1000});
  expect(await r.run({...spec('process.stdout.write("tool event"); setInterval(()=>{},1000)'),onStdout:()=>false},new AbortController().signal)).toMatchObject({reason:"protocol_error",closed:true,stdout:""});
});
it("contains validator exceptions without exposing their text", async () => {
  const r=createOwnedProcessRunner({timeoutMs:1000});
  expect(await r.run({...spec('process.stdout.write("payload"); setInterval(()=>{},1000)'),
    onStdout:()=>{throw new Error("private validator detail");}},new AbortController().signal))
    .toEqual({reason:"protocol_error",exitCode:null,closed:true,stdout:"",stderr:""});
});
it("does not retain raw stdout or stderr in validated mode", async () => {
  const r=createOwnedProcessRunner();
  const result=await r.run({...spec('process.stdout.write("reasoning"); process.stderr.write("private path")'),
    onStdout:()=>true},new AbortController().signal);
  expect(result).toEqual({reason:"exited",exitCode:0,closed:true,stdout:"",stderr:""});
});
it("connects real streamed tool detection to owned-child cancellation", async () => {
  const r=createOwnedProcessRunner({timeoutMs:1000}), parser=createCodexOutputParser();
  const event=JSON.stringify({type:"item.started",item:{type:"command_execution"}})+"\n";
  const result=await r.run({...spec(`process.stdout.write(${JSON.stringify(event)}); setInterval(()=>{},1000)`),
    onStdout:parser.push},new AbortController().signal);
  expect(result).toMatchObject({reason:"protocol_error",closed:true,stdout:""});
  expect(parser.end()).toMatchObject({ok:false,error:"unexpected_tool",prediction:null,usage:null});
  expect(r.status().active).toBe(false);
});
