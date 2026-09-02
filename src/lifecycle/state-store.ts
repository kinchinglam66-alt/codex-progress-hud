import { randomUUID } from "node:crypto";
import { rename as nodeRename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  identityOf,
  LifecycleStateTimeoutError,
  nodeLifecycleStateLockFileSystem,
  retryWindowsSharing,
  unlinkIfIdentical,
  withLifecycleStateLock,
  type LifecycleStateLockFileSystem
} from "./state-lock.js";
import { PROTOCOL_VERSION } from "./types.js";
import type {
  DesiredHudState,
  HudSettings,
  InstallManifest,
  LifecycleStateStore,
  RuntimeIdentity,
  StateOperationOptions
} from "./types.js";

export interface LifecycleStatePaths { settingsPath: string; runtimePath: string; installManifestPath: string; }

export interface LifecycleStateFileSystem extends LifecycleStateLockFileSystem {
  rename: typeof nodeRename;
}

export interface LifecycleStateStoreDependencies {
  fileSystem?: LifecycleStateFileSystem;
}

const nodeLifecycleStateFileSystem: LifecycleStateFileSystem = {
  ...nodeLifecycleStateLockFileSystem,
  rename: nodeRename
};

const boundedText = z.string().trim().min(1).max(256);
const absolutePath = z.string().trim().min(1).max(4096).refine(isAbsolute);
const canonicalTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
  });
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

