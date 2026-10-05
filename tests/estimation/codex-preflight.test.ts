import { createHash } from "node:crypto";
import * as fs from 'node:fs/promises';
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preflightCodex, preflightCodexRuntime, createRuntimePreflightCache } from "../../src/estimation/codex-preflight.js";
import {observerAssetPins, observerInstructionsMaxBytes} from '../../src/estimation/asset-pins.js';
// Copy exports so instrumentation can wrap open; all filesystem operations remain real.
vi.mock('node:fs/promises',async importOriginal=>({...await importOriginal<typeof import('node:fs/promises')>()}));
const roots:string[]=[];
const names=["plugins","hooks","apps","remote_plugin","multi_agent","shell_tool","unified_exec","shell_snapshot",
  "browser_use","browser_use_external","browser_use_full_cdp_access","computer_use","image_generation","view_image",
  "skill_search","workspace_dependencies","code_mode_host","memories","sleep_tool","in_app_browser","skip_host_skill_discovery","respect_system_proxy"];
const evidence={version:"codex-cli 0.153.3\n",features:names.map(n=>`${n}\tunder development\tfalse`).join("\n"),login:"Logged in using ChatGPT\n"};
const pin=(value:string)=>createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"hud-preflight-")); roots.push(root);
  const files={executable:join(root,"codex.exe"),cwd:join(root,"empty"),schemaPath:join(root,"schema.json"),instructionsPath:join(root,"instructions.md"),
    executableSha256:pin("fixture executable"),schemaSha256:pin("{}"),instructionsSha256:pin("fixture instructions")};
  await mkdir(files.cwd);
  await Promise.all([writeFile(files.executable,"fixture executable"),writeFile(files.schemaPath,"{}"),writeFile(files.instructionsPath,"fixture instructions")]);
  return files;
}
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
it('verifies a multi-megabyte executable including its tail with bounded read operations',async()=>{
  const files=await fixture(),body=Buffer.alloc(2*1024*1024+17,37);body[body.length-1]=91;
  await writeFile(files.executable,body);files.executableSha256=createHash('sha256').update(body).digest('hex');
  const realOpen=fs.open,reads:Array<ReturnType<typeof vi.spyOn>>=[];
  const opened=vi.spyOn(fs,'open').mockImplementation(async(path,flags,mode)=>{
    const handle=await realOpen(path,flags,mode);
    if(path===files.executable)reads.push(vi.spyOn(handle,'read'));
    return handle;
  });
  try{
    await preflightCodexRuntime(files,async()=>({version:evidence.version,features:evidence.features}));
    expect(reads).toHaveLength(2); // full verification before AND after capability probe
    expect(reads.reduce((sum,read)=>sum+read.mock.calls.length,0)).toBeLessThanOrEqual(8);
    body[body.length-1]=92;await writeFile(files.executable,body);
    await expect(preflightCodexRuntime(files,async()=>({version:evidence.version,features:evidence.features}))).rejects.toThrow('CODEX_PREFLIGHT_FAILED');
  }finally{opened.mockRestore();}
});
it('reuses only runtime evidence briefly while rechecking pinned files on every hit',async()=>{
  const files=await fixture();let now=0,probes=0;
  const cache=createRuntimePreflightCache(files,()=>now);
  const probe=async()=>{probes++;return {version:evidence.version,features:evidence.features};};
  await cache.check(probe);now=59000;await cache.check(probe);expect(probes).toBe(1);
  now=60000;await cache.check(probe);expect(probes).toBe(2);
  await writeFile(files.instructionsPath,'changed');
  await expect(cache.check(probe)).rejects.toThrow('CODEX_PREFLIGHT_FAILED');expect(probes).toBe(2);
  await writeFile(files.instructionsPath,'fixture instructions');
  await cache.check(probe);expect(probes).toBe(3);
  cache.invalidate();await cache.check(probe);expect(probes).toBe(4);
});

