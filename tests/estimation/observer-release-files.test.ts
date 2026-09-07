import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {observerReleaseFiles} from '../../src/estimation/observer-release-files.js';
import {observerAssetPins} from '../../src/estimation/asset-pins.js';
import {codexRuntimeProfiles} from '../../src/estimation/codex-runtime-profiles.js';

it('selects only an explicitly supported same-version build hash',()=>{
  const hash='e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75';
  expect(observerReleaseFiles(resolve('resources'),resolve('codex.exe'),resolve('empty'),'0.153.4',hash).executableSha256).toBe(hash);
  for(const version of ['0.153.3','0.999.0'])expect(()=>observerReleaseFiles(resolve('resources'),resolve('codex.exe'),resolve('empty'),version,hash)).toThrow();
  expect(()=>observerReleaseFiles(resolve('resources'),resolve('codex.exe'),resolve('empty'),'0.153.4','0'.repeat(64))).toThrow();
});

it('returns fixed release pins and external paths without reading or trusting files',()=>{
  const runtime=codexRuntimeProfiles[1]!;
  const files=observerReleaseFiles(resolve('resources'),resolve('codex.exe'),resolve('empty'),runtime.version);
  expect(files).toEqual({executable:resolve('codex.exe'),cwd:resolve('empty'),
    schemaPath:resolve('resources/observer-assets/observer.schema.json'),
    instructionsPath:resolve('resources/observer-assets/observer-instructions.md'),
    executableSha256:runtime.sha256,schemaSha256:observerAssetPins['observer.schema.json'],
    instructionsSha256:observerAssetPins['observer-instructions.md']});
  expect(Object.isFrozen(files)).toBe(true);
});
it('rejects unsupported runtime versions instead of trusting discovered hashes',()=>{
  expect(()=>observerReleaseFiles(resolve('resources'),resolve('codex.exe'),resolve('empty'),'0.999.0')).toThrow('OBSERVER_RELEASE_FILES_UNAVAILABLE');
});
it('rejects relative, unsafe and archive paths',()=>{
  for(const bad of ['relative',resolve('data')+'\n',resolve('app.asar/assets')]) {
    for(let index=0;index<3;index++) {
      const paths=[resolve('resources'),resolve('codex.exe'),resolve('empty')];paths[index]=bad;
      expect(()=>observerReleaseFiles(paths[0]!,paths[1]!,paths[2]!,'0.153.4')).toThrow('OBSERVER_RELEASE_FILES_UNAVAILABLE');
    }
  }
});
