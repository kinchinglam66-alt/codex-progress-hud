import {describe,it,expect} from 'vitest';
import {join} from 'node:path';
import {defaultDataDirectory,defaultTokenPath,defaultRuntimePath,defaultInstallManifestPath,defaultSettingsPath} from '../../src/server/paths.js';

describe.runIf(process.platform==='win32')('shared Windows HUD data paths',()=>{
  const profile='C:\\Users\\hud-path-test';
  it('does not change when a packaged host virtualizes AppData',()=>{
    const direct={USERPROFILE:profile,APPDATA:join(profile,'AppData','Roaming')};
    const packaged={...direct,APPDATA:join(profile,'AppData','Local','Packages','Example','LocalCache','Roaming')};
    for(const get of [defaultDataDirectory,defaultTokenPath,defaultRuntimePath,defaultInstallManifestPath,defaultSettingsPath]){
      expect(get(direct)).toBe(get(packaged));
      expect(get(direct)).toContain(join(profile,'.codex-progress-hud'));
      expect(get(direct)).not.toContain('AppData');
    }
  });
  it('preserves explicit isolated data and token paths',()=>{
    const environment={USERPROFILE:profile,CODEX_PROGRESS_HUD_DATA_DIR:'C:\\isolated-hud',CODEX_PROGRESS_HUD_TOKEN_PATH:'C:\\isolated-token'};
    expect(defaultDataDirectory(environment)).toBe('C:\\isolated-hud');
    expect(defaultTokenPath(environment)).toBe('C:\\isolated-token');
    expect(defaultInstallManifestPath(environment)).toBe(join('C:\\isolated-hud','install.json'));
  });
});
