// Explicit, local experiment entry point. Not installed or imported by the HUD.
import {isAbsolute,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir,mkdtemp,readFile,open,writeFile} from "node:fs/promises";

const args=process.argv.slice(2);
if(args.length!==4 || !["--live","--preflight","--resume","--diagnose"].includes(args[0]) || args.slice(1).some(x=>!isAbsolute(x)||/[\x00-\x1f]/.test(x))) {
  process.stderr.write("CONTROLLED_EXPERIMENT_ARGUMENTS_REQUIRED\n");process.exitCode=2;
}else {
  try{await main(args[1],args[2],args[3],args[0]);}
  catch{process.stderr.write("CONTROLLED_EXPERIMENT_STOPPED_CHECK_LOCAL_JOURNAL\n");process.exitCode=1;}
}

async function main(output,python,codex,mode) {
  const base=output,resuming=["--resume","--diagnose"].includes(mode);
  const priorEntries=resuming?(await readFile(join(base,"experiment.jsonl"),"utf8")).trim().split("\n").map(x=>JSON.parse(x)):[];
  const priorConfig=priorEntries[0]?.config??null;
  const priorReservation=priorEntries.findLast(x=>x.type==="reservation_amendment")?.reservationTokens??priorConfig?.reservationTokens;
  const root=resolve(fileURLToPath(new URL("../..",import.meta.url)));
  const {createOwnedProcessRunner}=await import("../../dist/estimation/owned-process.js");
  const {preflightCodex}=await import("../../dist/estimation/codex-preflight.js");
  const {createCodexProbe}=await import("../../dist/estimation/codex-probe.js");
  const {buildCodexInvocation,subscriptionEnvironment}=await import("../../dist/estimation/codex-invocation.js");
  const {openExperimentLedger}=await import("../../dist/evaluation/experiment-ledger.js");
  const {runControlledCall,collectionMustStop}=await import("../../dist/evaluation/controlled-call.js");
  const {runControlledTask}=await import("../../dist/evaluation/controlled-task.js");
  const {snapshotFiles}=await import("../../dist/evaluation/frozen-files.js");
  const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
  // Never create a second budget under the same output or overwrite evidence.
  if(resuming)output=await mkdtemp(join(base,"revision-"));
  else await mkdir(output,{recursive:false});
  const empty=join(output,"empty");await mkdir(empty);
  const frozen=join(output,"frozen"),helper=join(output,"windows-job.exe");
  const paths=["scripts/evaluation/sql-workloads.py","scripts/evaluation/run-controlled.mjs","scripts/evaluation/windows-job.cs",
    "scripts/evaluation/assets/sql.schema.json","scripts/evaluation/assets/sql-instructions.md",
    "scripts/evaluation/assets/eta.schema.json","scripts/evaluation/assets/eta-instructions.md",
    "dist/evaluation/controlled-call.js","dist/evaluation/controlled-output.js","dist/evaluation/controlled-task.js",
    "dist/evaluation/experiment-ledger.js","dist/estimation/codex-invocation.js","dist/estimation/owned-process.js",
    "dist/estimation/codex-preflight.js","dist/estimation/codex-probe.js","dist/estimation/contracts.js",
    "dist/evaluation/controlled-score.js","dist/evaluation/local-baseline.js","dist/evaluation/replay.js",
    "dist/evaluation/frozen-files.js","docs/superpowers/specs/2026-09-05-controlled-eta-protocol.md"];
  const snapshot=await snapshotFiles(root,frozen,paths),pins=snapshot.pins;
  await snapshot.verify();
  const compiled=spawnSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    ["/nologo","/platform:x64","/target:exe",`/out:${helper}`,join(frozen,"scripts/evaluation/windows-job.cs")],
    {windowsHide:true,shell:false,encoding:"utf8",timeout:15000,maxBuffer:65536});
  if(compiled.status!==0)throw Error("JOB_OWNER_BUILD_FAILED");
  const helperHash=hash(await readFile(helper)),pythonHash=hash(await readFile(python));
  const executableSha256="bc15d59a3062bf165181a30007c3d0f5b1ee0ca4855e33d9b486ad59c984a31b";
  const validator=join(frozen,"scripts/evaluation/sql-workloads.py");
  async function verifyFrozen() {
    await snapshot.verify();
    // Loaded modules are not reloaded. Refuse concurrent edits to the reviewed
    // source tree rather than silently combining a frozen manifest with new code.
    for(const path of paths)if(hash(await readFile(join(root,path)))!==pins[path])throw Error("SOURCE_CHANGED_DURING_RUN");
    if(hash(await readFile(helper))!==helperHash || hash(await readFile(python))!==pythonHash)throw Error("RUNTIME_CHANGED_DURING_RUN");
    if(hash(await readFile(codex))!==executableSha256)throw Error("CODEX_CHANGED_DURING_RUN");
  }
  const makeRunner=options=>{
    const owned=createOwnedProcessRunner(options);
    return {disable:()=>owned.disable(),status:()=>owned.status(),run:async(invocation,signal)=>{
      await verifyFrozen();
      return owned.run({...invocation,executable:helper,args:[String(process.pid),invocation.executable,...invocation.args]},signal);
    }};
  };
  const env=subscriptionEnvironment(process.env),controller=new AbortController(),owners=new Set();
  const stop=()=>{controller.abort();for(const runner of owners)runner.disable();};
  process.on("SIGINT",stop);process.on("SIGTERM",stop);
  async function pythonCall(mode,input="") {
    try {
    const runner=makeRunner({timeoutMs:10000});owners.add(runner);
    const result=await runner.run({executable:python,cwd:empty,args:["-I","-B",validator,mode],env,input},controller.signal);
    if(result.closed)owners.delete(runner);
    if(!result.closed || result.reason!=="exited" || result.exitCode!==0)throw Error("VALIDATOR_FAILED");
    return JSON.parse(result.stdout);
    }catch(error){stop();throw error;}
  }
  let ledger,events,queue=Promise.resolve();
  try {
    const manifest=await pythonCall("--manifest");
    if(!Array.isArray(manifest)||manifest.length!==60||new Set(manifest.map(x=>x.key)).size!==60||
      manifest.some(x=>!/^sample_sql_[0-5]_[0-9]$/.test(x.key)||typeof x.prompt!=="string"||x.prompt.length>8192))throw Error("MANIFEST_INVALID");
    const protocol={version:1,model:"gpt-5.6-luna",reasoningEffort:"medium",route:"chatgpt",
      budgetTokens:priorConfig?1500000:1000000,reservationTokens:priorReservation??160000,maxStarts:300,sampleMs:[0,5000,15000],
      maxWorkloadAttempts:2,processTimeoutMs:60000,manifest,pins,executableSha256,helperHash,pythonHash,
      budgetPolicy:"conservative_target_possible_overrun_authorized_2026-09-06",processOwner:"atomic_windows_job_parent_monitored",
      parentBudgetProtocolHash:priorConfig?.protocolHash??null,
      endpoint:"independent_validation_completion",primary:"timely_delivery_aged_interval_task_macro",
      intervalNominalCoverage:0.8,relativeErrorDenominatorFloorSeconds:5,
      optionalEstimatorAdmission:"skip_without_cancelling_workload"};
    const protocolText=JSON.stringify(protocol,null,2)+"\n",protocolHash=hash(protocolText);
    await writeFile(join(output,"protocol.json"),protocolText,{flag:"wx",mode:0o600});
    const probe=createCodexProbe(env,makeRunner({timeoutMs:5000})),profiles={};
    try {
      for(const [kind,prefix] of [["workload","sql"],["estimator","eta"]]) {
        const schema=`scripts/evaluation/assets/${prefix}.schema.json`,instructions=`scripts/evaluation/assets/${prefix}-instructions.md`;
        profiles[kind]=await preflightCodex({executable:codex,cwd:empty,schemaPath:join(frozen,schema),
          instructionsPath:join(frozen,instructions),executableSha256,schemaSha256:pins[schema],instructionsSha256:pins[instructions]},probe.probe);
      }
    }finally{probe.disable();}
    if(mode==="--preflight"){process.stdout.write("CONTROLLED_EXPERIMENT_PREFLIGHT_PASSED_NO_MODEL_CALLS\n");return;}
    ledger=await openExperimentLedger(base,priorConfig??{budgetTokens:protocol.budgetTokens,reservationTokens:protocol.reservationTokens,
      maxStarts:protocol.maxStarts,protocolHash});
    if(mode==="--diagnose"){
      const runner=makeRunner({timeoutMs:60000});owners.add(runner);
      const invocation=buildCodexInvocation(profiles.estimator,{activeSeconds:0,progress:null,toolCount:0,validationFailures:0},env);
      const result=await runControlledCall({task:"sample_diagnostic_1",kind:"estimator",invocation,signal:controller.signal,ledger,runner,onUnsafe:stop});
      if(result.closed)owners.delete(runner);else stop();
      await writeFile(join(output,"diagnostic.json"),JSON.stringify({result,budget:ledger.snapshot()},null,2),{flag:"wx",mode:0o600});
      process.stdout.write(JSON.stringify({diagnostic:result.status,failureCategory:result.failureCategory,protocolEvents:result.protocolEvents,usage:result.usage,budget:ledger.snapshot()})+"\n");
      if(result.status!=="answered")process.exitCode=3;return;
    }
    const previousEvents=resuming?(await readFile(join(base,"events.jsonl"),"utf8")).trim().split("\n").map(JSON.parse):[];
    const finished=new Set(previousEvents.filter(x=>x.type==="end").map(x=>x.key));
    events=await open(join(base,"events.jsonl"),resuming?"a":"wx",0o600);
    const emit=row=>{
      const line=JSON.stringify(row)+"\n";
      queue=queue.then(async()=>{await events.writeFile(line);await events.sync();});
      return queue;
    };
    let completed=finished.size;
    for(const task of manifest) {
      if(finished.has(task.key))continue;
      const state=ledger.snapshot();
      if(controller.signal.aborted||state.unreconciledUnknown||state.overrun||state.pending)break;
      const call=async(kind,input)=>{
        const runner=makeRunner({timeoutMs:protocol.processTimeoutMs});owners.add(runner);
        try {
        const numeric=kind==="estimator"?input:{activeSeconds:0,progress:null,toolCount:0,validationFailures:0};
        const invocation=buildCodexInvocation(profiles[kind],numeric,env);
        if(kind==="workload")invocation.input=input;
        const result=await runControlledCall({task:task.key,kind,invocation,signal:controller.signal,ledger,runner,onUnsafe:stop});
        if(result.closed)owners.delete(runner);
        else stop();
        if(collectionMustStop(kind,result,ledger.snapshot()))stop();
        return result;
        }catch(error){stop();throw error;}
      };
      const validation=async sql=>{
        try {
        const value=await pythonCall("--validate",JSON.stringify({key:task.key,sql}));
        if(!value||typeof value.passed!=="boolean"||!Number.isInteger(value.cases)||!Number.isInteger(value.passedCases)||
          (value.error!==null&&typeof value.error!=="string")||
          (value.passed&&(value.cases!==8||value.passedCases!==8)))throw Error("VALIDATION_PROTOCOL_INVALID");
        return value;
        }catch(error){stop();throw error;}
      };
      const result=await runControlledTask({key:task.key,prompt:task.prompt,sampleMs:protocol.sampleMs,emit,call,validate:validation,onUnsafe:stop});
      completed++;
      process.stdout.write(JSON.stringify({completed,key:task.key,outcome:result.outcome,budget:ledger.snapshot()})+"\n");
      if(ledger.snapshot().unreconciledUnknown||ledger.snapshot().overrun)break;
    }
    await emit({type:"experiment_end",completed,budget:ledger.snapshot()});
    if(completed!==60)process.exitCode=3;
  }finally {
    stop();
    await queue.catch(()=>undefined);
    await events?.close();await ledger?.close();
    process.off("SIGINT",stop);process.off("SIGTERM",stop);
  }
}
