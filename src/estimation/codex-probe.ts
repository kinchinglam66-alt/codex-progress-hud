import { createOwnedProcessRunner } from "./owned-process.js";
import { resolveObserverAuthHome, subscriptionEnvironment } from "./codex-invocation.js";
import {parseCodexVersion} from './codex-runtime-profiles.js';

function observerRuntimeEnvironment(env:NodeJS.ProcessEnv,observerHome:string):NodeJS.ProcessEnv {
  const home=resolveObserverAuthHome(env,observerHome);
  const isolated=Object.fromEntries(Object.entries(subscriptionEnvironment(env))
    .filter(([key])=>key.toUpperCase()!=="CODEX_HOME"));
  isolated.CODEX_HOME=home;
  return isolated;
}

/** Internal read-only probe. Caller must verify executable provenance/pin first.
 * Each command has a five-second runtime deadline and up to five seconds cleanup.
 * CLI configuration may be read by these commands; no inference is dispatched.
 */
export function createCodexProbe(env:NodeJS.ProcessEnv,runner=createOwnedProcessRunner({timeoutMs:5000})) {
  const childEnv=subscriptionEnvironment(env);
  let active=false,disabled=false;
  const disable=()=>{disabled=true;runner.disable();};
  return {
    disable,
    async probe(executable:string,cwd:string) {
      if(active || disabled) throw new Error("CODEX_PROBE_FAILED");
      active=true;
      try {
        const texts:string[]=[];
        const commands=[["--version"],["features","list"],["login","status"]];
        for(const [index,args] of commands.entries()) {
          if(disabled) throw Error();
          const result=await runner.run({executable,cwd,args,env:childEnv,input:""},new AbortController().signal);
          if(disabled || !result.closed || result.reason!=="exited" || result.exitCode!==0) throw Error();
          const limit=[256,65536,1024][index]!;
          if(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)>limit ||
            (index!==2 && result.stderr.length!==0)) throw Error();
          let text=result.stdout.trim();
          if(index===2) {
            if(text && result.stderr.trim()) throw Error();
            text=text || result.stderr.trim();
          }
          if(index===0 && parseCodexVersion(text) === null) throw Error();
          if(index===1 && (!text || Buffer.byteLength(text)>65536 || text.split(/\r?\n/).some(line=>
            !/^[a-z][a-z0-9_]*\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/.test(line)))) throw Error();
          if(index===2 && text!=="Logged in using ChatGPT") throw Error();
          texts.push(text);
        }
        return {version:texts[0]!,features:texts[1]!,login:texts[2]!};
      } catch { disable();throw new Error("CODEX_PROBE_FAILED"); }
      finally {active=false;}
    }
  };
}

/** Internal pre-login runtime probe. It performs only bounded, read-only
 * version/capability checks in the explicit observer home; it never asks the
 * CLI for login, status, turn, account or model information.
 */
export function createObserverRuntimeProbe(env:NodeJS.ProcessEnv,observerHome:string,
  runner=createOwnedProcessRunner({timeoutMs:5000})) {
  const childEnv=observerRuntimeEnvironment(env,observerHome);
  let active=false,disabled=false;
  const disable=()=>{disabled=true;runner.disable();};
  return {
    disable,
    async probe(executable:string,cwd:string) {
      if(active || disabled) throw new Error("CODEX_PROBE_FAILED");
      active=true;
      try {
        const texts:string[]=[];
        const commands=[["--version"],["features","list","-c",'cli_auth_credentials_store="file"']];
        for(const [index,args] of commands.entries()) {
          if(disabled) throw Error();
          const result=await runner.run({executable,cwd,args,env:childEnv,input:""},new AbortController().signal);
          if(disabled || !result.closed || result.reason!=="exited" || result.exitCode!==0) throw Error();
          const limit=[256,65536][index]!;
          if(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)>limit || result.stderr.length!==0) throw Error();
          const text=result.stdout.trim();
          if(index===0 && parseCodexVersion(text)===null) throw Error();
          if(index===1 && (!text || text.split(/\r?\n/).some(line=>
            !/^[a-z][a-z0-9_]*\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/.test(line)))) throw Error();
          texts.push(text);
        }
        return {version:texts[0]!,features:texts[1]!};
      } catch { disable();throw new Error("CODEX_PROBE_FAILED"); }
      finally {active=false;}
    }
  };
}
