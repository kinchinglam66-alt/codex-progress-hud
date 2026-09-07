// Bounded isolated probe: print only known error categories, never raw stderr.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'hud-startup-probe-'));
await writeFile(join(directory, 'settings.json'), JSON.stringify({ desiredState: 'on', generation: 1, startWithWindows: false }));
const env = { ...process.env, CODEX_PROGRESS_HUD_DATA_DIR: directory, APPDATA: directory,
  CODEX_PROGRESS_HUD_PORT: '0', CODEX_PROGRESS_HUD_TOKEN_PATH: join(directory, 'auth.token') };
delete env.ELECTRON_RUN_AS_NODE;
const children = Array.from({ length: 4 }, () => {
  const child = spawn(resolve('release/win-unpacked/Codex Progress HUD.exe'), ['--hud', '--manager-generation=1'],
    { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  return { child, result: () => ({ exited: child.exitCode !== null,
    hardwareAccelerationError: /disableHardwareAcceleration/.test(stderr),
    startupError: /failed to start/.test(stderr),
    afterReadyError: /ready/.test(stderr),
    portConflict: /EADDRINUSE/.test(stderr) }) };
});
await new Promise(resolve => setTimeout(resolve, 5000));
const results = children.map(entry => entry.result());
console.log(results);
// Only terminate direct children created by this probe, never existing HUDs.
for (const { child } of children) if (child.exitCode === null) child.kill();
if (results.filter(result => !result.exited).length !== 1 ||
    results.some(result => result.startupError || result.hardwareAccelerationError)) {
  throw new Error('startup probe failed: expected one healthy owner and three exited duplicates');
}
