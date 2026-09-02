import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createOperationalLogger,
  type OperationalLogEntry,
  type OperationalLogger
} from "../diagnostics/logger.js";
import {
  writeDiagnosticReport,
  type DiagnosticReportInput
} from "../diagnostics/report.js";
import {
  HudClientError,
  type CompanionHttpClient,
  type HudClientErrorCode,
  type HudIdentity,
  type HudRequestOptions
} from "../mcp/report-client.js";
import { classifyLifecycle } from "./classify.js";
import type { ProcessLauncher, SpawnedHud } from "./process-launcher.js";
import { LifecycleStateTimeoutError } from "./state-lock.js";
import { PROTOCOL_VERSION } from "./types.js";
import type {
  DiagnosticReport,
  EnsureResult,
  HudErrorCode,
  HudHealth,
  HudLifecycleSnapshot,
  HudWriteReason,
  LifecycleStateStore,
  RuntimeIdentity
} from "./types.js";
import type { StateOperationOptions } from "./types.js";

export interface CompanionManager {
  status(): Promise<HudLifecycleSnapshot>;
  open(): Promise<HudLifecycleSnapshot>;
  hide(): Promise<HudLifecycleSnapshot>;
  close(): Promise<HudLifecycleSnapshot>;
  ensureForWrite(
    reason: HudWriteReason
  ): Promise<EnsureResult>;
  executeWrite<T>(
    reason: HudWriteReason,
    operation: (makeRequestOptions: MakeHudRequestOptions) => Promise<T>
  ): Promise<
    | { kind: "completed"; value: T }
    | Exclude<EnsureResult, { kind: "ready" }>
  >;
  diagnose(): Promise<DiagnosticReport>;
}

export type MakeHudRequestOptions = () => HudRequestOptions & {
  generation: number;
  signal: AbortSignal;
};

interface CompanionControlClient {
  identity(options?: HudRequestOptions): Promise<HudIdentity>;
  health(options?: HudRequestOptions): Promise<HudHealth>;
  show(options?: HudRequestOptions): Promise<void>;
  hide(options?: HudRequestOptions): Promise<void>;
  shutdown(options?: HudRequestOptions): Promise<void>;
}

export interface CompanionManagerDependencies {
  store: LifecycleStateStore;
  client: CompanionControlClient | CompanionHttpClient;
  launcher: ProcessLauncher;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  recoveryCooldownMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  logger?: OperationalLogger;
  diagnostics: {
    directory: string;
    pluginVersion: string;
    mcpVersion: string;
    host: string;
    port: number;
    installManifestPath: string;
    dataDirectoryPath: string;
  };
  pathExists?: (path: string) => Promise<boolean>;
  reportWriter?: (input: DiagnosticReportInput) => Promise<DiagnosticReport>;
}

const STARTUP_DELAYS = [100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000, 500] as const;
const SHUTDOWN_DELAYS = [100, 200, 400, 800, 1000, 1000, 1000, 500] as const;

function withDesiredState(
  desiredState: "on" | "off" | undefined,
  snapshot: Omit<HudLifecycleSnapshot, "desiredState">
): HudLifecycleSnapshot {
  return desiredState === undefined ? snapshot : { desiredState, ...snapshot };
}

type ManagerErrorCode = HudErrorCode | HudClientErrorCode;

function errorCode(error: unknown): ManagerErrorCode {
  if (!(error instanceof HudClientError)) return "INTERNAL_ERROR";
  return error.code === "GENERATION_REJECTED" || error.code === "REQUEST_CANCELLED"
    ? "INTERNAL_ERROR"
    : error.code;
}

function lifecycleCode(code: ManagerErrorCode): HudErrorCode {
  if (code === "OFFLINE") return "COMPANION_CRASHED";
  if (code === "REQUEST_TIMEOUT") return "START_TIMEOUT";
  if (code === "GENERATION_REJECTED" || code === "REQUEST_CANCELLED") return "INTERNAL_ERROR";
  return code;
}

function identityMatches(health: HudHealth, owned: OwnedHud): boolean {
  return health.pid === owned.process.pid && health.instanceNonce === owned.instanceNonce;
}

interface OwnedHud {
  process: SpawnedHud;
  instanceNonce: string;
}

type WriteAbortCause = "deadline" | "close";
type WriteAttempt<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "aborted"; cause: WriteAbortCause };

type ReadinessResult =
  | { kind: "ready"; health: HudHealth }
  | { kind: "offline" }
  | { kind: "terminal"; code: HudErrorCode };

