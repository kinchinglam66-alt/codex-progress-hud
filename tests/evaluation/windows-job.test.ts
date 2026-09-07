import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {runControlledTask} from "../../src/evaluation/controlled-task.js";
import {createOwnedProcessRunner} from "../../src/estimation/owned-process.js";
import type {ControlledCallResult} from "../../src/evaluation/controlled-call.js";
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
describe.skipIf(process.platform!=="win32")("experiment Windows Job owner",()=>{
  let directory:string,helper:string;
  beforeAll(async()=>{
    directory=await mkdtemp(join(tmpdir(),"hud-job-test-"));helper=join(directory,"job.exe");
    const compiled=spawnSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ["/nologo","/platform:x64","/target:exe",`/out:${helper}`,resolve("scripts/evaluation/windows-job.cs")],{encoding:"utf8",windowsHide:true});
    expect(compiled.status,compiled.stdout+compiled.stderr).toBe(0);
  });
  afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
  it("preserves stdin, stdout and child exit code",()=>{
    const result=spawnSync(helper,[String(process.pid),process.execPath,"-e",'process.stdin.on("data",b=>process.stdout.write(b));process.stdin.on("end",()=>{process.exitCode=7;});'],{input:"fixture",encoding:"utf8",windowsHide:true});
    expect(result.stdout).toBe("fixture");expect(result.status).toBe(7);
  });
  it("requires atomic job assignment at process creation rather than a post-create gap",async()=>{
    const source=await readFile(resolve("scripts/evaluation/windows-job.cs"),"utf8");
    expect(source).toContain("0x0002000D");
    expect(source).toContain("UpdateProcThreadAttribute");
    expect(source).not.toContain("AssignProcessToJobObject(job,child.Process)");
  });
  it("aborts the protected estimator when independent validation throws",async()=>{
    const runner=createOwnedProcessRunner({timeoutMs:1000}),controller=new AbortController();
    let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
    const answer:ControlledCallResult={reservationId:1,status:"answered",answer:{sql:"SELECT 1"},usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0},requestedAt:"fixture",deliveredAt:"fixture",durationMs:1,closed:true,processReason:"exited"};
    const call=async(kind:"workload"|"estimator")=>{
      if(kind==="workload"){await started;return answer;}
      const result=await runner.run({executable:helper,cwd:process.cwd(),args:[String(process.pid),process.execPath,"-e",'process.stdout.write("ready");setInterval(()=>{},1000)'],env:process.env,input:"",onStdout:()=>{ready();return true;}},controller.signal);
      return {...answer,status:"process_error" as const,answer:null,usage:null,closed:result.closed,processReason:result.reason};
    };
    await expect(runControlledTask({key:"sample_a",prompt:"fixture",sampleMs:[0],emit:async()=>{},call,
      validate:async()=>{throw Error("fixture validation failure");},onUnsafe:()=>{controller.abort();runner.disable();}})).rejects.toThrow("fixture validation failure");
    expect(controller.signal.aborted).toBe(true);expect(runner.status().active).toBe(false);
  });
  it.each(["owner","parent"])("kills a child and grandchild when the %s is terminated",async target=>{
    const code='const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);';
    const parentCode=`const h=require('child_process').spawn(${JSON.stringify(helper)},[String(process.pid),process.execPath,'-e',${JSON.stringify(code)}],{windowsHide:true,stdio:['pipe','pipe','pipe']});h.stdout.pipe(process.stdout);h.stderr.pipe(process.stderr);setInterval(()=>{},1000);`;
    const owner=target==="owner"?spawn(helper,[String(process.pid),process.execPath,"-e",code],{windowsHide:true,stdio:"pipe"}):
      spawn(process.execPath,["-e",parentCode],{windowsHide:true,stdio:"pipe"});
    const closed=new Promise<void>(resolve=>owner.once("close",()=>resolve()));
    const ids=await new Promise<number[]>((resolve,reject)=>{
      let text="";const timer=setTimeout(()=>reject(Error("fixture startup timeout")),5000);
      owner.once("error",reject);owner.stdout.on("data",b=>{text+=b;if(text.includes("\n")){clearTimeout(timer);resolve(JSON.parse(text.trim()));}});
    });
    try{
      expect(ids).toHaveLength(2);owner.kill();await closed;
      for(let i=0;i<100;i++){
        const alive=ids.some(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
        if(!alive)break;await sleep(20);
      }
      for(const pid of ids)expect(()=>process.kill(pid,0)).toThrow();
    }finally{owner.kill();for(const pid of ids)try{process.kill(pid);}catch{}await closed;}
  });
});
