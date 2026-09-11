import type {InvocationRecord} from './invocation-ownership.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveTrustedPowerShellPath} from './recovery-boot-boundary.js';

const execute = promisify(execFile);
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff;
type ProcessState = 'closed' | 'live' | 'unconfirmed';

// Pin one OS process handle before checking creation time and use that same
// Process object for Kill. Never reopen the PID after checking its identity.
async function probe(pid: number, identity?: string, terminate = false): Promise<string | null> {
  if (process.platform !== 'win32' || !validPid(pid) || identity !== undefined && !/^\d{1,20}$/.test(identity)) return null;
  const script = `
$ErrorActionPreference='Stop'
$ownedProcess=$null
try {
  try { $ownedProcess=[System.Diagnostics.Process]::GetProcessById(${pid}) }
  catch [System.ArgumentException] { [Console]::Out.Write('closed'); exit 0 }
  $null=$ownedProcess.Handle
  if ($ownedProcess.HasExited) { [Console]::Out.Write('closed'); exit 0 }
  $identity=$ownedProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  ${identity === undefined ? "[Console]::Out.Write($identity)" : `if ($identity -ne '${identity}') { [Console]::Out.Write('closed') }
  elseif (${terminate ? '$true' : '$false'}) {
    $ownedProcess.Kill()
    if ($ownedProcess.WaitForExit(2000)) { [Console]::Out.Write('closed') } else { [Console]::Out.Write('live') }
  } else { [Console]::Out.Write('live') }`}
} catch { [Console]::Out.Write('unconfirmed') }
finally { if ($null -ne $ownedProcess) { $ownedProcess.Dispose() } }
`;
  try {
    const {stdout} = await execute(resolveTrustedPowerShellPath(), ['-NoProfile', '-NoLogo', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {windowsHide: true, timeout: 6_000, maxBuffer: 1024});
    return stdout.trim();
  } catch {return null;}
}

export async function captureInvocationProcessIdentity(pid: number): Promise<string | null> {
  const identity = await probe(pid);
  return identity !== null && /^\d{1,20}$/.test(identity) ? identity : null;
}

export async function inspectInvocationProcess(record: InvocationRecord, terminateExpired: boolean): Promise<ProcessState> {
  if (record.providerKind !== 'subscription' || record.pid === undefined || record.creationIdentity === undefined) return 'unconfirmed';
  const state = await probe(record.pid, record.creationIdentity, terminateExpired);
  return state === 'closed' || state === 'live' ? state : 'unconfirmed';
}
