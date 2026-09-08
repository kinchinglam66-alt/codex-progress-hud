import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SpawnedHud {
  pid: number;
  terminate(): Promise<void>;
}

export interface ProcessLauncher {
  spawnHud(executablePath: string, options: { generation: number }): Promise<SpawnedHud>;
}

type SpawnProcess = (
  executablePath: string,
  arguments_: string[],
  options: SpawnOptions
) => Pick<ChildProcess, "pid" | "unref" | "kill">;

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
      return {
        pid: child.pid,
        async terminate(): Promise<void> {
          child.kill();
        }
      };
    }
  };
}

export const processLauncher = createProcessLauncher();
