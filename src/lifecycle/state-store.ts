import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  DesiredHudState,
  HudSettings,
  InstallManifest,
  LifecycleStateStore,
  RuntimeIdentity
} from "./types.js";

export interface LifecycleStatePaths {
  settingsPath: string;
  runtimePath: string;
  installManifestPath: string;
}

const settingsSchema = z.object({
  desiredState: z.enum(["on", "off"]).optional(),
  startWithWindows: z.boolean()
});

const runtimeIdentitySchema = z.object({
  pid: z.number(),
  version: z.string(),
  protocolVersion: z.number(),
  instanceNonce: z.string(),
  startedAt: z.string()
});

const installManifestSchema = z.object({
  executablePath: z.string(),
  installDirectory: z.string(),
  version: z.string()
});

const pendingWrites = new Map<string, Promise<void>>();

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    return schema.parse(JSON.parse(content));
  } catch {
    throw new Error(`Invalid lifecycle JSON file: ${path}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  });
  pendingWrites.set(path, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(path) === current) pendingWrites.delete(path);
  }
}

export function createLifecycleStateStore(paths: LifecycleStatePaths): LifecycleStateStore {
  return {
    async readSettings(): Promise<HudSettings> {
      const settings = await readJson(paths.settingsPath, settingsSchema);
      if (settings?.desiredState !== undefined) {
        return {
          desiredState: settings.desiredState,
          startWithWindows: settings.startWithWindows
        };
      }
      return { startWithWindows: settings?.startWithWindows ?? false };
    },

    async setDesiredState(state: DesiredHudState): Promise<HudSettings> {
      const settings = { ...(await this.readSettings()), desiredState: state };
      await writeJsonAtomic(paths.settingsPath, settings);
      return settings;
    },

    async writeRuntime(identity: RuntimeIdentity): Promise<void> {
      await writeJsonAtomic(paths.runtimePath, runtimeIdentitySchema.parse(identity));
    },

    readRuntime(): Promise<RuntimeIdentity | null> {
      return readJson(paths.runtimePath, runtimeIdentitySchema);
    },

    async clearRuntime(): Promise<void> {
      try {
        await unlink(paths.runtimePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },

    readInstallManifest(): Promise<InstallManifest | null> {
      return readJson(paths.installManifestPath, installManifestSchema);
    }
  };
}