async function locallyOrdered<T>(
  lockPath: string,
  operation: (
    remainingMs: number | undefined,
    signal: AbortSignal,
    enterMutation: () => void
  ) => Promise<T>,
  options: StateOperationOptions = {}
): Promise<T> {
  const deadline = options.timeoutMs === undefined
    ? undefined
    : Date.now() + Math.max(0, options.timeoutMs);
  const previous = localQueues.get(lockPath) ?? Promise.resolve();
  const controller = new AbortController();
  let operationEntered = false;
  const current = previous.catch(() => undefined).then(() => {
    const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    if (remainingMs === 0 || controller.signal.aborted) throw new LifecycleStateTimeoutError();
    return operation(remainingMs, controller.signal, () => { operationEntered = true; });
  });
  localQueues.set(lockPath, current);
  const removeCurrent = () => {
    if (localQueues.get(lockPath) === current) localQueues.delete(lockPath);
  };
  void current.then(removeCurrent, removeCurrent);
  if (deadline === undefined) return await current;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBeforeEntry!: (error: LifecycleStateTimeoutError) => void;
  const beforeEntryTimeout = new Promise<never>((_resolve, reject) => {
    rejectBeforeEntry = reject;
  });
  try {
    timer = setTimeout(() => {
      controller.abort();
      // Setup and reads may finish in the background, but they cannot enter a
      // product mutation after this caller-visible deadline.
      if (!operationEntered) rejectBeforeEntry(new LifecycleStateTimeoutError());
    }, Math.max(0, deadline - Date.now()));
    return await Promise.race([current, beforeEntryTimeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readJsonUnlocked<T>(
  path: string,
  schema: z.ZodType<T>,
  fileSystem: LifecycleStateFileSystem
): Promise<T | null> {
  let content: string;
  try { content = await retryWindowsSharing(() => fileSystem.readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try { return schema.parse(JSON.parse(content)); }
  catch { throw new Error(`Invalid lifecycle JSON file: ${path}`); }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LifecycleStateTimeoutError();
}

async function writeJsonUnlocked(
  path: string,
  value: unknown,
  signal: AbortSignal,
  enterMutation: () => void,
  fileSystem: LifecycleStateFileSystem
): Promise<void> {
  throwIfAborted(signal);
  await fileSystem.mkdir(dirname(path), { recursive: true });
  throwIfAborted(signal);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryIdentity: Awaited<ReturnType<typeof identityOf>> = null;
  try {
    await fileSystem.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    throwIfAborted(signal);
    temporaryIdentity = await identityOf(temporary, fileSystem);
    throwIfAborted(signal);
    enterMutation();
    await retryWindowsSharing(() => {
      throwIfAborted(signal);
      return fileSystem.rename(temporary, path);
    });
  } finally {
    if (temporaryIdentity !== null) {
      await unlinkIfIdentical(temporary, temporaryIdentity, undefined, fileSystem).catch(() => undefined);
    }
  }
}

async function clearUnlocked(
  path: string,
  signal: AbortSignal,
  enterMutation: () => void,
  fileSystem: LifecycleStateFileSystem
): Promise<void> {
  throwIfAborted(signal);
  const identity = await identityOf(path, fileSystem);
  throwIfAborted(signal);
  if (identity !== null) {
    enterMutation();
    await unlinkIfIdentical(path, identity, signal, fileSystem);
  }
}

function normalizedSettings(settings: z.infer<typeof settingsSchema> | null): HudSettings {
  return {
    startWithWindows: settings?.startWithWindows ?? false,
    generation: settings?.generation ?? 0,
    ...(settings?.desiredState === undefined ? {} : { desiredState: settings.desiredState })
  };
}

export function createLifecycleStateStore(
  paths: LifecycleStatePaths,
  dependencies: LifecycleStateStoreDependencies = {}
): LifecycleStateStore {
  const lockPath = join(dirname(paths.settingsPath), ".lifecycle-state.lock");
  const fileSystem = dependencies.fileSystem ?? nodeLifecycleStateFileSystem;
  const locked = <T>(
    options: StateOperationOptions | undefined,
    operation: (signal: AbortSignal, enterMutation: () => void) => Promise<T>
  ) => locallyOrdered(
    lockPath,
    (remainingMs, signal, enterMutation) => withLifecycleStateLock(
      lockPath,
      () => operation(signal, enterMutation),
      remainingMs,
      signal,
      fileSystem
    ),
    options
  );
  const readSettingsUnlocked = async () => normalizedSettings(
    await readJsonUnlocked(paths.settingsPath, settingsSchema, fileSystem)
  );
  return {
    readSettings: (options) => locked(options, async () => readSettingsUnlocked()),
    setDesiredState: (state, options) => locked(options, async (signal, enterMutation) => {
      const current = await readSettingsUnlocked();
      if (current.desiredState === state) return current;
      const settings: HudSettings = {
        startWithWindows: current.startWithWindows,
        generation: current.generation + 1,
        desiredState: state
      };
      await writeJsonUnlocked(paths.settingsPath, settings, signal, enterMutation, fileSystem);
      return settings;
    }),
    setStartWithWindows: (enabled, options) => locked(options, async (signal, enterMutation) => {
      const settings: HudSettings = { ...(await readSettingsUnlocked()), startWithWindows: enabled };
      await writeJsonUnlocked(paths.settingsPath, settings, signal, enterMutation, fileSystem);
      return settings;
    }),
    writeRuntime: (identity, generation, options) => locked(options, async (signal, enterMutation) => {
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
      }), signal, enterMutation, fileSystem);
      return true;
    }),
    readRuntime: (options) => locked(
      options,
      async () => readJsonUnlocked(paths.runtimePath, runtimeIdentitySchema, fileSystem)
    ),
    clearRuntime: (expected, options) => locked(options, async (signal, enterMutation) => {
      if (expected !== undefined) {
        const current = await readJsonUnlocked(paths.runtimePath, runtimeIdentitySchema, fileSystem);
        if (
          current === null ||
          current.pid !== expected.pid ||
          current.instanceNonce !== expected.instanceNonce
        ) return;
      }
      await clearUnlocked(paths.runtimePath, signal, enterMutation, fileSystem);
    }),
    readInstallManifest: (options) => locked(
      options,
      async () => readJsonUnlocked(paths.installManifestPath, installManifestSchema, fileSystem)
    ),
    runIfGeneration: (generation, desiredState, operation, options) => locked(
      options,
      async (signal, enterMutation) => {
      const settings = await readSettingsUnlocked();
      if (settings.generation !== generation || settings.desiredState !== desiredState) return { accepted: false };
      throwIfAborted(signal);
      enterMutation();
      const value = await operation(signal);
      throwIfAborted(signal);
      return { accepted: true, value };
      }
    )
  };
}
