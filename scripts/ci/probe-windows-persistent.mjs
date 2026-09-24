import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePowerShellEnvironment } from '../../dist/estimation/native-powershell-environment.js';

if (process.platform !== 'win32') process.exit(0);

const shell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const script = resolve('scripts/windows/observer-home.ps1');
const machinePaths = (process.env.PSModulePath ?? '').split(';').filter((path) =>
  /^[a-z]:\\(?:Windows|Program Files(?: \(x86\))?)\\/i.test(path));
const variants = [
  ['full', process.env],
  ['fixed', nativePowerShellEnvironment()],
  ['machine-host', { ...nativePowerShellEnvironment(), PSModulePath: machinePaths.join(';') }]
];

let fixedSucceeded = false;
for (const [name, env] of variants) {
  const parent = mkdtempSync(join(tmpdir(), 'hud-persistent-probe-'));
  try {
    const setup = spawnSync(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ParentDirectory', parent
    ], { cwd: parent, env: process.env, timeout: 10000, windowsHide: true, encoding: 'utf8' });
    if (setup.status !== 0) throw new Error('synthetic home setup failed');
    const auth = join(parent, 'observer-auth', 'auth.json');
    writeFileSync(auth, 'synthetic-not-a-token');
    const result = spawnSync(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ParentDirectory', parent, '-Persistent'
    ], {
      cwd: parent, env, timeout: 10000, windowsHide: true, encoding: 'utf8',
      input: '{"v":1,"id":1,"op":"verify"}\n'
    });
    let response = 'invalid';
    try {
      const parsed = JSON.parse(result.stdout.trim());
      response = parsed.ok === true && parsed.id === 1 && parsed.v === 1 ? 'ok' : 'rejected';
    } catch { /* synthetic protocol output only */ }
    console.log(`${name}: exit=${result.status} signal=${result.signal} error=${result.error?.code ?? 'none'} response=${response} stdoutBytes=${Buffer.byteLength(result.stdout ?? '')} stderrBytes=${Buffer.byteLength(result.stderr ?? '')}`);
    if (name === 'fixed') fixedSucceeded = response === 'ok';
    if (name === 'full') {
      const grant = spawnSync(shell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$p=$env:HUD_TEST_TARGET; $a=[IO.File]::GetAccessControl($p); $s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow'); $a.AddAccessRule($r); [IO.File]::SetAccessControl($p,$a); $b=[IO.File]::GetAccessControl($p); [Console]::Out.WriteLine((@($b.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value}) -join ','))"
      ], { cwd: parent, env: { ...process.env, HUD_TEST_TARGET: auth }, timeout: 10000, windowsHide: true, encoding: 'utf8' });
      const check = spawnSync(shell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-ParentDirectory', parent, '-VerifyOnly'
      ], { cwd: parent, env: process.env, timeout: 10000, windowsHide: true, encoding: 'utf8' });
      console.log(`grant: exit=${grant.status} sids=${grant.stdout.trim()} verifyExit=${check.status} stderrBytes=${Buffer.byteLength(check.stderr ?? '')}`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
if (!fixedSucceeded) throw new Error('Fixed machine module path did not complete the synthetic persistent check');
