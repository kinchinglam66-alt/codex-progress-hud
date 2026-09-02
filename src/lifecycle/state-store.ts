import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { identityOf, retryWindowsSharing, unlinkIfIdentical, withLifecycleStateLock } from "./state-lock.js";
import { PROTOCOL_VERSION } from "./types.js";
import type { DesiredHudState, HudSettings, InstallManifest, LifecycleStateStore, RuntimeIdentity } from "./types.js";

export interface LifecycleStatePaths { settingsPath: string; runtimePath: string; installManifestPath: string; }

const boundedText = z.string().trim().min(1).max(256);
const absolutePath = z.string().trim().min(1).max(4096).refine(isAbsolute);
const canonicalTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)));
const settingsSchema = z.object({
  desiredState: z.enum(["on", "off"]).optional(),
  startWithWindows: z.boolean(),
  generation: z.number().int().nonnegative().safe().optional()
}).strict();
const runtimeIdentitySchema = z.object({
  pid: z.number().int().positive().safe(),
  version: boundedText,
  protocolVersion: z.literal(PROTOCOL_VERSION),
  instanceNonce: boundedText,
  startedAt: canonicalTimestamp
}).strict();
const installManifestSchema = z.object({
  executablePath: absolutePath,
  installDirectory: absolutePath,
  version: boundedText
}).strict();

const localQueues = new Map<string, Promise<unknown>>();

async function locallyOrdered<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(lockPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  localQueues.set(lockPath, current);
  try {
    return await current;
  } finally {
    if (localQueues.get(lockPath) === current) localQueues.delete(lockPath);
  }
}

async function readJsonUnlocked<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let content: string;
  try { content = await retryWindowsSharing(() => readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try { return schema.parse(JSON.parse(content)); }
  catch { throw new Error(`Invalid lifecycle JSON file: ${path}`); }
}

async function writeJsonUnlocked(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryIdentity: Awaited<ReturnType<typeof identityOf>> = null;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    temporaryIdentity = await identityOf(temporary);
    await retryWindowsSharing(() => rename(temporary, path));
  } finally {
    if (temporaryIdentity !== null) await unlinkIfIdentical(temporary, temporaryIdentity).catch(() => undefined);
  }
}

async function clearUnlocked(path: string): Promise<void> {
  const identity = await identityOf(path);
  if (identity !== null) await unlinkIfIdentical(path, identity);
}

function normalizedSettings(settings: z.infer<typeof settingsSchema> | null): HudSettings {
  return {
    startWithWindows: settings?.startWithWindows ?? false,
    generation: settings?.generation ?? 0,
    ...(settings?.desiredState === undefined ? {} : { desiredState: settings.desiredState })
  };
}

export function createLifecycleStateStore(paths: LifecycleStatePaths): LifecycleStateStore {
  const lockPath = join(dirname(paths.settingsPath), ".lifecycle-state.lock");
  const locked = <T>(operation: () => Promise<T>) => locallyOrdered(
    lockPath,
    () => withLifecycleStateLock(lockPath, operation)
  );
  const readSettingsUnlocked = async () => normalizedSettings(await readJsonUnlocked(paths.settingsPath, settingsSchema));
  return {
    readSettings: () => locked(readSettingsUnlocked),
    setDesiredState: (state) => locked(async () => {
      const current = await readSettingsUnlocked();
      if (current.desiredState === state) return current;
      const settings: HudSettings = {
        startWithWindows: current.startWithWindows,
        generation: current.generation + 1,
        desiredState: state
      };
      await writeJsonUnlocked(paths.settingsPath, settings);
      return settings;
    }),
    setStartWithWindows: (enabled) => locked(async () => {
      const settings: HudSettings = { ...(await readSettingsUnlocked()), startWithWindows: enabled };
      await writeJsonUnlocked(paths.settingsPath, settings);
      return settings;
    }),
    writeRuntime: (identity, generation) => locked(async () => {
      if (generation !== undefined) {
        const settings = await readSettingsUnlocked();
        if (settings.desiredState !== "on" || settings.generation !== generation) return false;
      }
      await writeJsonUnlocked(paths.runtimePath, runtimeIdentitySchema.parse({
        pid: identity.pid,
        version: identity.version,
        protocolVersion: identity.protocolVersion,
        instanceNonce: identity.instanceNonce,
        startedAt: identity.startedAt
      }));
      return true;
    }),
    readRuntime: () => locked(() => readJsonUnlocked(paths.runtimePath, runtimeIdentitySchema)),
    clearRuntime: (expected) => locked(async () => {
      if (expected !== undefined) {
        const current = await readJsonUnlocked(paths.runtimePath, runtimeIdentitySchema);
        if (
          current === null ||
          current.pid !== expected.pid ||
          current.instanceNonce !== expected.instanceNonce
        ) return;
      }
      await clearUnlocked(paths.runtimePath);
    }),
    readInstallManifest: () => locked(() => readJsonUnlocked(paths.installManifestPath, installManifestSchema)),
    runIfGeneration: (generation, desiredState, operation) => locked(async () => {
      const settings = await readSettingsUnlocked();
      if (settings.generation !== generation || settings.desiredState !== desiredState) return { accepted: false };
      return { accepted: true, value: await operation() };
    })
  };
}
