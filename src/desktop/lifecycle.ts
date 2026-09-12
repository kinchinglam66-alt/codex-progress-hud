import { randomUUID as nodeRandomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectEntryIntent, type DesktopLaunchReason } from "../main.js";
import { createOperationalLogger, type OperationalLogEntry, type OperationalLogger } from "../diagnostics/logger.js";
import { writeDiagnosticReport, type DiagnosticReportInput } from "../diagnostics/report.js";
import { readWindowDiagnostics } from "../diagnostics/window-state.js";
import type { TaskStatus } from "../core/types.js";
import { createLifecycleStateStore } from "../lifecycle/state-store.js";
import {
  PROTOCOL_VERSION,
  type HudErrorCode,
  type HudHealth,
  type LifecycleStateStore,
  type ObservedHudState,
  type RuntimeIdentity
} from "../lifecycle/types.js";
import { createProgressServer, type ProgressServerOptions } from "../server/http-server.js";
import {
  defaultCodexSessionsRoot,
  defaultInstallManifestPath,
  defaultDataDirectory,
  defaultDiagnosticsDirectory,
  defaultLogDirectory,
  defaultRuntimePath,
  defaultSettingsPath,
  defaultTokenPath
} from "../server/paths.js";
import {
  createTrayController,
  type TrayController,
  type TrayControllerOptions,
  type TrayLike,
  type TrayMenuItem
} from "./tray-controller.js";
import {
  WindowController,
  type BrowserWindowLike,
  type BrowserWindowOptionsLike
} from "./window-controller.js";
import { createTaskMutationController } from "../ui/task-mutations.js";
import { createConversationNameService } from '../server/conversation-name-service.js';
import {loadDesktopObserverPilot} from './observer-pilot.js';
import {createObserverSettingsController} from './observer-settings.js';
import {createSafeStorageConsentProtection} from './consent-protection.js';

export function scheduleAfterReady(
  ready: Promise<void>,
  start: () => void | Promise<unknown>,
  onError: (error: unknown) => void = console.error
): void {
  void ready.then(start).catch(onError);
}

export interface DesktopAppLike {
  setPath(name: "userData", path: string): void;
  disableHardwareAcceleration(): void;
  requestSingleInstanceLock(): boolean;
  releaseSingleInstanceLock(): void;
  whenReady(): Promise<void>;
  on(event: string, callback: (...args: any[]) => unknown): unknown;
  quit(): void;
  isReady(): boolean;
  getVersion(): string;
}

export interface DesktopWindowController {
  diagnostics?(): import("../diagnostics/window-state.js").WindowDiagnostics;
  updateRows?(rows: number, revision: number): void;
  create(options: { url: string; token: string }): Promise<void>;
  show(): void;
  hide(): void;
  selectTask(taskId: string | null, options?: { hiddenForTask?: boolean }): void;
  onTaskActivity(taskId: string, options?: { isNewTask?: boolean; terminal?: boolean; hiddenForTask?: boolean }): void;
  visibility(): "visible" | "hidden";
  dispose(): void;
}

export interface DesktopProgressServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number; url: string };
  store?: {
    snapshot(): {
      revision: number;
      rows?: readonly unknown[];
      selectedTaskId: string | null;
      tasks: Array<{ id: string; title: string; status: string; lastActivityAt: number; hiddenForTask: boolean; selected?: boolean }>;
      selected?: { task: { status: string; trackingOrigin?: string; lastRuntimeEvidenceAt?: number } } | null;
      compatibility?: { incompatibleClientSeen: boolean };
    };
    select(taskId: string, mode: "pinned" | "follow_activity"): unknown;
    on(event: "changed", listener: (snapshot: unknown) => void): unknown;
    off?(event: "changed", listener: (snapshot: unknown) => void): unknown;
  };
  leaseStore?: { active(): readonly unknown[] };
  hookActivity?: () => { activitySeen: boolean; lastEventAt?: number };
}

export interface DesktopTrayImage {
  isEmpty(): boolean;
}