export function createCompanionManager(
  dependencies: CompanionManagerDependencies
): CompanionManager {
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const pathExists = dependencies.pathExists ?? (async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });
  const reportWriter = dependencies.reportWriter ?? writeDiagnosticReport;
  const logger = dependencies.logger ?? createOperationalLogger({
    logDirectory: resolve(dependencies.diagnostics.directory, "..", "logs"),
    maxBytes: 1024 * 1024,
    maxFiles: 3
  });
  const recoveryCooldownMs = dependencies.recoveryCooldownMs ?? 30_000;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 8_000;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 5_000;
  type RunningResult = Exclude<EnsureResult, { kind: "suppressed" }>;
  let startupPromise: Promise<RunningResult> | undefined;
  let startupGeneration: number | undefined;
  let ownedHud: OwnedHud | undefined;
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  const recentErrors: DiagnosticReportInput["errors"] = [];
  const activeWriteCancellations = new Set<() => void>();

  function record(entry: Omit<OperationalLogEntry, "at">): void {
    try {
      void logger.write({ at: new Date(now()).toISOString(), ...entry }).catch(() => undefined);
    } catch {
      // Operational logging is best effort and must not alter lifecycle behavior.
    }
  }

  function recordCompatibilityFailure(
    code: HudErrorCode,
    lifecycleState: "port_conflict" | "incompatible"
  ): void {
    if (code !== "PORT_CONFLICT" && code !== "VERSION_MISMATCH") return;
    record({
      level: "error",
      event: code === "PORT_CONFLICT" ? "port_conflict" : "protocol_mismatch",
      lifecycleState,
      protocolVersion: PROTOCOL_VERSION
    });
  }

  function recordStartupFailure(
    code: HudErrorCode,
    lifecycleState: "stopped" | "port_conflict" | "incompatible"
  ): void {
    if (lifecycleState === "port_conflict" || lifecycleState === "incompatible") {
      recordCompatibilityFailure(code, lifecycleState);
    }
    record({
      level: "error",
      event: "startup_failed",
      lifecycleState,
      protocolVersion: PROTOCOL_VERSION,
      elapsedMs: Math.max(0, now() - startStartedAt)
    });
  }

  function remember(code: HudErrorCode | "OFFLINE"): void {
    recentErrors.push({ code, occurredAt: new Date(now()).toISOString() });
    if (recentErrors.length > 10) recentErrors.shift();
  }

  function shutdownTimedOut(shutdownStartedAt: number): HudLifecycleSnapshot {
    remember("SHUTDOWN_TIMEOUT");
    record({
      level: "error",
      event: "shutdown_timeout",
      lifecycleState: "stopped",
      protocolVersion: PROTOCOL_VERSION,
      elapsedMs: Math.max(0, now() - shutdownStartedAt)
    });
    return { desiredState: "off", observedState: "stopped", code: "SHUTDOWN_TIMEOUT" };
  }

  function requestOptions(
    deadline: number | undefined,
    generation?: number,
    signal?: AbortSignal
  ): HudRequestOptions | undefined {
    if (deadline === undefined && generation === undefined && signal === undefined) return undefined;
    return {
      ...(deadline === undefined ? {} : { timeoutMs: Math.max(0, deadline - now()) }),
      ...(generation === undefined ? {} : { generation }),
      ...(signal === undefined ? {} : { signal })
    };
  }

  function stateOptions(deadline: number): StateOperationOptions {
    return { timeoutMs: Math.max(0, deadline - now()) };
  }

  const OPERATION_DEADLINE = Symbol("operation-deadline");

  async function resultBeforeDeadline<T>(
    operation: Promise<T>,
    deadline: number
  ): Promise<T | typeof OPERATION_DEADLINE> {
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs === 0) {
      void operation.catch(() => undefined);
      return OPERATION_DEADLINE;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<typeof OPERATION_DEADLINE>((resolve_) => {
          timer = setTimeout(() => resolve_(OPERATION_DEADLINE), remainingMs);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function settlesBeforeDeadline(operation: Promise<void>, deadline: number): Promise<boolean> {
    return await resultBeforeDeadline(operation, deadline) !== OPERATION_DEADLINE;
  }

  async function clearRuntimeBefore(
    deadline: number,
    generation: number,
    expected: RuntimeIdentity | null
  ): Promise<boolean | undefined> {
    try {
      return await dependencies.store.clearRuntimeIfGeneration(
        generation,
        expected,
        stateOptions(deadline)
      );
    } catch (error) {
      if (error instanceof LifecycleStateTimeoutError) return undefined;
      throw error;
    }
  }

  async function currentOnGeneration(generation: number, deadline: number): Promise<boolean> {
    const settings = await dependencies.store.readSettings(stateOptions(deadline));
    return settings.desiredState === "on" && settings.generation === generation;
  }

  async function observe(deadline = now() + startupTimeoutMs): Promise<HudLifecycleSnapshot> {
    const settings = await dependencies.store.readSettings(stateOptions(deadline));
    if (settings.desiredState === "off") {
      return { desiredState: "off", observedState: "stopped" };
    }
    const runtime = await dependencies.store.readRuntime(stateOptions(deadline));
    let identity: HudIdentity | undefined;
    try {
      identity = await dependencies.client.identity(requestOptions(deadline));
    } catch (error) {
      const code = errorCode(error);
      if (code === "PORT_CONFLICT") {
        return withDesiredState(settings.desiredState, {
          observedState: "port_conflict",
          code: "PORT_CONFLICT"
        });
      }
      if (code === "VERSION_MISMATCH") {
        return withDesiredState(settings.desiredState, {
          observedState: "incompatible",
          code: "VERSION_MISMATCH"
        });
      }
      if (code === "AUTH_ERROR") {
        return withDesiredState(settings.desiredState, {
          observedState: runtime === null ? "stopped" : "crashed",
          code: "AUTH_ERROR"
        });
      }
      if (code === "REQUEST_TIMEOUT") {
        return withDesiredState(settings.desiredState, {
          observedState: runtime === null ? "stopped" : "crashed",
          code: "START_TIMEOUT"
        });
      }
      return withDesiredState(settings.desiredState, {
        observedState: classifyLifecycle({
          ...(settings.desiredState === undefined ? {} : { desiredState: settings.desiredState }),
          starting: false,
          hadHealthyRuntime: runtime !== null
        })
      });
    }
    try {
      const health = await dependencies.client.health(requestOptions(deadline));
      return withDesiredState(settings.desiredState, {
        observedState: health.visibility === "visible" ? "running" : "hidden",
        health
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "AUTH_ERROR") {
        return withDesiredState(settings.desiredState, {
          observedState: runtime === null ? "stopped" : "crashed",
          code: "AUTH_ERROR"
        });
      }
      if (code === "VERSION_MISMATCH") {
        return withDesiredState(settings.desiredState, {
          observedState: "incompatible",
          code: "VERSION_MISMATCH"
        });
      }
      if (code === "REQUEST_TIMEOUT") {
        return withDesiredState(settings.desiredState, {
          observedState: runtime === null ? "stopped" : "crashed",
          code: "START_TIMEOUT"
        });
      }
      return withDesiredState(settings.desiredState, {
        observedState: classifyLifecycle({
          ...(settings.desiredState === undefined ? {} : { desiredState: settings.desiredState }),
          starting: false,
          identity,
          hadHealthyRuntime: runtime !== null
        })
      });
    }
  }

  async function readinessProbe(deadline: number): Promise<ReadinessResult> {
    try {
      await dependencies.client.identity(requestOptions(deadline));
      return { kind: "ready", health: await dependencies.client.health(requestOptions(deadline)) };
    } catch (error) {
      const code = errorCode(error);
      return code === "OFFLINE" || code === "REQUEST_TIMEOUT"
        ? { kind: "offline" }
        : { kind: "terminal", code: lifecycleCode(code) };
    }
  }

  async function retireStaleSpawn(
    spawned: SpawnedHud,
    health: HudHealth | undefined,
    deadline: number
  ): Promise<boolean> {
    const current = await dependencies.store.readSettings(stateOptions(deadline));
    if (current.desiredState === "off") {
      await dependencies.client.shutdown(
        requestOptions(deadline, current.generation)
      ).catch(() => undefined);
    }
    let confirmed = health;
    if (confirmed === undefined) {
      confirmed = await dependencies.client.health(requestOptions(deadline)).catch(() => undefined);
    }
    if (
      confirmed !== undefined &&
      confirmed.pid === spawned.pid
    ) {
      return settlesBeforeDeadline(spawned.terminate().catch(() => undefined), deadline);
    }
    return true;
  }

  async function staleStartupResult(generation: number, deadline: number): Promise<RunningResult> {
    const settings = await dependencies.store.readSettings(stateOptions(deadline));
    const code = settings.desiredState === "off" ? "MANUALLY_DISABLED" : "INTERNAL_ERROR";
    return {
      kind: "error",
      code,
      snapshot: {
        ...(settings.desiredState === undefined ? {} : { desiredState: settings.desiredState }),
        observedState: "stopped",
        code
      }
    };
  }

  const SPAWN_DEADLINE = Symbol("spawn-deadline");

  async function spawnBeforeDeadline(
    executablePath: string,
    generation: number,
    deadline: number
  ): Promise<SpawnedHud | typeof SPAWN_DEADLINE> {
    const spawnPromise = dependencies.launcher.spawnHud(executablePath, { generation });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<typeof SPAWN_DEADLINE>((resolve_) => {
      timer = setTimeout(() => resolve_(SPAWN_DEADLINE), Math.max(1, deadline - now()));
    });
    const result = await Promise.race([spawnPromise, deadlinePromise]);
    if (timer !== undefined) clearTimeout(timer);
    if (result !== SPAWN_DEADLINE) return result;

    void spawnPromise.then(async (lateSpawn) => {
      const cleanupDeadline = now() + shutdownTimeoutMs;
      if (!(await currentOnGeneration(generation, cleanupDeadline))) {
        await retireStaleSpawn(lateSpawn, undefined, cleanupDeadline);
      }
    }).catch(() => undefined);
    return SPAWN_DEADLINE;
  }

  async function start(generation: number, deadline: number): Promise<RunningResult> {
    const settings = await dependencies.store.readSettings(stateOptions(deadline));
    const manifest = await dependencies.store.readInstallManifest(stateOptions(deadline));
    const unavailable = withDesiredState(settings.desiredState, {
      observedState: "stopped" as const,
      code: "COMPANION_NOT_INSTALLED" as const
    });
    if (manifest === null || !isAbsolute(manifest.executablePath) || !isAbsolute(manifest.installDirectory)) {
      remember("COMPANION_NOT_INSTALLED");
      recordStartupFailure("COMPANION_NOT_INSTALLED", "stopped");
      return { kind: "error", code: "COMPANION_NOT_INSTALLED", snapshot: unavailable };
    }
    const executablePath = resolve(manifest.executablePath);
    const installDirectory = resolve(manifest.installDirectory);
    const containment = relative(installDirectory, executablePath);
    if (
      containment.length === 0 ||
      containment.startsWith("..") ||
      isAbsolute(containment)
    ) {
      remember("COMPANION_NOT_INSTALLED");
      recordStartupFailure("COMPANION_NOT_INSTALLED", "stopped");
      return { kind: "error", code: "COMPANION_NOT_INSTALLED", snapshot: unavailable };
    }
    const executableExists = await resultBeforeDeadline(pathExists(executablePath), deadline);
    if (executableExists === OPERATION_DEADLINE) {
      remember("START_TIMEOUT");
      recordStartupFailure("START_TIMEOUT", "stopped");
      return {
        kind: "error",
        code: "START_TIMEOUT",
        snapshot: withDesiredState(settings.desiredState, {
          observedState: "stopped",
          code: "START_TIMEOUT"
        })
      };
    }
    if (!executableExists) {
      remember("COMPANION_NOT_INSTALLED");
      recordStartupFailure("COMPANION_NOT_INSTALLED", "stopped");
      return { kind: "error", code: "COMPANION_NOT_INSTALLED", snapshot: unavailable };
    }

    let spawned: SpawnedHud | typeof SPAWN_DEADLINE;
    try {
      spawned = await spawnBeforeDeadline(executablePath, generation, deadline);
    } catch {
      remember("INTERNAL_ERROR");
      recordStartupFailure("INTERNAL_ERROR", "stopped");
      const snapshot = withDesiredState(settings.desiredState, {
        observedState: "stopped",
        code: "INTERNAL_ERROR"
      });
      return { kind: "error", code: "INTERNAL_ERROR", snapshot };
    }
    if (spawned === SPAWN_DEADLINE) {
      remember("START_TIMEOUT");
      recordStartupFailure("START_TIMEOUT", "stopped");
      return {
        kind: "error",
        code: "START_TIMEOUT",
        snapshot: withDesiredState(settings.desiredState, {
          observedState: "stopped",
          code: "START_TIMEOUT"
        })
      };
    }

    if (!(await currentOnGeneration(generation, deadline))) {
      if (!(await retireStaleSpawn(spawned, undefined, deadline))) {
        remember("START_TIMEOUT");
        recordStartupFailure("START_TIMEOUT", "stopped");
        return {
          kind: "error",
          code: "START_TIMEOUT",
          snapshot: withDesiredState(settings.desiredState, {
            observedState: "stopped",
            code: "START_TIMEOUT"
          })
        };
      }
      return staleStartupResult(generation, deadline);
    }

    let readiness = await readinessProbe(deadline);
    for (const delay of STARTUP_DELAYS) {
      if (readiness.kind !== "offline") break;
      const elapsed = now() - startStartedAt;
      if (now() >= deadline) break;
      await sleep(Math.min(delay, deadline - now()));
      readiness = await readinessProbe(deadline);
    }
    if (readiness.kind === "terminal") {
      remember(readiness.code);
      const observedState =
        readiness.code === "PORT_CONFLICT"
          ? "port_conflict"
          : readiness.code === "VERSION_MISMATCH"
            ? "incompatible"
            : "stopped";
      const snapshot = withDesiredState(settings.desiredState, {
        observedState,
        code: readiness.code
      });
      recordStartupFailure(readiness.code, observedState);
      return { kind: "error", code: readiness.code, snapshot };
    }
    if (readiness.kind === "offline") {
      remember("START_TIMEOUT");
      const snapshot = withDesiredState(settings.desiredState, {
        observedState: "stopped",
        code: "START_TIMEOUT"
      });
      recordStartupFailure("START_TIMEOUT", "stopped");
      return { kind: "error", code: "START_TIMEOUT", snapshot };
    }
    const health = readiness.health;
    if (!(await dependencies.store.writeRuntime(health, generation, stateOptions(deadline)))) {
      if (!(await retireStaleSpawn(spawned, health, deadline))) {
        remember("START_TIMEOUT");
        recordStartupFailure("START_TIMEOUT", "stopped");
        return {
          kind: "error",
          code: "START_TIMEOUT",
          snapshot: withDesiredState(settings.desiredState, {
            observedState: "stopped",
            code: "START_TIMEOUT"
          })
        };
      }
      return staleStartupResult(generation, deadline);
    }
    ownedHud = { process: spawned, instanceNonce: health.instanceNonce };
    record({
      level: "info",
      event: "startup_ready",
      lifecycleState: health.visibility === "visible" ? "running" : "hidden",
      protocolVersion: PROTOCOL_VERSION,
      elapsedMs: Math.max(0, now() - startStartedAt)
    });
    return {
      kind: "ready",
      generation,
      snapshot: withDesiredState(settings.desiredState, {
        observedState: health.visibility === "visible" ? "running" : "hidden",
        health
      })
    };
  }

  let startStartedAt = 0;
  function sharedStart(generation: number, deadline = now() + startupTimeoutMs): Promise<RunningResult> {
    if (startupPromise !== undefined) return startupPromise;
    startStartedAt = now();
    record({
      level: "info",
      event: "startup_requested",
      lifecycleState: "starting",
      protocolVersion: PROTOCOL_VERSION
    });
    startupGeneration = generation;
    startupPromise = start(generation, deadline).finally(() => {
      startupPromise = undefined;
      startupGeneration = undefined;
    });
    return startupPromise;
  }

  async function ensureRunningOnce(
    generation: number,
    deadline = now() + startupTimeoutMs
  ): Promise<RunningResult> {
    if (startupPromise !== undefined) {
      if (startupGeneration === generation) return startupPromise;
      return staleStartupResult(generation, deadline);
    }
    if (!(await currentOnGeneration(generation, deadline))) return staleStartupResult(generation, deadline);
    const snapshot = await observe(deadline);
    if (snapshot.observedState === "running" || snapshot.observedState === "hidden") {
      if (!(await currentOnGeneration(generation, deadline))) return staleStartupResult(generation, deadline);
      return { kind: "ready", generation, snapshot };
    }
    if (snapshot.code === "PORT_CONFLICT" || snapshot.code === "VERSION_MISMATCH" || snapshot.code === "AUTH_ERROR") {
      remember(snapshot.code);
      if (snapshot.code === "PORT_CONFLICT") {
        recordCompatibilityFailure(snapshot.code, "port_conflict");
      } else if (snapshot.code === "VERSION_MISMATCH") {
        recordCompatibilityFailure(snapshot.code, "incompatible");
      }
      return { kind: "error", code: snapshot.code, snapshot };
    }
    if (startupPromise !== undefined) return startupPromise;
    if (snapshot.observedState === "crashed") {
      if (now() - lastRecoveryAt < recoveryCooldownMs) {
        const cooled = { ...snapshot, code: "COMPANION_CRASHED" as const };
        remember("COMPANION_CRASHED");
        return { kind: "error", code: "COMPANION_CRASHED", snapshot: cooled };
      }
      lastRecoveryAt = now();
      record({
        level: "warn",
        event: "crash_recovery",
        lifecycleState: "crashed",
        protocolVersion: PROTOCOL_VERSION
      });
    }
    return sharedStart(generation, deadline);
  }

  async function ensureForWrite(
    reason: HudWriteReason,
    deadline = now() + startupTimeoutMs
  ): Promise<EnsureResult> {
    try {
      let settings = await dependencies.store.readSettings(stateOptions(deadline));
      if (settings.desiredState === "off" && reason !== "tracking_start") {
        return { kind: "suppressed", code: "MANUALLY_DISABLED" };
      }
      if (settings.desiredState !== "on") {
        settings = await dependencies.store.setDesiredState("on", stateOptions(deadline));
      }
      return await ensureRunningOnce(settings.generation, deadline);
    } catch (error) {
      if (!(error instanceof LifecycleStateTimeoutError)) throw error;
      return {
        kind: "error",
        code: "START_TIMEOUT",
        snapshot: { observedState: "stopped", code: "START_TIMEOUT" }
      };
    }
  }

  async function staleWriteResult(
    generation: number,
    deadline: number
  ): Promise<Exclude<EnsureResult, { kind: "ready" }>> {
    let settings;
    try {
      settings = await dependencies.store.readSettings(stateOptions(deadline));
    } catch (error) {
      if (!(error instanceof LifecycleStateTimeoutError)) throw error;
      return {
        kind: "error",
        code: "START_TIMEOUT",
        snapshot: { observedState: "stopped", code: "START_TIMEOUT" }
      };
    }
    if (settings.desiredState === "off") {
      return { kind: "suppressed", code: "MANUALLY_DISABLED" };
    }
    return {
      kind: "error",
      code: "INTERNAL_ERROR",
      snapshot: {
        ...(settings.desiredState === undefined ? {} : { desiredState: settings.desiredState }),
        observedState: "stopped",
        code: "INTERNAL_ERROR"
      }
    };
  }

  return {
    status: observe,

    async open(): Promise<HudLifecycleSnapshot> {
      const deadline = now() + startupTimeoutMs;
      let desiredState: "on" | "off" | undefined;
      try {
        const settings = await dependencies.store.setDesiredState("on", stateOptions(deadline));
        desiredState = settings.desiredState;
        const ensured = await ensureRunningOnce(settings.generation, deadline);
        if (ensured.kind !== "ready") return ensured.snapshot;
        if (!(await currentOnGeneration(ensured.generation, deadline))) {
          return (await staleStartupResult(ensured.generation, deadline)).snapshot;
        }
        await dependencies.client.show(requestOptions(deadline, ensured.generation));
        return await observe(deadline);
      } catch (error) {
        if (
          !(error instanceof LifecycleStateTimeoutError) &&
          (!(error instanceof HudClientError) || error.code !== "REQUEST_TIMEOUT")
        ) throw error;
        return withDesiredState(desiredState, { observedState: "stopped", code: "START_TIMEOUT" });
      }
    },

    async hide(): Promise<HudLifecycleSnapshot> {
      const deadline = now() + startupTimeoutMs;
      const snapshot = await observe(deadline);
      if (snapshot.observedState !== "running" && snapshot.observedState !== "hidden") return snapshot;
      const settings = await dependencies.store.readSettings(stateOptions(deadline));
      if (settings.desiredState !== "on") return observe(deadline);
      try {
        await dependencies.client.hide(requestOptions(deadline, settings.generation));
      } catch (error) {
        if (!(error instanceof HudClientError) || error.code !== "GENERATION_REJECTED") throw error;
        return observe(deadline);
      }
      return observe(deadline);
    },

    async close(): Promise<HudLifecycleSnapshot> {
      const shutdownStartedAt = now();
      const shutdownDeadline = shutdownStartedAt + shutdownTimeoutMs;
      let offSettings;
      try {
        offSettings = await dependencies.store.setDesiredState("off", stateOptions(shutdownDeadline));
      } catch (error) {
        if (!(error instanceof LifecycleStateTimeoutError)) throw error;
        return shutdownTimedOut(shutdownStartedAt);
      }
      let closingRuntime: RuntimeIdentity | null;
      try {
        closingRuntime = await dependencies.store.readRuntime(stateOptions(shutdownDeadline));
      } catch (error) {
        if (!(error instanceof LifecycleStateTimeoutError)) throw error;
        return shutdownTimedOut(shutdownStartedAt);
      }
      for (const cancel of activeWriteCancellations) cancel();
      record({
        level: "info",
        event: "shutdown_requested",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION
      });
      try {
        await dependencies.client.health(requestOptions(shutdownDeadline));
      } catch (error) {
        const code = errorCode(error);
        if (code === "OFFLINE") {
          const cleared = await clearRuntimeBefore(
            shutdownDeadline,
            offSettings.generation,
            closingRuntime
          );
          if (cleared === undefined) return shutdownTimedOut(shutdownStartedAt);
          if (!cleared) return observe(shutdownDeadline);
          record({
            level: "info",
            event: "shutdown_complete",
            lifecycleState: "stopped",
            protocolVersion: PROTOCOL_VERSION,
            elapsedMs: Math.max(0, now() - shutdownStartedAt)
          });
          return { desiredState: "off", observedState: "stopped" };
        }
        if (code === "REQUEST_TIMEOUT") return shutdownTimedOut(shutdownStartedAt);
        const mapped = lifecycleCode(code);
        remember(mapped);
        return { desiredState: "off", observedState: "stopped", code: mapped };
      }
      try {
        await dependencies.client.shutdown(requestOptions(shutdownDeadline, offSettings.generation));
      } catch (error) {
        const clientCode = errorCode(error);
        if (clientCode === "REQUEST_TIMEOUT") return shutdownTimedOut(shutdownStartedAt);
        const code = lifecycleCode(clientCode);
        remember(code);
        return { desiredState: "off", observedState: "stopped", code };
      }
      let latestHealth: HudHealth | undefined;
      for (const delay of SHUTDOWN_DELAYS) {
        if (now() >= shutdownDeadline) break;
        if (
          ownedHud !== undefined &&
          latestHealth !== undefined &&
          identityMatches(latestHealth, ownedHud) &&
          delay >= shutdownDeadline - now()
        ) break;
        await sleep(Math.min(delay, shutdownDeadline - now()));
        try {
          latestHealth = await dependencies.client.health(requestOptions(shutdownDeadline));
        } catch (error) {
          const code = errorCode(error);
          if (code === "OFFLINE") {
            const cleared = await clearRuntimeBefore(
              shutdownDeadline,
              offSettings.generation,
              closingRuntime
            );
            if (cleared === undefined) return shutdownTimedOut(shutdownStartedAt);
            if (!cleared) return observe(shutdownDeadline);
            ownedHud = undefined;
            record({
              level: "info",
              event: "shutdown_complete",
              lifecycleState: "stopped",
              protocolVersion: PROTOCOL_VERSION,
              elapsedMs: Math.max(0, now() - shutdownStartedAt)
            });
            return { desiredState: "off", observedState: "stopped" };
          }
          if (code === "REQUEST_TIMEOUT") break;
          latestHealth = undefined;
        }
      }
      if (
        ownedHud !== undefined &&
        latestHealth !== undefined &&
        identityMatches(latestHealth, ownedHud)
      ) {
        if (!(await settlesBeforeDeadline(ownedHud.process.terminate(), shutdownDeadline))) {
          return shutdownTimedOut(shutdownStartedAt);
        }
        const cleared = await clearRuntimeBefore(
          shutdownDeadline,
          offSettings.generation,
          closingRuntime
        );
        if (cleared === undefined) return shutdownTimedOut(shutdownStartedAt);
        if (!cleared) return observe(shutdownDeadline);
        ownedHud = undefined;
        record({
          level: "info",
          event: "shutdown_complete",
          lifecycleState: "stopped",
          protocolVersion: PROTOCOL_VERSION,
          elapsedMs: Math.max(0, now() - shutdownStartedAt)
        });
        return { desiredState: "off", observedState: "stopped" };
      }
      return shutdownTimedOut(shutdownStartedAt);
    },

    ensureForWrite,

    async executeWrite(reason, operation) {
      const deadline = now() + startupTimeoutMs;
      const controller = new AbortController();
      let abortCause: WriteAbortCause | undefined;
      let notifyAbort!: (cause: WriteAbortCause) => void;
      const aborted = new Promise<WriteAbortCause>((resolve_) => { notifyAbort = resolve_; });
      const claimAbortCause = (cause: WriteAbortCause) => {
        if (abortCause !== undefined) return;
        abortCause = cause;
        controller.abort();
        notifyAbort(cause);
      };
      const cancelForClose = () => claimAbortCause("close");
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleDeadline = () => {
        const remainingMs = Math.max(0, deadline - now());
        if (remainingMs === 0) {
          claimAbortCause("deadline");
          return;
        }
        deadlineTimer = setTimeout(() => {
          if (now() >= deadline) claimAbortCause("deadline");
          else scheduleDeadline();
        }, remainingMs);
        deadlineTimer.unref();
      };
      scheduleDeadline();
      activeWriteCancellations.add(cancelForClose);
      try {
        let ensured = await ensureForWrite(reason, deadline);
        if (ensured.kind !== "ready") return ensured;
        const writeGeneration = ensured.generation;
        const writeSnapshot = ensured.snapshot;
        const manuallyDisabled = (): Exclude<EnsureResult, { kind: "ready" }> => ({
          kind: "suppressed",
          code: "MANUALLY_DISABLED"
        });
        const timedOut = (): Exclude<EnsureResult, { kind: "ready" }> => ({
          kind: "error",
          code: "START_TIMEOUT",
          snapshot: { ...writeSnapshot, code: "START_TIMEOUT" }
        });
        const abortedResult = (cause: WriteAbortCause) =>
          cause === "close" ? manuallyDisabled() : timedOut();
        if (abortCause !== undefined) return abortedResult(abortCause);
        if (!(await currentOnGeneration(writeGeneration, deadline))) {
          return staleWriteResult(writeGeneration, deadline);
        }
        if (abortCause !== undefined) return abortedResult(abortCause);
        const makeRequestOptions: MakeHudRequestOptions = () => ({
          generation: writeGeneration,
          signal: controller.signal,
          timeoutMs: Math.max(0, deadline - now())
        });
        const invokeOperation = async <Value>(
          run: () => Promise<Value>
        ): Promise<WriteAttempt<Value>> => {
          if (abortCause !== undefined) return { kind: "aborted" as const, cause: abortCause };
          const pending = Promise.resolve().then(run);
          const result = await Promise.race<WriteAttempt<Value>>([
            pending.then(
              (value) => ({ kind: "completed" as const, value }),
              (error: unknown) => ({ kind: "failed" as const, error })
            ),
            aborted.then((cause) => ({ kind: "aborted" as const, cause }))
          ]);
          if (result.kind === "completed" && now() >= deadline) {
            claimAbortCause("deadline");
            return { kind: "aborted", cause: "deadline" };
          }
          return result;
        };
        const classifyStaleAttempt = (error: unknown) => {
          if (!(error instanceof HudClientError)) return undefined;
          if (error.code === "REQUEST_TIMEOUT") return Promise.resolve(timedOut());
          if (error.code === "REQUEST_CANCELLED" && abortCause !== undefined) {
            return Promise.resolve(abortedResult(abortCause));
          }
          if (error.code === "GENERATION_REJECTED") {
            return staleWriteResult(writeGeneration, deadline);
          }
          return undefined;
        };
        const attempt = await invokeOperation(() => operation(makeRequestOptions));
        if (attempt.kind === "completed") return attempt;
        if (attempt.kind === "aborted") return abortedResult(attempt.cause);
        const error = attempt.error;
        const staleAttempt = classifyStaleAttempt(error);
        if (staleAttempt !== undefined) return staleAttempt;
        if (!(error instanceof HudClientError)) throw error;
        if (error.code !== "OFFLINE") throw error;
        if (abortCause !== undefined) return abortedResult(abortCause);
        if (!(await currentOnGeneration(writeGeneration, deadline))) {
          return staleWriteResult(writeGeneration, deadline);
        }
        ensured = await ensureRunningOnce(writeGeneration, deadline);
        if (ensured.kind !== "ready") {
          return ensured.code === "MANUALLY_DISABLED"
            ? staleWriteResult(writeGeneration, deadline)
            : ensured;
        }
        if (abortCause !== undefined) return abortedResult(abortCause);
        if (!(await currentOnGeneration(writeGeneration, deadline))) {
          return staleWriteResult(writeGeneration, deadline);
        }
        const retry = await invokeOperation(() => operation(makeRequestOptions));
        if (retry.kind === "completed") return retry;
        if (retry.kind === "aborted") return abortedResult(retry.cause);
        const staleRetry = classifyStaleAttempt(retry.error);
        if (staleRetry !== undefined) return staleRetry;
        throw retry.error;
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        activeWriteCancellations.delete(cancelForClose);
      }
    },

    async diagnose(): Promise<DiagnosticReport> {
      const deadline = now() + startupTimeoutMs;
      const snapshot = await observe(deadline);
      const runtime: RuntimeIdentity | null = await dependencies.store.readRuntime(stateOptions(deadline));
      return reportWriter({
        directory: dependencies.diagnostics.directory,
        generatedAt: new Date(now()).toISOString(),
        versions: {
          plugin: dependencies.diagnostics.pluginVersion,
          mcp: dependencies.diagnostics.mcpVersion,
          ...(snapshot.health === undefined ? {} : { companion: snapshot.health.version }),
          protocol: PROTOCOL_VERSION
        },
        lifecycle: {
          ...(snapshot.desiredState === undefined ? {} : { desiredState: snapshot.desiredState }),
          observedState: snapshot.observedState
        },
        paths: {
          installManifestExists: await pathExists(dependencies.diagnostics.installManifestPath),
          dataDirectoryExists: await pathExists(dependencies.diagnostics.dataDirectoryPath)
        },
        endpoint: {
          host: dependencies.diagnostics.host,
          port: dependencies.diagnostics.port
        },
        ...(runtime === null
          ? {}
          : { runtimeAgeMs: Math.max(0, now() - Date.parse(runtime.startedAt)) }),
        errors: [...recentErrors]
      });
    }
  };
}
