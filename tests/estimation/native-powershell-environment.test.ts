import { expect, it } from 'vitest';
import { nativePowerShellEnvironment } from '../../src/estimation/native-powershell-environment.js';

it.skipIf(process.platform !== 'win32')('uses fixed machine modules without forwarding user module or account paths', () => {
  const env = nativePowerShellEnvironment({
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\hud-ci-temp',
    PATH: 'C:\\Windows\\System32',
    PSModulePath: 'C:\\Users\\someone\\Documents\\WindowsPowerShell\\Modules',
    USERPROFILE: 'C:\\Users\\someone',
    CODEX_HOME: 'C:\\Users\\someone\\.codex'
  });
  expect(env.PSModulePath).toContain('WindowsPowerShell\\v1.0\\Modules');
  expect(env.PSModulePath).toContain('Program Files\\PowerShell\\Modules');
  expect(env.PSModulePath).not.toContain('Users\\someone');
  expect(env).not.toHaveProperty('USERPROFILE');
  expect(env).not.toHaveProperty('CODEX_HOME');
  expect(env.TEMP).toBe('C:\\hud-ci-temp');
});
