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

export function createProcessLauncher(spawnProcess: SpawnProcess = spawn): ProcessLauncher {
  return {
    async spawnHud(executablePath: string, options: { generation: number }): Promise<SpawnedHud> {
      const child = spawnProcess(
        executablePath,
        ["--hud", `--manager-generation=${options.generation}`],
        {
          detached: true,
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
