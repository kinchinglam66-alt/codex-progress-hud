import { dirname, join, parse } from 'node:path';
import { resolveTrustedPowerShellPath } from './recovery-boot-boundary.js';

/** Run fixed native guards with Windows' machine modules, never user modules. */
export function nativePowerShellEnvironment(host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(host).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH'].includes(key.toUpperCase())));
  if (process.platform !== 'win32') return env;

  const shellDirectory = dirname(resolveTrustedPowerShellPath(host.SystemRoot ?? host.SYSTEMROOT));
  const driveRoot = parse(shellDirectory).root;
  env.PSModulePath = [
    join(driveRoot, 'Program Files/PowerShell/Modules'),
    join(driveRoot, 'Program Files/PowerShell/7/Modules'),
    join(driveRoot, 'Program Files/WindowsPowerShell/Modules'),
    join(driveRoot, 'Program Files (x86)/WindowsPowerShell/Modules'),
    join(shellDirectory, 'Modules')
  ].join(';');
  return env;
}
