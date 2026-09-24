import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') process.exit(0);

const script = resolve('scripts/windows/observer-home.ps1');
const shell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const minimal = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH'].includes(key.toUpperCase())));

for (const [name, value] of [['temp', tmpdir()], ['script', script], ['powershell', shell]]) {
  const canonical = realpathSync(value);
  console.log(`${name}: ${value === canonical ? 'canonical' : 'alias'}`);
}

for (const [name, env] of [['full', process.env], ['minimal', minimal]]) {
  const parent = mkdtempSync(join(tmpdir(), 'hud-native-preflight-'));
  try {
    const result = spawnSync(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ParentDirectory', parent
    ], { cwd: parent, env, timeout: 15000, windowsHide: true, encoding: 'utf8' });
    let response = 'invalid';
    try { response = JSON.parse(result.stdout)?.ok === true ? 'ok' : 'rejected'; } catch { /* no credential data */ }
    console.log(`${name}: exit=${result.status} signal=${result.signal} error=${result.error?.code ?? 'none'} response=${response} stderrBytes=${Buffer.byteLength(result.stderr ?? '')}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
