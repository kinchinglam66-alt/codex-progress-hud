import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionEnvironment } from '../estimation/codex-invocation.js';
import { createCodexNameReader } from './codex-name-reader.js';
import { findPinnedCodex, nameProcessArguments } from './codex-name-launch.js';

interface Dependencies {
  resolveExecutable(): Promise<string>;
  launch(executable:string,cwd:string,env:NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
}
export function createConversationNameService(environment:NodeJS.ProcessEnv=process.env, overrides:Partial<Dependencies>={}) {
  const env=subscriptionEnvironment(environment);
  const dependencies:Dependencies={
    resolveExecutable:async()=>{
      if(process.platform!=='win32' || !env.LOCALAPPDATA)throw Error();
      return findPinnedCodex(join(env.LOCALAPPDATA,'OpenAI','Codex','bin'));
    },
    launch:(exe,cwd,childEnv)=>spawn(exe,nameProcessArguments(),{cwd,env:childEnv,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']}),
    ...overrides
  };
  let disabled=false;
  let reader:ReturnType<typeof createCodexNameReader> | undefined;
  let initialization:Promise<void> | undefined;
  let directory:string | undefined;
  let active:Promise<string|null> | undefined;
  async function initialize():Promise<void> {
    const executable=await dependencies.resolveExecutable();
    if(disabled)throw Error();
    directory=await mkdtemp(join(tmpdir(),'codex-hud-names-'));
    if(disabled)throw Error();
    reader=createCodexNameReader(()=>dependencies.launch(executable,directory!,env));
  }
  return {
    async read(hostId:string,signal:AbortSignal):Promise<string|null> {
      try {
        if(disabled || signal.aborted)throw Error();
        initialization ??= initialize();
        await initialization;
        if(disabled || signal.aborted || active)throw Error();
        const operation=reader!.read(hostId,signal);
        active=operation;
        try {return await operation;} finally {if(active===operation)active=undefined;}
      } catch {throw Error('NAME_SOURCE_UNAVAILABLE');}
    },
    async close():Promise<void> {
      disabled=true;reader?.disable();
      await initialization?.catch(()=>undefined);
      reader?.disable();
      await active?.catch(()=>undefined);
      if(reader?.ownership()==='termination_failed') {
        // Retain reader and cwd ownership; repeated close retries termination.
        throw Error('NAME_TERMINATION_FAILED');
      }
      if(directory!==undefined) {
        // Only the empty directory created by this service; never recursive deletion.
        await rmdir(directory).catch(()=>undefined);
        directory=undefined;
      }
    }
  };
}