export interface DesktopDependencies {
  observerWorkers?: ProgressServerOptions['observerWorkers'];
  observerWorkerSource?: ProgressServerOptions['observerWorkerSource'];
  observerSchedulerRecovery?: ProgressServerOptions['observerSchedulerRecovery'];
  onObserverObservation?: ProgressServerOptions['onObserverObservation'];
  observerSetup?: {
    start(signal: AbortSignal): Promise<unknown>;
    disable(): void;
    revokeConsent?(): Promise<void>;
    close(): Promise<void>;
  };
  settingsController?: {
    open(): Promise<void>;
    dispose(): Promise<void>;
  };
  app: DesktopAppLike;
  createWindowController(options: { quitting(): boolean; onHideSelectedTask?(taskId: string): void | Promise<void> }): DesktopWindowController;
  createTrayImage(): DesktopTrayImage;
  createTray(image: DesktopTrayImage): TrayLike;
  buildMenu(template: TrayMenuItem[]): unknown;
  createTrayController(options: TrayControllerOptions): TrayController;
  createProgressServer(options: ProgressServerOptions): DesktopProgressServer;
  stateStore: LifecycleStateStore;
  readToken(path: string): Promise<string>;
  randomUUID(): string;
  now(): Date;
  pid: number;
  tokenPath: string;
  uiDirectory: string;
  port: number;
  diagnose(snapshot: DesktopDiagnosticSnapshot): void | Promise<void>;
  operationalLogger?: OperationalLogger;
  reportError(error: unknown, context: string): void;
  cleanupTimeoutMs: number;
  withTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T>;
  leaseGraceMs?: number;
}

