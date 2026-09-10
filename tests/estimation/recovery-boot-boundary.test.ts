import {describe, expect, it} from 'vitest';
import {inspectRecoveryBootBoundary} from '../../src/estimation/recovery-boot-boundary.js';

describe('recovery boot boundary', () => {
  it('uses the trusted SystemRoot PowerShell path in the real probe wiring', async () => {
    let executable = '';
    await expect(inspectRecoveryBootBoundary({
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      now: () => 10_000,
      execFile: async (file) => { executable = file; return {stdout: '8\n'}; },
    })).resolves.toMatchObject({bootAt: 8, observedAt: 10_000});
    expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it.each(['powershell.exe', 'C:\\Windows\\..\\Temp'])('fails closed for an untrusted SystemRoot value: %s', async systemRoot => {
    await expect(inspectRecoveryBootBoundary({
      platform: 'win32', systemRoot, now: () => 10_000,
      execFile: async () => ({stdout: '8\n'}),
    })).rejects.toThrow('RECOVERY_BOOT_PROOF_UNAVAILABLE');
  });

  it('returns a typed Windows Win32 boot proof from an exact UTC epoch sample', async () => {
    await expect(inspectRecoveryBootBoundary({
      platform: 'win32',
      now: () => 10_000,
      runPowerShell: async () => '8\n',
    })).resolves.toEqual({
      source: 'windows-win32-operating-system',
      bootAt: 8,
      observedAt: 10_000,
    });
  });

  it.each([
    ['missing output', ''],
    ['multiple lines', '8\n9\n'],
    ['decimal output', '8.5'],
    ['negative output', '-1'],
    ['unsafe output', '9007199254740992'],
  ])('rejects %s from the bounded probe', async (_label, output) => {
    await expect(inspectRecoveryBootBoundary({
      platform: 'win32',
      now: () => 10_000,
      runPowerShell: async () => output,
    })).rejects.toThrow('RECOVERY_BOOT_PROOF_UNAVAILABLE');
  });

  it('rejects a boot timestamp observed in the future', async () => {
    await expect(inspectRecoveryBootBoundary({
      platform: 'win32',
      now: () => 10_000,
      runPowerShell: async () => '10_001',
    })).rejects.toThrow('RECOVERY_BOOT_PROOF_UNAVAILABLE');
  });

  it('fails closed when Windows boot evidence is unavailable on another platform', async () => {
    await expect(inspectRecoveryBootBoundary({
      platform: 'linux',
      now: () => 10_000,
      runPowerShell: async () => '8',
    })).rejects.toThrow('RECOVERY_BOOT_PROOF_UNAVAILABLE');
  });
});
