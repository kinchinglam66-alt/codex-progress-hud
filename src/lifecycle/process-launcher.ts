import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SpawnedHud {
  pid: number;
  terminate(): Promise<void>;
  exited?:Promise<'exited'|'terminated'>;
  outcome?(): "running" | "termination_requested" | "exited" | "terminated" | "unknown";
}

export interface ProcessLauncher {
  spawnHud(executablePath: string, options: { generation: number }): Promise<SpawnedHud>;
}

type SpawnProcess = (
  executablePath: string,
  arguments_: string[],
  options: SpawnOptions
) => Pick<ChildProcess, "pid" | "unref" | "kill"> & {
  once?: (event: string, listener: (...args: any[]) => void) => unknown;
};

export function createProcessLauncher(
  spawnProcess: SpawnProcess = spawn,
  environment: NodeJS.ProcessEnv = process.env
): ProcessLauncher {
  return {
    async spawnHud(executablePath: string, options: { generation: number }): Promise<SpawnedHud> {
      const childEnvironment = { ...environment };
      delete childEnvironment.ELECTRON_RUN_AS_NODE;
      const child = spawnProcess(
        executablePath,
        // Apply the transparent-window rendering workaround before Electron
        // initializes; async desktop setup can miss the pre-ready API window.
        ["--hud", `--manager-generation=${options.generation}`, "--disable-gpu"],
        {
          detached: true,
          env: childEnvironment,
          stdio: "ignore",
          shell: false
        }
      );
      if (child.pid === undefined) throw new Error("HUD process did not provide a PID");
      child.unref();
      let childOutcome: "running" | "termination_requested" | "exited" | "terminated" | "unknown" = "running";
      let terminationRequested = false;
      let confirmExit!:(outcome:'exited'|'terminated')=>void;
      const exited=new Promise<'exited'|'terminated'>(resolve=>{confirmExit=resolve;});
      child.once?.("error", () => {
        if (childOutcome === "running" || childOutcome === "termination_requested") childOutcome = "unknown";
      });
      child.once?.("exit", () => {
        childOutcome = terminationRequested ? "terminated" : "exited";
        confirmExit(childOutcome);
      });
      return {
        pid: child.pid,
        exited,
        outcome: () => childOutcome,
        async terminate(): Promise<void> {
          let killed: boolean;
          try {
            killed = child.kill();
          } catch (error) {
            childOutcome = "unknown";
            throw error;
          }
          if (!killed) {
            childOutcome = "unknown";
            return;
          }
          terminationRequested = true;
          if (childOutcome === "running") childOutcome = "termination_requested";
        }
      };
    }
  };
}

export const processLauncher = createProcessLauncher();