it('does not resurrect a cache revoked while a probe is pending',async()=>{
  const files=await fixture(),cache=createRuntimePreflightCache(files);
  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const pending=cache.check(async()=>{entered();await gate;return {version:evidence.version,features:evidence.features};});
  await ready;cache.invalidate();release();
  await expect(pending).rejects.toThrow('CODEX_PREFLIGHT_FAILED');
  let probes=0;await cache.check(async()=>{probes++;return {version:evidence.version,features:evidence.features};});expect(probes).toBe(1);
});
it('invalidates runtime evidence on clock rollback and never caches failed probes',async()=>{
  const files=await fixture();let now=100,probes=0;
  const cache=createRuntimePreflightCache(files,()=>now);
  const probe=async()=>{probes++;return {version:evidence.version,features:evidence.features};};
  await cache.check(probe);now=99;await cache.check(probe);expect(probes).toBe(2);
  cache.invalidate();
  await expect(cache.check(async()=>{throw Error('private');})).rejects.toThrow(/^CODEX_PREFLIGHT_FAILED$/);
  await cache.check(probe);expect(probes).toBe(3);
  await writeFile(join(files.cwd,'AGENTS.md'),'unexpected context');
  await expect(cache.check(probe)).rejects.toThrow('CODEX_PREFLIGHT_FAILED');expect(probes).toBe(3);
});
it('preserves the actual 0.153.4 version after pinned files and capabilities pass', async () => {
  const profile = await preflightCodex(await fixture(), async () => ({...evidence, version: 'codex-cli 0.153.4'}));
  expect(profile.version).toBe('0.153.4');
});
it("produces a profile only after pinned files and compatible evidence pass",async()=>{
  const files=await fixture();
  expect(await preflightCodex(files,async()=>evidence)).toEqual({executable:files.executable,cwd:files.cwd,
    schemaPath:files.schemaPath,instructionsPath:files.instructionsPath,version:"0.153.3",features:names});
});
it("preflights the runtime before login without requiring or claiming account evidence",async()=>{
  const files=await fixture();
  const profile=await preflightCodexRuntime(files,async()=>({version:evidence.version,features:evidence.features}));
  expect(profile).toEqual({executable:files.executable,cwd:files.cwd,
    schemaPath:files.schemaPath,instructionsPath:files.instructionsPath,version:"0.153.3",features:names});
});
it('preserves dotted capability names emitted by qualified desktop runtimes',async()=>{
  const files=await fixture();
  const profile=await preflightCodexRuntime(files,async()=>({version:evidence.version,
    features:`${evidence.features}\nguardianv2.thread_context\tunder development\tfalse`}));
  expect(profile.features).toContain('guardianv2.thread_context');
});
it("keeps the runtime preflight subject to the same pinned-file gate",async()=>{
  const files=await fixture();let probed=false;
  await expect(preflightCodexRuntime({...files,schemaSha256:"0".repeat(64)},async()=>{
    probed=true;return {version:evidence.version,features:evidence.features};
  })).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
  expect(probed).toBe(false);
});
it.each(["executableSha256","schemaSha256","instructionsSha256"])("rejects wrong %s before probing",async key=>{
  const files=await fixture();let probed=false;
  await expect(preflightCodex({...files,[key]:"0".repeat(64)},async()=>{probed=true;return evidence;})).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
  expect(probed).toBe(false);
});
it("rejects relative paths, non-files and a nonempty workspace",async()=>{
  const files=await fixture();
  for(const bad of [{...files,executable:"codex.exe"},{...files,schemaPath:files.cwd}]) {
    await expect(preflightCodex(bad,async()=>evidence)).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
  }
  await writeFile(join(files.cwd,"AGENTS.md"),"unexpected context");
  await expect(preflightCodex(files,async()=>evidence)).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
});
it.each([
  {...evidence,version:"codex-cli 0.154.0"},
  {...evidence,login:"Logged in using an API key"},
  {...evidence,features:evidence.features.replace("respect_system_proxy\tunder development","respect_system_proxy\tremoved")},
  {...evidence,features:""},
  {...evidence,features:"x".repeat(65537)}
])("rejects incompatible or unbounded evidence",async bad=>{
  await expect(preflightCodex(await fixture(),async()=>bad)).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
});
it("detects replacement of instructions during probing",async()=>{
  const files=await fixture();
  await expect(preflightCodex(files,async()=>{await writeFile(files.instructionsPath,"changed");return evidence;})).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
});
it("sanitizes thrown probe detail",async()=>{
  await expect(preflightCodex(await fixture(),async()=>{throw Error("credential-bearing diagnostic");})).rejects.toThrow(/^CODEX_PREFLIGHT_FAILED$/);
});
it("rejects a workspace redirected through a directory link",async()=>{
  const files=await fixture(),linked=join(files.cwd,"..","redirect");
  await symlink(files.cwd,linked,process.platform==="win32"?"junction":"dir");
  await expect(preflightCodex({...files,cwd:linked},async()=>evidence)).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
});
it("rejects oversized assets even when their hash matches",async()=>{
  const files=await fixture(),large="x".repeat(16385); await writeFile(files.instructionsPath,large);
  await expect(preflightCodex({...files,instructionsSha256:pin(large)},async()=>evidence)).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
});
it('admits the actual release-pinned long observer prompt in both preflights and cached rechecks',async()=>{
  const files=await fixture();
  const prompt=await fs.readFile(new URL('../../src/estimation/assets/observer-instructions.md',import.meta.url));
  expect(prompt.length).toBeGreaterThan(16384);
  expect(prompt.length).toBeLessThanOrEqual(observerInstructionsMaxBytes);
  expect(createHash('sha256').update(prompt).digest('hex')).toBe(observerAssetPins['observer-instructions.md']);
  await writeFile(files.instructionsPath,prompt);
  files.instructionsSha256=observerAssetPins['observer-instructions.md'];
  const runtimeProbe=vi.fn(async()=>({version:evidence.version,features:evidence.features}));
  await expect(preflightCodexRuntime(files,runtimeProbe)).resolves.toMatchObject({version:'0.153.3'});
  await expect(preflightCodex(files,async()=>evidence)).resolves.toMatchObject({version:'0.153.3'});
  const cache=createRuntimePreflightCache(files);
  await cache.check(runtimeProbe);await cache.check(runtimeProbe);
  expect(runtimeProbe).toHaveBeenCalledTimes(2);
  // A cache hit still checks the complete prompt, including its >16 KiB tail.
  const changed=Buffer.from(prompt);changed[changed.length-1]=changed[changed.length-1]!^1;
  await writeFile(files.instructionsPath,changed);
  await expect(cache.check(runtimeProbe)).rejects.toThrow('CODEX_PREFLIGHT_FAILED');
  expect(runtimeProbe).toHaveBeenCalledTimes(2);
});
it('detects replacement of the long release-pinned prompt after runtime probing',async()=>{
  const files=await fixture();
  const prompt=await fs.readFile(new URL('../../src/estimation/assets/observer-instructions.md',import.meta.url));
  await writeFile(files.instructionsPath,prompt);files.instructionsSha256=observerAssetPins['observer-instructions.md'];
  await expect(preflightCodexRuntime(files,async()=>{
    await writeFile(files.instructionsPath,Buffer.concat([prompt,Buffer.from('changed')]));
    return {version:evidence.version,features:evidence.features};
  })).rejects.toThrow('CODEX_PREFLIGHT_FAILED');
});
it.each(['schemaPath','compressionSchemaPath','compressionInstructionsPath'] as const)(
  'retains the 16 KiB limit for %s even with matching hashes',async key=>{
    const base=await fixture(),large='x'.repeat(16385);
    const files={...base,compressionSchemaPath:join(base.cwd,'..','compression.json'),
      compressionInstructionsPath:join(base.cwd,'..','compression.md'),
      compressionSchemaSha256:pin('{}'),compressionInstructionsSha256:pin('summary')};
    await writeFile(files.compressionSchemaPath,'{}');await writeFile(files.compressionInstructionsPath,'summary');
    await writeFile(files[key],large);
    const hashKey=key==='schemaPath'?'schemaSha256':key==='compressionSchemaPath'?'compressionSchemaSha256':'compressionInstructionsSha256';
    files[hashKey]=pin(large);
    const probe=vi.fn(async()=>({version:evidence.version,features:evidence.features}));
    await expect(preflightCodexRuntime(files,probe)).rejects.toThrow('CODEX_PREFLIGHT_FAILED');
    expect(probe).not.toHaveBeenCalled();
  });
it('rejects an oversized prompt bearing the release pin before any runtime probe',async()=>{
  const files=await fixture();await writeFile(files.instructionsPath,'x'.repeat(observerInstructionsMaxBytes+1));
  files.instructionsSha256=observerAssetPins['observer-instructions.md'];
  const probe=vi.fn(async()=>({version:evidence.version,features:evidence.features}));
  await expect(preflightCodexRuntime(files,probe)).rejects.toThrow('CODEX_PREFLIGHT_FAILED');
  expect(probe).not.toHaveBeenCalled();
});
it("rejects conflicting duplicate capability evidence",async()=>{
  await expect(preflightCodex(await fixture(),async()=>({...evidence,features:evidence.features+"\nhooks\tremoved\tfalse"}))).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
});
it.skipIf(process.platform!=="win32")("rejects drive-less rooted Windows paths before probing",async()=>{
  const files=await fixture();
  for(const key of ["executable","cwd","schemaPath","instructionsPath"] as const) {
    let probed=false;
    await expect(preflightCodex({...files,[key]:files[key].slice(2)},async()=>{probed=true;return evidence;})).rejects.toThrow("CODEX_PREFLIGHT_FAILED");
    expect(probed).toBe(false);
  }
});
