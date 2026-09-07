import type {CodexFiles} from './codex-preflight.js';
import {isAbsolute,resolve} from 'node:path';
import {observerAssetPins} from './asset-pins.js';
import {codexRuntimeProfiles} from './codex-runtime-profiles.js';

/** Expected release files, NOT verified runtime evidence or consent. Callers
 * must run preflight against these pins and revalidate before dispatch. */
export function observerReleaseFiles(resourcesDirectory:string,executable:string,cwd:string,version:string,executableSha256?:string):CodexFiles {
  const runtime=codexRuntimeProfiles.find(candidate=>candidate.version===version &&
    (executableSha256===undefined || candidate.sha256===executableSha256));
  if(!runtime || [resourcesDirectory,executable,cwd].some(path=>typeof path!=='string' || !isAbsolute(path) ||
    /[\p{Cc}\p{Cf}]/u.test(path) || /(?:^|[\\/])[^\\/]*\.asar(?:[\\/]|$)/i.test(path) ||
    (process.platform==='win32' && !/^[a-z]:[\\/]/i.test(path)))) {
    throw new Error('OBSERVER_RELEASE_FILES_UNAVAILABLE');
  }
  return Object.freeze({executable:resolve(executable),cwd:resolve(cwd),
    schemaPath:resolve(resourcesDirectory,'observer-assets','observer.schema.json'),
    instructionsPath:resolve(resourcesDirectory,'observer-assets','observer-instructions.md'),
    executableSha256:runtime.sha256,schemaSha256:observerAssetPins['observer.schema.json'],
    instructionsSha256:observerAssetPins['observer-instructions.md']});
}
