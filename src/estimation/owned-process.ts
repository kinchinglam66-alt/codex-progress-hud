import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { isAbsolute } from "node:path";

export interface Invocation { executable: string; cwd: string; args: readonly string[]; env: NodeJS.ProcessEnv; input: string; onStdout?: (chunk: Uint8Array) => boolean }
type Reason = "exited" | "aborted" | "disabled" | "busy" | "unavailable" | "timeout" | "output_limit" | "spawn_error" | "stdin_error" | "cleanup_timeout" | "protocol_error";
export interface OwnedProcessResult { reason: Reason; exitCode: number | null; closed: boolean; stdout: string; stderr: string }
type Spawn = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface Options { spawn?: Spawn; timeoutMs?: number; cleanupMs?: number }

export function createOwnedLoginProcessRunner(options: Options = {}) {
  return createRunner({...options,timeoutMs:options.timeoutMs ?? 600000},600000);
}

/** Direct-child supervision only; parent-crash/process-tree containment requires
 * a separately verified platform owner before installation. No public logging.
 */
export function createOwnedProcessRunner(options: Options = {}) {
  return createRunner(options,60000);
}

function createRunner(options: Options, maximumTimeoutMs:number) {
  const timeoutMs = options.timeoutMs ?? 60_000, cleanupMs = options.cleanupMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs ||
    !Number.isInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 5_000) throw new Error("INVALID_PROCESS_DEADLINE");
  const launch = options.spawn ?? spawn;
  let active = false, disabled = false, poisoned = false;
  let cancelActive: (() => void) | undefined;
  const empty = (reason: Reason, closed = true): OwnedProcessResult => ({ reason, closed, exitCode:null, stdout:"", stderr:"" });
  return {
    status() { return { active, disabled, poisoned }; },
    disable() { disabled = true; cancelActive?.(); },
    run(invocation: Invocation, signal: AbortSignal): Promise<OwnedProcessResult> {
      if (disabled || poisoned) return Promise.resolve(empty("unavailable", !active));
      if (active) return Promise.resolve(empty("busy", false));
      if (signal.aborted) return Promise.resolve(empty("aborted"));
      if (!isAbsolute(invocation.executable) || !isAbsolute(invocation.cwd) ||
        Buffer.byteLength(invocation.input) > 16_384 || invocation.args.length > 256 ||
        invocation.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) return Promise.reject(new Error("INVALID_PROCESS_INVOCATION"));
      active = true;
      return new Promise(resolve => {
        let child: ChildProcessWithoutNullStreams;
        try { child = launch(invocation.executable, [...invocation.args], {
          cwd:invocation.cwd, env:{...invocation.env}, shell:false, windowsHide:true, stdio:"pipe"
        }); } catch { active = false; resolve(empty("spawn_error")); return; }
        let stopReason: Reason | undefined, settled = false;
        let outBytes = 0, errBytes = 0;
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let cleanup: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: OwnedProcessResult) => {
          if (settled) return; settled = true;
          clearTimeout(deadline); clearTimeout(cleanup);
          if (value.closed) { signal.removeEventListener("abort", onAbort); cancelActive = undefined; }
          resolve(value);
        };
        const stop = (reason: Reason) => {
          if (stopReason || settled) {
            if (active) { try { child.kill(); } catch { /* Keep direct-child control until close. */ } }
            return;
          }
          stopReason = reason; stdout.length = 0; stderr.length = 0;
          clearTimeout(deadline);
          cleanup = setTimeout(() => { poisoned = true; finish(empty("cleanup_timeout", false)); },cleanupMs);
          try { child.kill(); } catch { /* Keep ownership until close or fail closed. */ }
        };
        const onAbort = () => stop("aborted");
        cancelActive = () => stop("disabled");
        child.stdout.on("data", (chunk: Buffer) => {
          if (stopReason || settled) return;
          outBytes += chunk.length;
          if (outBytes > 262_144) { stop("output_limit"); return; }
          try {
            if (invocation.onStdout && invocation.onStdout(Buffer.from(chunk)) !== true) { stop("protocol_error"); return; }
          } catch { stop("protocol_error"); return; }
          if (!invocation.onStdout) stdout.push(Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stopReason || settled) return;
          errBytes += chunk.length;
          if (errBytes > 65_536) { stop("output_limit"); return; }
          if (!invocation.onStdout) stderr.push(Buffer.from(chunk));
        });
        child.on("error", () => stop("spawn_error"));
        child.stdin.on("error", () => stop("stdin_error"));
        child.stdout.on("error", () => stop("spawn_error"));
        child.stderr.on("error", () => stop("spawn_error"));
        child.once("close", code => {
          active = false;
          signal.removeEventListener("abort", onAbort); cancelActive = undefined;
          finish(stopReason ? empty(stopReason) : { reason:"exited", exitCode:code, closed:true,
            stdout:Buffer.concat(stdout).toString("utf8"), stderr:Buffer.concat(stderr).toString("utf8") });
        });
        deadline = setTimeout(() => stop("timeout"),timeoutMs);
        signal.addEventListener("abort",onAbort,{once:true});
        if (signal.aborted) { onAbort(); return; }
        try { child.stdin.end(invocation.input); } catch { stop("stdin_error"); }
      });
    }
  };
}
