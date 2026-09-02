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
  type HudIdentity,
  type HudRequestOptions
} from "../mcp/report-client.js";
import { classifyLifecycle } from "./classify.js";
import type { ProcessLauncher, SpawnedHud } from "./process-launcher.js";
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
    operation: (options: HudRequestOptions & { generation: number; signal: AbortSignal }) => Promise<T>
  ): Promise<
    | { kind: "completed"; value: T }
    | Exclude<EnsureResult, { kind: "ready" }>
  >;
  diagnose(): Promise<DiagnosticReport>;
}

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

function errorCode(error: unknown): HudErrorCode | "OFFLINE" {
  if (!(error instanceof HudClientError)) return "INTERNAL_ERROR";
  return error.code === "GENERATION_REJECTED" ? "INTERNAL_ERROR" : error.code;
}

function lifecycleCode(code: HudErrorCode | "OFFLINE"): HudErrorCode {
  return code === "OFFLINE" ? "COMPANION_CRASHED" : code;
}

function identityMatches(health: HudHealth, owned: OwnedHud): boolean {
  return health.pid === owned.process.pid && health.instanceNonce === owned.instanceNonce;
}

interface OwnedHud {
  process: SpawnedHud;
  instanceNonce: string;
}

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
  const activeWriteControllers = new Set<AbortController>();

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

  function requestOptions(
    deadline: number | undefined,
    generation?: number,
    signal?: AbortSignal
  ): HudRequestOptions | undefined {
    if (deadline === undefined && generation === undefined && signal === undefined) return undefined;
    return {
      ...(deadline === undefined ? {} : { timeoutMs: Math.max(1, deadline - now()) }),
      ...(generation === undefined ? {} : { generation }),
      ...(signal === undefined ? {} : { signal })
    };
  }

  async function currentOnGeneration(generation: number): Promise<boolean> {
    const settings = await dependencies.store.readSettings();
    return settings.desiredState === "on" && settings.generation === generation;
  }

  async function observe(deadline?: number): Promise<HudLifecycleSnapshot> {
    const settings = await dependencies.store.readSettings();
    if (settings.desiredState === "off") {
      return { desiredState: "off", observedState: "stopped" };
    }
    const runtime = await dependencies.store.readRuntime();
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
      return code === "OFFLINE"
        ? { kind: "offline" }
        : { kind: "terminal", code: lifecycleCode(code) };
    }
  }

  async function retireStaleSpawn(
    spawned: SpawnedHud,
    health: HudHealth | undefined,
    deadline: number
  ): Promise<void> {
    const current = await dependencies.store.readSettings();
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
      await spawned.terminate().catch(() => undefined);
    }
  }

  async function staleStartupResult(generation: number): Promise<RunningResult> {
    const settings = await dependencies.store.readSettings();
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
      if (!(await currentOnGeneration(generation))) {
        await retireStaleSpawn(lateSpawn, undefined, now() + shutdownTimeoutMs);
      }
    }).catch(() => undefined);
    return SPAWN_DEADLINE;
  }

  async function start(generation: number, deadline: number): Promise<RunningResult> {
    const settings = await dependencies.store.readSettings();
    const manifest = await dependencies.store.readInstallManifest();
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
      isAbsolute(containment) ||
      !(await pathExists(executablePath))
    ) {
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

    if (!(await currentOnGeneration(generation))) {
      await retireStaleSpawn(spawned, undefined, deadline);
      return staleStartupResult(generation);
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
    if (!(await dependencies.store.writeRuntime(health, generation))) {
      await retireStaleSpawn(spawned, health, deadline);
      return staleStartupResult(generation);
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
      return staleStartupResult(generation);
    }
    if (!(await currentOnGeneration(generation))) return staleStartupResult(generation);
    const snapshot = await observe(deadline);
    if (snapshot.observedState === "running" || snapshot.observedState === "hidden") {
      if (!(await currentOnGeneration(generation))) return staleStartupResult(generation);
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
    reason: HudWriteReason
  ): Promise<EnsureResult> {
    const deadline = now() + startupTimeoutMs;
    let settings = await dependencies.store.readSettings();
    if (settings.desiredState === "off" && reason !== "tracking_start") {
      return { kind: "suppressed", code: "MANUALLY_DISABLED" };
    }
    if (settings.desiredState !== "on") settings = await dependencies.store.setDesiredState("on");
    return ensureRunningOnce(settings.generation, deadline);
  }

  async function staleWriteResult(
    generation: number
  ): Promise<Exclude<EnsureResult, { kind: "ready" }>> {
    const settings = await dependencies.store.readSettings();
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
      const settings = await dependencies.store.setDesiredState("on");
      const ensured = await ensureRunningOnce(settings.generation, deadline);
      if (ensured.kind !== "ready") return ensured.snapshot;
      if (!(await currentOnGeneration(ensured.generation))) return (await staleStartupResult(ensured.generation)).snapshot;
      await dependencies.client.show(requestOptions(deadline, ensured.generation));
      return observe();
    },

    async hide(): Promise<HudLifecycleSnapshot> {
      const snapshot = await observe();
      if (snapshot.observedState !== "running" && snapshot.observedState !== "hidden") return snapshot;
      await dependencies.client.hide();
      return observe();
    },

    async close(): Promise<HudLifecycleSnapshot> {
      const shutdownStartedAt = now();
      const shutdownDeadline = shutdownStartedAt + shutdownTimeoutMs;
      const offSettings = await dependencies.store.setDesiredState("off");
      for (const controller of activeWriteControllers) controller.abort();
      record({
        level: "info",
        event: "shutdown_requested",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION
      });
      let health: HudHealth;
      try {
        health = await dependencies.client.health(requestOptions(shutdownDeadline));
      } catch (error) {
        const code = errorCode(error);
        if (code === "OFFLINE") {
          await dependencies.store.clearRuntime();
          record({
            level: "info",
            event: "shutdown_complete",
            lifecycleState: "stopped",
            protocolVersion: PROTOCOL_VERSION,
            elapsedMs: Math.max(0, now() - shutdownStartedAt)
          });
          return { desiredState: "off", observedState: "stopped" };
        }
        const mapped = lifecycleCode(code);
        remember(mapped);
        return { desiredState: "off", observedState: "stopped", code: mapped };
      }
      try {
        await dependencies.client.shutdown(requestOptions(shutdownDeadline, offSettings.generation));
      } catch (error) {
        const code = lifecycleCode(errorCode(error));
        remember(code);
        return { desiredState: "off", observedState: "stopped", code };
      }
      let latestHealth: HudHealth | undefined;
      for (const delay of SHUTDOWN_DELAYS) {
        if (now() >= shutdownDeadline) break;
        await sleep(Math.min(delay, shutdownDeadline - now()));
        try {
          latestHealth = await dependencies.client.health(requestOptions(shutdownDeadline));
        } catch (error) {
          if (errorCode(error) === "OFFLINE") {
            await dependencies.store.clearRuntime();
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
          latestHealth = undefined;
        }
      }
      if (
        ownedHud !== undefined &&
        latestHealth !== undefined &&
        identityMatches(latestHealth, ownedHud)
      ) {
        await ownedHud.process.terminate();
        await dependencies.store.clearRuntime();
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
      remember("SHUTDOWN_TIMEOUT");
      record({
        level: "error",
        event: "shutdown_timeout",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION,
        elapsedMs: Math.max(0, now() - shutdownStartedAt)
      });
      return {
        desiredState: "off",
        observedState: "stopped",
        code: "SHUTDOWN_TIMEOUT"
      };
    },

    ensureForWrite,

    async executeWrite(reason, operation) {
      const controller = new AbortController();
      activeWriteControllers.add(controller);
      try {
        let ensured = await ensureForWrite(reason);
        if (ensured.kind !== "ready") return ensured;
        const writeGeneration = ensured.generation;
        if (controller.signal.aborted || !(await currentOnGeneration(writeGeneration))) {
          return staleWriteResult(writeGeneration);
        }
        try {
          return {
            kind: "completed",
            value: await operation({ generation: writeGeneration, signal: controller.signal })
          };
        } catch (error) {
          if (
            !(error instanceof HudClientError) ||
            (error.code !== "OFFLINE" && error.code !== "GENERATION_REJECTED")
          ) throw error;
          if (error.code === "GENERATION_REJECTED" || controller.signal.aborted) {
            return staleWriteResult(writeGeneration);
          }
          if (!(await currentOnGeneration(writeGeneration))) {
            return staleWriteResult(writeGeneration);
          }
          ensured = await ensureRunningOnce(writeGeneration);
          if (ensured.kind !== "ready") {
            return ensured.code === "MANUALLY_DISABLED"
              ? staleWriteResult(writeGeneration)
              : ensured;
          }
          if (controller.signal.aborted || !(await currentOnGeneration(writeGeneration))) {
            return staleWriteResult(writeGeneration);
          }
          return {
            kind: "completed",
            value: await operation({ generation: writeGeneration, signal: controller.signal })
          };
        }
      } finally {
        activeWriteControllers.delete(controller);
      }
    },

    async diagnose(): Promise<DiagnosticReport> {
      const snapshot = await observe();
      const runtime: RuntimeIdentity | null = await dependencies.store.readRuntime();
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