export interface DesktopDiagnosticSnapshot {
  windowDiagnostics?: DiagnosticReportInput["windowDiagnostics"];
  observedState: ObservedHudState;
  runtimeAgeMs: number;
  errors: Array<{ code: HudErrorCode | "OFFLINE"; occurredAt: string }>;
  hooks: NonNullable<DiagnosticReportInput["hooks"]>;
  lease: NonNullable<DiagnosticReportInput["lease"]>;
  compatibility: NonNullable<DiagnosticReportInput["compatibility"]>;
  tracking: NonNullable<DiagnosticReportInput["tracking"]>;
  operationalEvents: NonNullable<DiagnosticReportInput["operationalEvents"]>;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const TRAY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class StartupCancelledError extends Error {}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function defaultDesktopDependencies(): Promise<DesktopDependencies> {
  const electron = await import("electron");
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const tokenPath = defaultTokenPath();
  const configuredPort = Number.parseInt(process.env.CODEX_PROGRESS_HUD_PORT ?? "17837", 10);
  const dataDirectory = defaultDataDirectory();
  const installManifestPath = defaultInstallManifestPath();
  const stateStore = createLifecycleStateStore({
    settingsPath: defaultSettingsPath(),
    runtimePath: defaultRuntimePath(),
    installManifestPath
  });
  const pathExists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  const operationalLogger = createOperationalLogger({
    logDirectory: defaultLogDirectory(),
    maxBytes: 1024 * 1024,
    maxFiles: 3
  });
  const observer = await loadDesktopObserverPilot({dataDirectory,resourcesDirectory:process.resourcesPath,
    dialog:electron.dialog,environment:process.env,consentProtection:createSafeStorageConsentProtection(electron.safeStorage)}).catch(()=>{
      console.warn('OBSERVER_PILOT_SETUP_UNAVAILABLE');return null;
    });
  const settingsController = createObserverSettingsController({
    createWindow: windowOptions => new electron.BrowserWindow(windowOptions as Electron.BrowserWindowConstructorOptions) as unknown as import('./observer-settings.js').SettingsBrowserWindowLike,
    ipcMain: electron.ipcMain,
    dialog: electron.dialog,
    uiPath: resolve(currentDirectory, '../ui/settings.html'),
    preloadPath: resolve(currentDirectory, '../ui/settings-preload.cjs'),
    quitting: () => false,
    readStatus: () => observer?.recovery.status() ?? {state: 'unconfigured' as const, revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false},
    preflight: () => observer?.recovery.preflight() ?? Promise.resolve({state: 'unconfigured' as const, revision: 0, knownTokens: 0, unknown: 0, recoveryAllowed: false, allowed: false}),
    binding: () => observer?.recovery.binding(),
    confirm: revision => observer?.recovery.confirm(revision) ?? Promise.reject(new Error('SETTINGS_UNAVAILABLE')),
    revokeConsent: () => observer?.revokeConsent() ?? Promise.reject(new Error('SETTINGS_UNAVAILABLE')),
    ...(observer?.providerSettings === undefined ? {} : {provider: observer.providerSettings}),
  });
  return {
    ...(observer?{observerSetup:observer,observerWorkers:observer.workers,observerWorkerSource:observer.workerSource,observerSchedulerRecovery:observer.schedulerRecovery,onObserverObservation:observer.onObservation}:{}),
    ...(settingsController ? {settingsController} : {}),
    app: electron.app,
      createWindowController: ({ quitting, onHideSelectedTask }) => new WindowController({
        createWindow: (options: BrowserWindowOptionsLike) =>
          new electron.BrowserWindow(options) as unknown as BrowserWindowLike,
        quitting,
        workAreaFor: bounds => electron.screen.getDisplayMatching(bounds).workArea,
        watchDisplays: changed => {
          electron.screen.on("display-metrics-changed", changed);
          electron.screen.on("display-removed", changed);
          electron.screen.on("display-added", changed);
          return () => {
            electron.screen.off("display-metrics-changed", changed);
            electron.screen.off("display-removed", changed);
            electron.screen.off("display-added", changed);
          };
        },
        ...(onHideSelectedTask === undefined ? {} : { onHideSelectedTask })
      }),
    createTrayImage: () => electron.nativeImage.createFromDataURL(TRAY_PNG_DATA_URL),
    createTray: (image) => new electron.Tray(image as Electron.NativeImage),
    buildMenu: (template) => electron.Menu.buildFromTemplate(
      template as Electron.MenuItemConstructorOptions[]
    ),
    createTrayController,
    createProgressServer: options => {
      const names=createConversationNameService();
      return createProgressServer({...options,
        ...(options.observerWorkers||options.observerWorkerSource?{observerSessionsRoot:defaultCodexSessionsRoot()}:{}),
        readConversationName:names.read,closeConversationNames:names.close});
    },
    stateStore,
    readToken: async (path) => (await readFile(path, "utf8")).trim(),
    randomUUID: nodeRandomUUID,
    now: () => new Date(),
    pid: process.pid,
    tokenPath,
    uiDirectory: resolve(currentDirectory, "../ui"),
    port: Number.isFinite(configuredPort) ? configuredPort : 17_837,
    diagnose: async (snapshot) => {
      const generatedAt = new Date().toISOString();
      const settings = await stateStore.readSettings();
      const version = electron.app.getVersion();
      await writeDiagnosticReport({
        directory: defaultDiagnosticsDirectory(),
        generatedAt,
        versions: {
          plugin: version,
          mcp: version,
          companion: version,
          protocol: PROTOCOL_VERSION
        },
        lifecycle: {
          ...(settings.desiredState === undefined ? {} : { desiredState: settings.desiredState }),
          observedState: snapshot.observedState
        },
        paths: {
          installManifestExists: await pathExists(installManifestPath),
          dataDirectoryExists: await pathExists(dataDirectory)
        },
        endpoint: { host: "127.0.0.1", port: Number.isFinite(configuredPort) ? configuredPort : 17_837 },
        runtimeAgeMs: snapshot.runtimeAgeMs,
        errors: snapshot.errors,
        hooks: snapshot.hooks,
        lease: snapshot.lease,
        compatibility: snapshot.compatibility,
        tracking: snapshot.tracking,
        operationalEvents: snapshot.operationalEvents,
        ...(snapshot.windowDiagnostics === undefined ? {} : { windowDiagnostics: snapshot.windowDiagnostics })
      });
    },
    operationalLogger,
    reportError: () => undefined,
    cleanupTimeoutMs: DEFAULT_CLEANUP_TIMEOUT_MS,
    withTimeout
  };
}

export async function runDesktop(
  dependencies?: DesktopDependencies,
  launchReason: DesktopLaunchReason = { kind: "explicit" }
): Promise<void> {
  const resolved = dependencies ?? await defaultDesktopDependencies();
  if (process.env.CODEX_PROGRESS_HUD_DATA_DIR) {
    // Electron resolves its own profile independently of APPDATA overrides.
    // Keep isolated companions from sharing the installed app's singleton lock.
    const userData = resolve(process.env.CODEX_PROGRESS_HUD_DATA_DIR, "electron");
    await mkdir(userData, { recursive: true });
    resolved.app.setPath("userData", userData);
  }
  // Async module loading and profile setup may finish after Electron's ready
  // event. This optional rendering preference must never abort startup.
  if (!resolved.app.isReady()) resolved.app.disableHardwareAcceleration();
  if (!resolved.app.requestSingleInstanceLock()) {
    resolved.app.quit();
    return;
  }

  let quitting = false;
  let cleanupComplete = false;
  let trayController: TrayController | undefined;
  let tray: TrayLike | undefined;
  let progressServer: DesktopProgressServer | undefined;
  let windowController: DesktopWindowController | undefined;
  let detachTaskObservation: (() => void) | undefined;
  let taskObservationStopped = false;
  let hideSelectedTaskMutation: ((taskId: string) => Promise<void>) | undefined;
  let startupAt: Date | undefined;
  let runtimeIdentity: RuntimeIdentity | undefined;
  let launchSettings: Awaited<ReturnType<LifecycleStateStore["readSettings"]>>;
  const recentErrors: DesktopDiagnosticSnapshot["errors"] = [];
  const recentOperationalEvents: DesktopDiagnosticSnapshot["operationalEvents"] = [];

  const rememberError = (error: unknown): void => {
    const candidate = typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    const code: HudErrorCode | "OFFLINE" = candidate === "EADDRINUSE"
      ? "PORT_CONFLICT"
      : candidate === "VERSION_MISMATCH"
        ? "VERSION_MISMATCH"
        : candidate === "AUTH_ERROR"
          ? "AUTH_ERROR"
          : "INTERNAL_ERROR";
    recentErrors.push({ code, occurredAt: resolved.now().toISOString() });
    if (recentErrors.length > 10) recentErrors.shift();
  };

  const record = (
    entry: Omit<OperationalLogEntry, "at">,
    at: Date = startupAt ?? resolved.now()
  ): void => {
    try {
      const timestamp = at.toISOString();
      recentOperationalEvents.push({ code: entry.event, at: timestamp });
      if (recentOperationalEvents.length > 20) recentOperationalEvents.shift();
      void resolved.operationalLogger
        ?.write({ at: timestamp, ...entry })
        .catch(() => undefined);
    } catch {
      // Operational logging is best effort and must not alter desktop lifecycle behavior.
    }
  };

  const reportError = (error: unknown, context: string): void => {
    rememberError(error);
    try {
      resolved.reportError(error, context);
    } catch {
      // Error reporting must not prevent cleanup or create an unhandled rejection.
    }
  };

  const quit = (): void => {
    try {
      resolved.app.quit();
    } catch (error) {
      reportError(error, "desktop quit");
    }
  };

  const observerSetupAbort = new AbortController();
  let observerSetupPending: Promise<unknown> | undefined;
  const cleanup = async (recordShutdown: boolean): Promise<void> => {
    observerSetupAbort.abort();
    let observerDisableFailed = false;
    try { resolved.observerSetup?.disable(); }
    catch {
      observerDisableFailed = true;
      reportError(new Error("OBSERVER_SETUP_DISABLE_FAILED"), "observer setup");
    }
    taskObservationStopped = true;
    try { detachTaskObservation?.(); }
    catch (error) { reportError(error, "desktop cleanup: task listener"); }
    detachTaskObservation = undefined;
    const shutdownAt = resolved.now();
    if (recordShutdown) {
      record({
        level: "info",
        event: "shutdown_requested",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION
      }, shutdownAt);
    }
    let cleanupFailed = observerDisableFailed;
    let singletonReleased = false;
    try {
      // Release process ownership before the listener can become unreachable so
      // a manager replacement cannot spend its only launch on the retiring app.
      resolved.app.releaseSingleInstanceLock();
      singletonReleased = true;
    } catch (error) {
      cleanupFailed = true;
      reportError(error, "desktop cleanup: singleton release");
    }
    const steps: Array<[string, () => void | Promise<void>]> = [
      ["observer setup close", async () => {
        // Start close before waiting for setup: close is responsible for cancelling
        // native prompts and owned children. Do not expose raw authentication errors.
        try {
          await Promise.all([resolved.observerSetup?.close(), observerSetupPending]);
        } catch { throw new Error("OBSERVER_SETUP_CLOSE_FAILED"); }
      }],
      ["settings dispose", () => resolved.settingsController?.dispose()],
      // If explicit release failed, keep the listener reachable (and returning
      // SHUTTING_DOWN) until process exit releases both resources atomically.
      ...(singletonReleased
        ? [["server close", () => progressServer?.close()] as [string, () => void | Promise<void>]]
        : []),
      ["tray dispose", () => trayController?.dispose() ?? tray?.destroy()],
      ["window dispose", () => windowController?.dispose()],
      ["runtime clear", () => resolved.stateStore.clearRuntime(runtimeIdentity)]
    ];
    const attempts = steps.map(async ([name, step]) => {
      let operation: Promise<void>;
      try {
        operation = Promise.resolve(step());
      } catch (error) {
        cleanupFailed = true;
        reportError(error, `desktop cleanup: ${name}`);
        return;
      }
      try {
        await resolved.withTimeout(operation, resolved.cleanupTimeoutMs, name);
      } catch (error) {
        cleanupFailed = true;
        reportError(error, `desktop cleanup: ${name}`);
      }
    });
    await Promise.all(attempts);
    cleanupComplete = true;
    if (recordShutdown) {
      record({
        level: cleanupFailed ? "error" : "info",
        event: cleanupFailed ? "shutdown_timeout" : "shutdown_complete",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION,
        elapsedMs: Math.max(0, resolved.now().getTime() - shutdownAt.getTime())
      });
    }
  };

  let finishQuitPromise: Promise<void> | undefined;
  const finishQuitAfterStartup = (): void => {
    finishQuitPromise ??= cleanup(true)
      .then(quit)
      .catch((error: unknown) => reportError(error, "desktop quit"));
  };
  const assertStarting = (): void => {
    if (quitting) throw new StartupCancelledError("desktop startup cancelled");
  };

  try {
    assertStarting();
    windowController = resolved.createWindowController({
      quitting: () => quitting,
      onHideSelectedTask: (taskId) => hideSelectedTaskMutation?.(taskId)
    });
    resolved.app.on("second-instance", (_event: unknown, commandLine?: unknown) => {
      try {
        const intent = Array.isArray(commandLine) &&
          commandLine.every((argument) => typeof argument === "string")
          ? selectEntryIntent(commandLine)
          : undefined;
        if (intent?.mode !== "hud" || intent.launchReason.kind !== "explicit") return;
      } catch (error) {
        reportError(error, "second-instance launch intent");
        return;
      }
      if (quitting) return;
      void resolved.stateStore.setDesiredState("on")
        .then(({ generation }) => resolved.stateStore.runIfGeneration(
          generation,
          "on",
          () => {
            if (quitting) return;
            windowController?.show();
          }
        ))
        .catch((error: unknown) => reportError(error, "second-instance activation"));
    });
    resolved.app.on("before-quit", (event: { preventDefault(): void }) => {
      quitting = true;
      if (cleanupComplete) return;
      event.preventDefault();
      finishQuitAfterStartup();
    });

    launchSettings = await resolved.stateStore.readSettings();
    if (
      launchReason.kind === "manager" &&
      (launchSettings.desiredState !== "on" || launchSettings.generation !== launchReason.generation)
    ) {
      quitting = true;
      quit();
      return;
    }
    if (launchReason.kind === "explicit" && launchSettings.desiredState !== "on") {
      launchSettings = await resolved.stateStore.setDesiredState("on");
    }

    await resolved.app.whenReady();
    assertStarting();
    startupAt = resolved.now();
    record({
      level: "info",
      event: "startup_requested",
      lifecycleState: "starting",
      protocolVersion: PROTOCOL_VERSION
    }, startupAt);
    runtimeIdentity = {
      pid: resolved.pid,
      version: resolved.app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      instanceNonce: resolved.randomUUID(),
      startedAt: startupAt.toISOString()
    };
    assertStarting();
    if (!(await resolved.stateStore.writeRuntime(runtimeIdentity, launchSettings.generation))) {
      throw new StartupCancelledError("desktop launch generation is no longer current");
    }
    assertStarting();
    const publishingWindowController = windowController;
    const publishingStartupAt = startupAt;

    const readiness = await resolved.stateStore.runIfGeneration(
      launchSettings.generation,
      "on",
      async () => {
        const health = (): HudHealth => ({
          service: "codex-progress-hud",
          ...runtimeIdentity!,
          protocolVersion: PROTOCOL_VERSION,
          visibility: publishingWindowController.visibility(),
          windowDiagnostics: readWindowDiagnostics(() => publishingWindowController.diagnostics?.())
        });
        assertStarting();
        progressServer = resolved.createProgressServer({
          ...(resolved.observerWorkers?{observerWorkers:resolved.observerWorkers}:{}),
          ...(resolved.observerWorkerSource?{observerWorkerSource:resolved.observerWorkerSource}:{}),
          ...(resolved.observerSchedulerRecovery?{observerSchedulerRecovery:resolved.observerSchedulerRecovery}:{}),
          ...(resolved.onObserverObservation?{onObserverObservation:resolved.onObserverObservation}:{}),
          port: resolved.port,
          awaitInitialLease: launchReason.kind === "manager",
          tokenPath: resolved.tokenPath,
          isGoalCheckpointOwner: async () => {
            const [settings,runtime]=await Promise.all([resolved.stateStore.readSettings({timeoutMs:500}),resolved.stateStore.readRuntime({timeoutMs:500})]);
            return settings.generation===launchSettings.generation&&settings.desiredState==='on'&&
              runtime!==null&&runtime?.instanceNonce===runtimeIdentity?.instanceNonce&&runtime?.pid===runtimeIdentity?.pid;
          },
          uiDirectory: resolved.uiDirectory,
          health,
          bootstrap: () => ({ protocolVersion: PROTOCOL_VERSION, generation: launchSettings.generation }),
          showWindow: () => publishingWindowController.show(),
          hideWindow: () => publishingWindowController.hide(),
          requestShutdown: () => {
            quitting = true;
            quit();
          },
          ...(resolved.settingsController === undefined ? {} : {openSettings: () => resolved.settingsController!.open()}),
          ...(resolved.leaseGraceMs === undefined ? {} : { leaseGraceMs: resolved.leaseGraceMs }),
          runIfGeneration: (generation, desiredState, operation, signal) =>
            resolved.stateStore.runIfGeneration(generation, desiredState, operation, { signal })
        });

        await progressServer.listen();
        assertStarting();
        const token = await resolved.readToken(resolved.tokenPath);
        assertStarting();
        const taskStore = progressServer.store;
        const currentSnapshot = taskStore?.snapshot();
        if (currentSnapshot !== undefined) {
          const selectedTask = currentSnapshot.tasks.find((task) => task.id === currentSnapshot.selectedTaskId);
          publishingWindowController.selectTask(currentSnapshot.selectedTaskId, {
            hiddenForTask: selectedTask?.hiddenForTask === true
          });
        }
        await publishingWindowController.create({ url: progressServer.address().url, token });
        if (currentSnapshot?.rows !== undefined) {
          publishingWindowController.updateRows?.(currentSnapshot.rows.length, currentSnapshot.revision);
        }
        assertStarting();
        let latestTaskSnapshot = currentSnapshot;
        const mutationController = taskStore === undefined || latestTaskSnapshot === undefined
          ? undefined
          : createTaskMutationController({
              fetch: (input, init) => {
                const headers = new Headers(init?.headers);
                headers.set("authorization", `Bearer ${token}`);
                return fetch(new URL(input, progressServer!.address().url).toString(), {
                  ...init,
                  headers
                });
              },
              getSnapshot: () => latestTaskSnapshot!,
              setSnapshot: (snapshot) => {
                if (latestTaskSnapshot === undefined || snapshot.revision >= latestTaskSnapshot.revision) {
                  latestTaskSnapshot = snapshot;
                }
              },
              loadBootstrap: async () => ({
                protocolVersion: PROTOCOL_VERSION,
                generation: launchSettings.generation
              })
            });
        const mutateTask = async (taskId: string, action: "select" | "visibility", body: unknown): Promise<void> => {
          await mutationController?.mutate(
            `/api/tasks/${encodeURIComponent(taskId)}/${action}`,
            body
          );
        };
        hideSelectedTaskMutation = async (taskId: string): Promise<void> => {
          await mutateTask(taskId, "visibility", { hidden: true });
        };
        const mutateSelection = async (taskId: string, mode: "pinned" | "follow_activity"): Promise<void> => {
          await mutateTask(taskId, "select", { mode });
        };
        const previousByTask = new Map((currentSnapshot?.tasks ?? []).map((task) => [task.id, task]));
        const isTerminal = (status: string): boolean => [
          "ended_unknown", "completed_unverified", "succeeded_verified", "failed", "interrupted"
        ].includes(status);
        const onStoreChanged = (changed: unknown): void => {
          if (quitting || taskObservationStopped) return;
          const snapshot = changed as ReturnType<NonNullable<DesktopProgressServer["store"]>["snapshot"]>;
          if (snapshot.rows !== undefined) publishingWindowController.updateRows?.(snapshot.rows.length, snapshot.revision);
          if (latestTaskSnapshot === undefined || snapshot.revision >= latestTaskSnapshot.revision) {
            latestTaskSnapshot = snapshot;
          }
          trayController?.updateTasks?.(snapshot.tasks.map((task) => ({
            ...task,
            selected: task.id === snapshot.selectedTaskId
          })));
          for (const task of snapshot.tasks) {
            const previous = previousByTask.get(task.id);
            if (previous === undefined || previous.lastActivityAt !== task.lastActivityAt) {
              publishingWindowController.onTaskActivity(task.id, {
                isNewTask: previous === undefined,
                terminal: isTerminal(task.status),
                hiddenForTask: task.hiddenForTask
              });
            }
            previousByTask.set(task.id, task);
          }
          const selectedTask = snapshot.tasks.find((task) => task.id === snapshot.selectedTaskId);
          publishingWindowController.selectTask(snapshot.selectedTaskId, {
            hiddenForTask: selectedTask?.hiddenForTask === true
          });
          for (const taskId of previousByTask.keys()) {
            if (!snapshot.tasks.some((task) => task.id === taskId)) previousByTask.delete(taskId);
          }
        };
        taskStore?.on("changed", onStoreChanged);
        detachTaskObservation = () => { taskStore?.off?.("changed", onStoreChanged); };
        const trayImage = resolved.createTrayImage();
        if (trayImage.isEmpty()) throw new Error("tray image is empty");
        assertStarting();
        tray = resolved.createTray(trayImage);
        assertStarting();
        trayController = resolved.createTrayController({
          tray,
          buildMenu: resolved.buildMenu,
          onShow: () => publishingWindowController.show(),
          onHide: () => publishingWindowController.hide(),
          taskItems: (currentSnapshot?.tasks ?? []).map((task) => ({
            ...task,
            selected: task.id === currentSnapshot?.selectedTaskId
          })),
          onSelectTask: (taskId) => mutateSelection(taskId, "pinned"),
          onFollowActivity: () => {
            const selectedTaskId = taskStore?.snapshot().selectedTaskId;
            return selectedTaskId === null || selectedTaskId === undefined
              ? undefined
              : mutateSelection(selectedTaskId, "follow_activity");
          },
          onDiagnose: () => {
            const diagnosticTaskSnapshot = latestTaskSnapshot ?? taskStore?.snapshot();
            const selectedTask = diagnosticTaskSnapshot?.selected?.task;
            const hookActivity = progressServer?.hookActivity?.() ?? { activitySeen: false };
            const selectedStatus = selectedTask?.status;
            const leaseCount = progressServer?.leaseStore?.active().length ?? 0;
            return resolved.diagnose({
              observedState: quitting
                ? "stopped"
                : publishingWindowController.visibility() === "visible"
                  ? "running"
                  : "hidden",
              runtimeAgeMs: Math.max(0, resolved.now().getTime() - publishingStartupAt.getTime()),
              errors: [...recentErrors],
              hooks: {
                expected: true,
                activitySeen: hookActivity.activitySeen,
                ...(hookActivity.lastEventAt === undefined
                  ? {}
                  : { lastEventAt: hookActivity.lastEventAt })
              },
              lease: { active: leaseCount > 0, count: leaseCount },
              compatibility: {
                compatible: true,
                incompatibleClientSeen: diagnosticTaskSnapshot?.compatibility?.incompatibleClientSeen === true
              },
              tracking: {
                taskCount: diagnosticTaskSnapshot?.tasks.length ?? 0,
                ...(selectedStatus === undefined ? {} : { selectedStatus: selectedStatus as TaskStatus }),
                lateAttached: selectedTask?.trackingOrigin === "late_attach"
              },
              operationalEvents: [...recentOperationalEvents],
              windowDiagnostics: readWindowDiagnostics(() => publishingWindowController.diagnostics?.())
            });
          },
          ...(resolved.settingsController === undefined ? {} : {onSettings: () => resolved.settingsController!.open()}),
          onExit: async () => {
            const { generation } = await resolved.stateStore.setDesiredState("off");
            await resolved.stateStore.runIfGeneration(generation, "off", () => {
              quitting = true;
              quit();
            });
          },
          onError: (error, action) => reportError(error, `tray action: ${action}`)
        });
        tray = undefined;
        const startupReadyAt = resolved.now();
        record({
          level: "info",
          event: "startup_ready",
          lifecycleState: publishingWindowController.visibility() === "visible" ? "running" : "hidden",
          protocolVersion: PROTOCOL_VERSION,
          elapsedMs: Math.max(0, startupReadyAt.getTime() - publishingStartupAt.getTime())
        }, startupReadyAt);
      }
    );
    if (!readiness.accepted) {
      throw new StartupCancelledError("desktop readiness generation is no longer current");
    }
    // The readiness generation lease has been released. Browser login may take
    // minutes, but must not hold that lock or delay HUD startup/disable requests.
    if (resolved.observerSetup && !quitting && !observerSetupAbort.signal.aborted) {
      observerSetupPending = Promise.resolve().then(() => {
        if (quitting || observerSetupAbort.signal.aborted) return;
        return resolved.observerSetup!.start(observerSetupAbort.signal);
      }).catch(() => {
        if (!observerSetupAbort.signal.aborted) {
          reportError(new Error("OBSERVER_SETUP_FAILED"), "observer setup");
        }
      });
    }
  } catch (error) {
    quitting = true;
    if (!(error instanceof StartupCancelledError)) {
      const startupFailedAt = resolved.now();
      record({
        level: "error",
        event: "startup_failed",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION,
        elapsedMs: startupAt === undefined
          ? 0
          : Math.max(0, startupFailedAt.getTime() - startupAt.getTime())
      }, startupFailedAt);
      reportError(error, "desktop startup");
    }
    try {
      await cleanup(false);
    } catch (cleanupError) {
      reportError(cleanupError, "desktop cleanup");
    }
    quit();
    if (error instanceof StartupCancelledError) return;
    throw error;
  }
}
