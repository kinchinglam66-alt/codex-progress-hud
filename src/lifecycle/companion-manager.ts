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
  type HudIdentity
} from "../mcp/report-client.js";
import { classifyLifecycle } from "./classify.js";
import type { ProcessLauncher, SpawnedHud } from "./process-launcher.js";
import type {
  DiagnosticReport,
  EnsureResult,
  HudErrorCode,
  HudHealth,
  HudLifecycleSnapshot,
  LifecycleStateStore,
  RuntimeIdentity
} from "./types.js";

export interface CompanionManager {
  status(): Promise<HudLifecycleSnapshot>;
  open(): Promise<HudLifecycleSnapshot>;
  hide(): Promise<HudLifecycleSnapshot>;
  close(): Promise<HudLifecycleSnapshot>;
  ensureForWrite(
    reason: "tracking_start" | "progress_report" | "task_outcome"
  ): Promise<EnsureResult>;
  diagnose(): Promise<DiagnosticReport>;
}

interface CompanionControlClient {
  identity(): Promise<HudIdentity>;
  health(): Promise<HudHealth>;
  show(): Promise<void>;
  hide(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CompanionManagerDependencies {
  store: LifecycleStateStore;
  client: CompanionControlClient | CompanionHttpClient;
  launcher: ProcessLauncher;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  recoveryCooldownMs?: number;
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
  return error.code;
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
  type RunningResult = Exclude<EnsureResult, { kind: "suppressed" }>;
  let startupPromise: Promise<RunningResult> | undefined;
  let ownedHud: OwnedHud | undefined;
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  const recentErrors: DiagnosticReportInput["errors"] = [];

  async function record(entry: Omit<OperationalLogEntry, "at">): Promise<void> {
    try {
      await logger.write({ at: new Date(now()).toISOString(), ...entry });
    } catch {
      // Operational logging is best effort and must not alter lifecycle behavior.
    }
  }

  async function recordCompatibilityFailure(
    code: HudErrorCode,
    lifecycleState: "port_conflict" | "incompatible"
  ): Promise<void> {
    if (code !== "PORT_CONFLICT" && code !== "VERSION_MISMATCH") return;
    await record({
      level: "error",
      event: code === "PORT_CONFLICT" ? "port_conflict" : "protocol_mismatch",
      lifecycleState,
      protocolVersion: 1
    });
  }

  async function recordStartupFailure(
    code: HudErrorCode,
    lifecycleState: "stopped" | "port_conflict" | "incompatible"
  ): Promise<void> {
    if (lifecycleState === "port_conflict" || lifecycleState === "incompatible") {
      await recordCompatibilityFailure(code, lifecycleState);
    }
    await record({
      level: "error",
      event: "startup_failed",
      lifecycleState,
      protocolVersion: 1,
      elapsedMs: Math.max(0, now() - startStartedAt)
    });
  }

  function remember(code: HudErrorCode | "OFFLINE"): void {
    recentErrors.push({ code, occurredAt: new Date(now()).toISOString() });
    if (recentErrors.length > 10) recentErrors.shift();
  }

  async function observe(): Promise<HudLifecycleSnapshot> {
    const settings = await dependencies.store.readSettings();
    if (settings.desiredState === "off") {
      return { desiredState: "off", observedState: "stopped" };
    }
    const runtime = await dependencies.store.readRuntime();
    let identity: HudIdentity | undefined;
    try {
      identity = await dependencies.client.identity();
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
      const health = await dependencies.client.health();
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

  async function readinessProbe(): Promise<ReadinessResult> {
    try {
      await dependencies.client.identity();
      return { kind: "ready", health: await dependencies.client.health() };
    } catch (error) {
      const code = errorCode(error);
      return code === "OFFLINE"
        ? { kind: "offline" }
        : { kind: "terminal", code: lifecycleCode(code) };
    }
  }

  async function start(): Promise<RunningResult> {
    const settings = await dependencies.store.readSettings();
    const manifest = await dependencies.store.readInstallManifest();
    const unavailable = withDesiredState(settings.desiredState, {
      observedState: "stopped" as const,
      code: "COMPANION_NOT_INSTALLED" as const
    });
    if (manifest === null || !isAbsolute(manifest.executablePath) || !isAbsolute(manifest.installDirectory)) {
      remember("COMPANION_NOT_INSTALLED");
      await recordStartupFailure("COMPANION_NOT_INSTALLED", "stopped");
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
      await recordStartupFailure("COMPANION_NOT_INSTALLED", "stopped");
      return { kind: "error", code: "COMPANION_NOT_INSTALLED", snapshot: unavailable };
    }

    let spawned: SpawnedHud;
    try {
      spawned = await dependencies.launcher.spawnHud(executablePath);
    } catch {
      remember("INTERNAL_ERROR");
      await recordStartupFailure("INTERNAL_ERROR", "stopped");
      const snapshot = withDesiredState(settings.desiredState, {
        observedState: "stopped",
        code: "INTERNAL_ERROR"
      });
      return { kind: "error", code: "INTERNAL_ERROR", snapshot };
    }

    let readiness = await readinessProbe();
    for (const delay of STARTUP_DELAYS) {
      if (readiness.kind !== "offline") break;
      const elapsed = now() - startStartedAt;
      if (elapsed >= 8_000) break;
      await sleep(Math.min(delay, 8_000 - elapsed));
      readiness = await readinessProbe();
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
      await recordStartupFailure(readiness.code, observedState);
      return { kind: "error", code: readiness.code, snapshot };
    }
    if (readiness.kind === "offline") {
      remember("START_TIMEOUT");
      const snapshot = withDesiredState(settings.desiredState, {
        observedState: "stopped",
        code: "START_TIMEOUT"
      });
      await recordStartupFailure("START_TIMEOUT", "stopped");
      return { kind: "error", code: "START_TIMEOUT", snapshot };
    }
    const health = readiness.health;
    await dependencies.store.writeRuntime(health);
    ownedHud = { process: spawned, instanceNonce: health.instanceNonce };
    await record({
      level: "info",
      event: "startup_ready",
      lifecycleState: health.visibility === "visible" ? "running" : "hidden",
      protocolVersion: 1,
      elapsedMs: Math.max(0, now() - startStartedAt)
    });
    return {
      kind: "ready",
      snapshot: withDesiredState(settings.desiredState, {
        observedState: health.visibility === "visible" ? "running" : "hidden",
        health
      })
    };
  }

  let startStartedAt = 0;
  function sharedStart(): Promise<RunningResult> {
    if (startupPromise !== undefined) return startupPromise;
    startStartedAt = now();
    startupPromise = record({
      level: "info",
      event: "startup_requested",
      lifecycleState: "starting",
      protocolVersion: 1
    }).then(start).finally(() => {
      startupPromise = undefined;
    });
    return startupPromise;
  }

  async function ensureRunningOnce(): Promise<RunningResult> {
    if (startupPromise !== undefined) return startupPromise;
    const snapshot = await observe();
    if (snapshot.observedState === "running" || snapshot.observedState === "hidden") {
      return { kind: "ready", snapshot };
    }
    if (snapshot.code === "PORT_CONFLICT" || snapshot.code === "VERSION_MISMATCH" || snapshot.code === "AUTH_ERROR") {
      remember(snapshot.code);
      if (snapshot.code === "PORT_CONFLICT") {
        await recordCompatibilityFailure(snapshot.code, "port_conflict");
      } else if (snapshot.code === "VERSION_MISMATCH") {
        await recordCompatibilityFailure(snapshot.code, "incompatible");
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
      await record({
        level: "warn",
        event: "crash_recovery",
        lifecycleState: "crashed",
        protocolVersion: 1
      });
    }
    return sharedStart();
  }

  return {
    status: observe,

    async open(): Promise<HudLifecycleSnapshot> {
      await dependencies.store.setDesiredState("on");
      const ensured = await ensureRunningOnce();
      if (ensured.kind !== "ready") return ensured.snapshot;
      await dependencies.client.show();
      return observe();
    },

    async hide(): Promise<HudLifecycleSnapshot> {
      const snapshot = await observe();
      if (snapshot.observedState !== "running" && snapshot.observedState !== "hidden") return snapshot;
      await dependencies.client.hide();
      return observe();
    },

    async close(): Promise<HudLifecycleSnapshot> {
      await dependencies.store.setDesiredState("off");
      const shutdownStartedAt = now();
      await record({
        level: "info",
        event: "shutdown_requested",
        lifecycleState: "stopped",
        protocolVersion: 1
      });
      let health: HudHealth;
      try {
        health = await dependencies.client.health();
      } catch (error) {
        if (errorCode(error) === "OFFLINE") await dependencies.store.clearRuntime();
        if (errorCode(error) === "OFFLINE") {
          await record({
            level: "info",
            event: "shutdown_complete",
            lifecycleState: "stopped",
            protocolVersion: 1,
            elapsedMs: Math.max(0, now() - shutdownStartedAt)
          });
        }
        return { desiredState: "off", observedState: "stopped" };
      }
      try {
        await dependencies.client.shutdown();
      } catch (error) {
        const code = lifecycleCode(errorCode(error));
        remember(code);
        return { desiredState: "off", observedState: "stopped", code };
      }
      let latestHealth: HudHealth | undefined;
      for (const delay of SHUTDOWN_DELAYS) {
        await sleep(delay);
        try {
          latestHealth = await dependencies.client.health();
        } catch (error) {
          if (errorCode(error) === "OFFLINE") {
            await dependencies.store.clearRuntime();
            ownedHud = undefined;
            await record({
              level: "info",
              event: "shutdown_complete",
              lifecycleState: "stopped",
              protocolVersion: 1,
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
        await record({
          level: "info",
          event: "shutdown_complete",
          lifecycleState: "stopped",
          protocolVersion: 1,
          elapsedMs: Math.max(0, now() - shutdownStartedAt)
        });
        return { desiredState: "off", observedState: "stopped" };
      }
      remember("SHUTDOWN_TIMEOUT");
      await record({
        level: "error",
        event: "shutdown_timeout",
        lifecycleState: "stopped",
        protocolVersion: 1,
        elapsedMs: Math.max(0, now() - shutdownStartedAt)
      });
      return {
        desiredState: "off",
        observedState: "stopped",
        code: "SHUTDOWN_TIMEOUT"
      };
    },

    async ensureForWrite(reason): Promise<EnsureResult> {
      const settings = await dependencies.store.readSettings();
      if (settings.desiredState === "off" && reason !== "tracking_start") {
        return { kind: "suppressed", code: "MANUALLY_DISABLED" };
      }
      if (settings.desiredState !== "on") await dependencies.store.setDesiredState("on");
      return ensureRunningOnce();
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
          protocol: 1
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
