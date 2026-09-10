import {execFile} from 'node:child_process';
import {win32} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';

const execFileAsync = promisify(execFile);
const MAX_PROBE_MS = 5_000;
export const RECOVERY_BOOT_PROOF_MAX_AGE_MS = 30_000;
export const RECOVERY_BOOT_BOUNDARY_MARGIN_MS = 5_000;

const safeEpoch = z.number().int().nonnegative().safe();
const trustedSystemRoot = /^[A-Za-z]:[\\/](?:[^<>:"/\\|?*\u0000-\u001F]+[\\/]?)*$/u;
export const recoveryBootBoundaryProofSchema = z.object({
  source: z.literal('windows-win32-operating-system'),
  bootAt: safeEpoch,
  observedAt: safeEpoch,
}).strict().refine(value => value.bootAt <= value.observedAt);

export type RecoveryBootBoundaryProof = z.infer<typeof recoveryBootBoundaryProofSchema>;

export interface RecoveryBootBoundaryOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  runPowerShell?: () => Promise<string>;
  systemRoot?: string;
  execFile?: RecoveryBootBoundaryExecFile;
}

export type RecoveryBootBoundaryExecFile = (file: string, args: string[], options: {
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
}) => Promise<{stdout: string}>;

function unavailable(): never { throw new Error('RECOVERY_BOOT_PROOF_UNAVAILABLE'); }

function validateNow(now: () => number): number {
  const value = now();
  return safeEpoch.safeParse(value).success ? value : unavailable();
}

export function resolveTrustedPowerShellPath(systemRoot: unknown = process.env.SystemRoot ?? process.env.SYSTEMROOT): string {
  if (typeof systemRoot !== 'string' || !trustedSystemRoot.test(systemRoot) || /(?:^|[\\/])\.{1,2}(?=[\\/]|$)/u.test(systemRoot)) unavailable();
  return win32.resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const executePowerShell: RecoveryBootBoundaryExecFile = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return {stdout: String(result.stdout)};
};

async function runPowerShell(systemRoot: unknown, execute: RecoveryBootBoundaryExecFile): Promise<string> {
  const command = [
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop',
    '$utc = $os.LastBootUpTime.ToUniversalTime()',
    '[Console]::Out.WriteLine([DateTimeOffset]::new($utc).ToUnixTimeMilliseconds())',
  ].join('; ');
  const result = await execute(resolveTrustedPowerShellPath(systemRoot), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command,
  ], {timeout: MAX_PROBE_MS, windowsHide: true, maxBuffer: 4_096});
  return result.stdout;
}

export async function inspectRecoveryBootBoundary(options: RecoveryBootBoundaryOptions = {}): Promise<RecoveryBootBoundaryProof> {
  if ((options.platform ?? process.platform) !== 'win32') unavailable();
  const now = options.now ?? Date.now;
  const observedAt = validateNow(now);
  let output: string;
  try { output = await (options.runPowerShell ?? (() => runPowerShell(options.systemRoot, options.execFile ?? executePowerShell)))(); }
  catch { return unavailable(); }
  const text = output.trim();
  if (!/^\d+$/.test(text)) unavailable();
  const bootAt = Number(text);
  if (!safeEpoch.safeParse(bootAt).success || bootAt > observedAt) unavailable();
  return {source: 'windows-win32-operating-system', bootAt, observedAt};
}

export function parseRecoveryBootBoundaryProof(value: unknown): RecoveryBootBoundaryProof {
  const parsed = recoveryBootBoundaryProofSchema.safeParse(value);
  if (!parsed.success) throw new Error('RELEASE_RECOVERY_INVALID');
  return parsed.data;
}
