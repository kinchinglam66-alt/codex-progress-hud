import {expect,it} from 'vitest';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {defaultCodexSessionsRoot} from '../../src/server/paths.js';
it('selects the main Codex sessions root independently from HUD data',()=>{
  expect(defaultCodexSessionsRoot({CODEX_HOME:join(homedir(),'custom-codex'),CODEX_PROGRESS_HUD_DATA_DIR:'private-hud'}))
    .toBe(join(homedir(),'custom-codex','sessions'));
  expect(defaultCodexSessionsRoot({CODEX_PROGRESS_HUD_DATA_DIR:'private-hud'}))
    .toBe(join(homedir(),'.codex','sessions'));
});
