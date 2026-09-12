import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { buildCodexInvocation, type CodexProfile } from "./codex-invocation.js";
import {parseCodexVersion} from './codex-runtime-profiles.js';

export interface CodexFiles {
  executable:string; cwd:string; schemaPath:string; instructionsPath:string;
  executableSha256:string; schemaSha256:string; instructionsSha256:string;
  compressionSchemaPath?:string; compressionInstructionsPath?:string;
  compressionSchemaSha256?:string; compressionInstructionsSha256?:string;
}
interface Evidence { version:string; features:string; login:string }
export interface CodexRuntimeEvidence { version:string; features:string }
type Probe=(executable:string,cwd:string)=>Promise<Evidence>;
type RuntimeProbe=(executable:string,cwd:string)=>Promise<CodexRuntimeEvidence>;
const evidenceSchema=z.object({version:z.string().max(256),features:z.string().max(65536),login:z.string().max(1024)}).strict();
const runtimeEvidenceSchema=z.object({version:z.string().max(256),features:z.string().max(65536)}).strict();
const canonical=(path:string)=>process.platform==="win32"?resolve(path).toLowerCase():resolve(path);
function qualifiedPath(path:string):string {
  if(typeof path!=="string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error();
  // Windows isAbsolute also accepts \file (current-drive dependent). Require a
  // drive-qualified local path or ordinary UNC path; reject device namespaces.
  if(process.platform==="win32" && !/^(?:[a-z]:[\\/]|\\\\[^\\/.?][^\\/]*[\\/][^\\/]+(?:[\\/]|$))/i.test(path)) throw Error();
  return resolve(path);
}
async function regularFile(path:string,pin:string,maxBytes:number):Promise<void> {
  if(!/^[a-f0-9]{64}$/.test(pin) || !(await lstat(path)).isFile() ||
    canonical(await realpath(path))!==canonical(path)) throw Error();
  const file=await open(path,"r");
  try {
    const before=await file.stat();
    if(!before.isFile() || before.size>maxBytes) throw Error();
    const hash=createHash("sha256"),buffer=Buffer.alloc(65536);
    let total=0;
    for(;;) {
      const {bytesRead}=await file.read(buffer,0,buffer.length,null);
      if(!bytesRead) break;
      total+=bytesRead;if(total>maxBytes) throw Error();
      hash.update(buffer.subarray(0,bytesRead));
    }
    const after=await file.stat();
    if(total!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || hash.digest("hex")!==pin) throw Error();
  } finally { await file.close(); }
}
async function verify(files:CodexFiles):Promise<void> {
  for(const path of [files.executable,files.cwd,files.schemaPath,files.instructionsPath]) {
    if(typeof path!=="string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error();
  }
  if(!(await lstat(files.cwd)).isDirectory() || canonical(await realpath(files.cwd))!==canonical(files.cwd) ||
    (await readdir(files.cwd)).length!==0) throw Error();
  await regularFile(files.executable,files.executableSha256,512*1024*1024);
  await regularFile(files.schemaPath,files.schemaSha256,16384);
  await regularFile(files.instructionsPath,files.instructionsSha256,16384);
  const compressionPaths=[files.compressionSchemaPath,files.compressionInstructionsPath,
    files.compressionSchemaSha256,files.compressionInstructionsSha256];
  if(compressionPaths.some(value=>value!==undefined)) {
    if(compressionPaths.some(value=>value===undefined)) throw Error();
    await regularFile(files.compressionSchemaPath!,files.compressionSchemaSha256!,16384);
    await regularFile(files.compressionInstructionsPath!,files.compressionInstructionsSha256!,16384);
  }
}

function parseFeatures(evidence:string):string[] {
  const features:string[]=[],seen=new Set<string>();
  for(const line of evidence.trim().split(/\r?\n/)) {
    const match=/^([a-z][a-z0-9_]*)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/.exec(line.trim());
    if(!match || seen.has(match[1]!)) throw Error();
    seen.add(match[1]!);
    if(match[2]!=='removed') features.push(match[1]!);
  }
  return features;
}

function profileFrom(files:CodexFiles,version:string,features:string[]):CodexProfile {
  const profile:CodexProfile={executable:files.executable,cwd:files.cwd,schemaPath:files.schemaPath,
    instructionsPath:files.instructionsPath,version,features:Object.freeze(features),
    ...(files.compressionSchemaPath===undefined?{}:{compressionSchemaPath:files.compressionSchemaPath}),
    ...(files.compressionInstructionsPath===undefined?{}:{compressionInstructionsPath:files.compressionInstructionsPath})};
  // Reuse the invocation's required feature gate without launching or reading
  // any ambient configuration. Numeric dummy data never reaches a model.
  buildCodexInvocation(profile,{activeSeconds:0,progress:null,toolCount:0,validationFailures:0},{});
  return profile;
}

function normalizedFiles(input:CodexFiles):CodexFiles {
  return {...input,executable:qualifiedPath(input.executable),cwd:qualifiedPath(input.cwd),
    schemaPath:qualifiedPath(input.schemaPath),instructionsPath:qualifiedPath(input.instructionsPath),
    ...(input.compressionSchemaPath===undefined?{}:{compressionSchemaPath:qualifiedPath(input.compressionSchemaPath)}),
    ...(input.compressionInstructionsPath===undefined?{}:{compressionInstructionsPath:qualifiedPath(input.compressionInstructionsPath)})};
}

/** Integrity relative to release-controlled pins, not vendor attestation.
 * Probe is an internal bounded, read-only host dependency, never task supplied.
 * No default live probe/discovery. Recheck before dispatch and enforce trusted
 * directory ownership in production: path checks do not eliminate TOCTOU races.
 */
export async function preflightCodex(input:CodexFiles,probe:Probe):Promise<CodexProfile> {
  try {
    const files=normalizedFiles(input);
    await verify(files);
    const evidence=evidenceSchema.parse(await probe(files.executable,files.cwd));
    const version = parseCodexVersion(evidence.version);
    if(version === null || evidence.login.trim()!=="Logged in using ChatGPT") throw Error();
    const features:string[]=[],seen=new Set<string>();
    for(const line of evidence.features.trim().split(/\r?\n/)) {
      const match=/^([a-z][a-z0-9_]*)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/.exec(line.trim());
      if(!match || seen.has(match[1]!)) throw Error();
      seen.add(match[1]!);
      if(match[2]!=="removed") features.push(match[1]!);
    }
    const profile:CodexProfile={executable:files.executable,cwd:files.cwd,schemaPath:files.schemaPath,
      instructionsPath:files.instructionsPath,version,features:Object.freeze(features),
      ...(files.compressionSchemaPath===undefined?{}:{compressionSchemaPath:files.compressionSchemaPath}),
      ...(files.compressionInstructionsPath===undefined?{}:{compressionInstructionsPath:files.compressionInstructionsPath})};
    // Reuse the invocation's required feature gate without launching or reading
    // any ambient configuration. Numeric dummy data never reaches a model.
    buildCodexInvocation(profile,{activeSeconds:0,progress:null,toolCount:0,validationFailures:0},{});
    await verify(files);
    return Object.freeze(profile);
  } catch { throw new Error("CODEX_PREFLIGHT_FAILED"); }
}

/** Runtime-only integrity preflight for first-use observers.
 * It validates the same release-controlled files, empty cwd, version and
 * feature gate as the historical preflight, but deliberately has no account or
 * login evidence in its input or result.
 */
export async function preflightCodexRuntime(input:CodexFiles,probe:RuntimeProbe):Promise<CodexProfile> {
  try {
    const files=normalizedFiles(input);
    await verify(files);
    const evidence=runtimeEvidenceSchema.parse(await probe(files.executable,files.cwd));
    const version=parseCodexVersion(evidence.version);
    if(version===null) throw Error();
    const profile=profileFrom(files,version,parseFeatures(evidence.features));
    await verify(files);
    return Object.freeze(profile);
  } catch { throw new Error("CODEX_PREFLIGHT_FAILED"); }
}

/** One-owner, 60s runtime-evidence cache. Never caches file integrity, directory
 * checks, account identity, route or consent. Every hit rehashes release files
 * before and after use. Revoke on any preparation failure or owner disable. */
export function createRuntimePreflightCache(input:CodexFiles,now:()=>number=()=>performance.now()) {
  const files=Object.freeze({...input});
  let epoch=0,busy=false;
  let cached:{evidence:CodexRuntimeEvidence;at:number}|undefined;
  const invalidate=()=>{epoch++;cached=undefined;};
  return {
    invalidate,
    async check(probe:RuntimeProbe):Promise<CodexProfile>{
      if(busy)throw new Error('CODEX_PREFLIGHT_FAILED');
      busy=true;const generation=epoch;
      try {
        const at=now();if(!Number.isFinite(at)||at<0)throw Error();
        if(cached&&(at<cached.at||at-cached.at>=60000))cached=undefined;
        let candidate:CodexRuntimeEvidence|undefined;
        const profile=await preflightCodexRuntime(files,async(executable,cwd)=>{
          if(epoch!==generation)throw Error();
          candidate=cached?.evidence??runtimeEvidenceSchema.parse(await probe(executable,cwd));
          return {...candidate};
        });
        if(epoch!==generation||!candidate)throw Error();
        // Hits do not extend the TTL. Cache only after both integrity checks pass.
        if(!cached)cached={evidence:Object.freeze({...candidate}),at};
        return profile;
      }catch{invalidate();throw new Error('CODEX_PREFLIGHT_FAILED');}
      finally{busy=false;}
    }
  };
}
