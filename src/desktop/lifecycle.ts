import { randomUUID as nodeRandomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationalLogger, type OperationalLogEntry, type OperationalLogger } from "../diagnostics/logger.js";
import { writeDiagnosticReport } from "../diagnostics/report.js";
import { createLifecycleStateStore } from "../lifecycle/state-store.js";
import {
  PROTOCOL_VERSION,
  type HudHealth,
  type LifecycleStateStore,
  type RuntimeIdentity
} from "../lifecycle/types.js";
import { createProgressServer, type ProgressServerOptions } from "../server/http-server.js";
import {
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

export function scheduleAfterReady(
  ready: Promise<void>,
  start: () => void | Promise<unknown>,
  onError: (error: unknown) => void = console.error
): void {
  void ready.then(start).catch(onError);
}

export interface DesktopAppLike {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  on(event: string, callback: (...args: any[]) => unknown): unknown;
  quit(): void;
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
  getVersion(): string;
}

export interface DesktopWindowController {
  create(options: { url: string; token: string }): Promise<void>;
  show(): void;
  hide(): void;
  visibility(): "visible" | "hidden";
  dispose(): void;
}

export interface DesktopProgressServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number; url: string };
}

export interface DesktopTrayImage {
  isEmpty(): boolean;
}

export interface DesktopDependencies {
  app: DesktopAppLike;
  createWindowController(options: { quitting(): boolean }): DesktopWindowController;
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
  diagnose(): void | Promise<void>;
  operationalLogger?: OperationalLogger;
  reportError(error: unknown, context: string): void;
  cleanupTimeoutMs: number;
  withTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T>;
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
  return {
    app: electron.app,
    createWindowController: ({ quitting }) => new WindowController({
      createWindow: (options: BrowserWindowOptionsLike) =>
        new electron.BrowserWindow(options) as unknown as BrowserWindowLike,
      quitting
    }),
    createTrayImage: () => electron.nativeImage.createFromDataURL(TRAY_PNG_DATA_URL),
    createTray: (image) => new electron.Tray(image as Electron.NativeImage),
    buildMenu: (template) => electron.Menu.buildFromTemplate(
      template as Electron.MenuItemConstructorOptions[]
    ),
    createTrayController,
    createProgressServer,
    stateStore,
    readToken: async (path) => (await readFile(path, "utf8")).trim(),
    randomUUID: nodeRandomUUID,
    now: () => new Date(),
    pid: process.pid,
    tokenPath,
    uiDirectory: resolve(currentDirectory, "../ui"),
    port: Number.isFinite(configuredPort) ? configuredPort : 17_837,
    diagnose: async () => {
      const generatedAt = new Date().toISOString();
      const settings = await stateStore.readSettings();
      const runtime = await stateStore.readRuntime();
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
          observedState: runtime === null ? "stopped" : "running"
        },
        paths: {
          installManifestExists: await pathExists(installManifestPath),
          dataDirectoryExists: await pathExists(dataDirectory)
        },
        endpoint: { host: "127.0.0.1", port: Number.isFinite(configuredPort) ? configuredPort : 17_837 },
        ...(runtime === null
          ? {}
          : { runtimeAgeMs: Math.max(0, Date.parse(generatedAt) - Date.parse(runtime.startedAt)) }),
        errors: []
      });
    },
    operationalLogger,
    reportError: () => undefined,
    cleanupTimeoutMs: DEFAULT_CLEANUP_TIMEOUT_MS,
    withTimeout
  };
}

export async function runDesktop(dependencies?: DesktopDependencies): Promise<void> {
  const resolved = dependencies ?? await defaultDesktopDependencies();
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
  let startupAt: Date | undefined;

  const record = async (
    entry: Omit<OperationalLogEntry, "at">,
    at: Date = startupAt ?? resolved.now()
  ): Promise<void> => {
    try {
      await resolved.operationalLogger?.write({ at: at.toISOString(), ...entry });
    } catch {
      // Operational logging is best effort and must not alter desktop lifecycle behavior.
    }
  };

  const reportError = (error: unknown, context: string): void => {
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

  const cleanup = async (recordShutdown: boolean): Promise<void> => {
    const shutdownAt = resolved.now();
    if (recordShutdown) {
      await record({
        level: "info",
        event: "shutdown_requested",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION
      }, shutdownAt);
    }
    let cleanupFailed = false;
    const steps: Array<[string, () => void | Promise<void>]> = [
      ["server close", () => progressServer?.close()],
      ["tray dispose", () => trayController?.dispose() ?? tray?.destroy()],
      ["window dispose", () => windowController?.dispose()],
      ["runtime clear", () => resolved.stateStore.clearRuntime()]
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
      await record({
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
    windowController = resolved.createWindowController({ quitting: () => quitting });
    resolved.app.on("second-instance", () => windowController?.show());
    resolved.app.on("before-quit", (event: { preventDefault(): void }) => {
      quitting = true;
      if (cleanupComplete) return;
      event.preventDefault();
      finishQuitAfterStartup();
    });

    await resolved.app.whenReady();
    assertStarting();
    startupAt = resolved.now();
    await record({
      level: "info",
      event: "startup_requested",
      lifecycleState: "starting",
      protocolVersion: PROTOCOL_VERSION
    }, startupAt);
    const runtimeIdentity: RuntimeIdentity = {
      pid: resolved.pid,
      version: resolved.app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      instanceNonce: resolved.randomUUID(),
      startedAt: startupAt.toISOString()
    };
    assertStarting();
    await resolved.stateStore.writeRuntime(runtimeIdentity);
    assertStarting();

    const health = (): HudHealth => ({
      service: "codex-progress-hud",
      ...runtimeIdentity,
      protocolVersion: PROTOCOL_VERSION,
      visibility: windowController?.visibility() ?? "hidden"
    });
    assertStarting();
    progressServer = resolved.createProgressServer({
      port: resolved.port,
      tokenPath: resolved.tokenPath,
      uiDirectory: resolved.uiDirectory,
      health,
      showWindow: () => windowController?.show(),
      hideWindow: () => windowController?.hide(),
      requestShutdown: () => {
        quitting = true;
        quit();
      }
    });

    await progressServer.listen();
    assertStarting();
    const token = await resolved.readToken(resolved.tokenPath);
    assertStarting();
    await windowController.create({ url: progressServer.address().url, token });
    assertStarting();
    const trayImage = resolved.createTrayImage();
    if (trayImage.isEmpty()) throw new Error("tray image is empty");
    assertStarting();
    tray = resolved.createTray(trayImage);
    assertStarting();
    trayController = resolved.createTrayController({
      tray,
      buildMenu: resolved.buildMenu,
      loginEnabled: resolved.app.getLoginItemSettings().openAtLogin,
      onShow: () => windowController?.show(),
      onHide: () => windowController?.hide(),
      onToggleLogin: (enabled) => resolved.app.setLoginItemSettings({ openAtLogin: enabled }),
      onDiagnose: resolved.diagnose,
      onExit: async () => {
        await resolved.stateStore.setDesiredState("off");
        quitting = true;
        quit();
      },
      onError: (error, action) => reportError(error, `tray action: ${action}`)
    });
    tray = undefined;
    await record({
      level: "info",
      event: "startup_ready",
      lifecycleState: windowController.visibility() === "visible" ? "running" : "hidden",
      protocolVersion: PROTOCOL_VERSION,
      elapsedMs: 0
    }, startupAt);
  } catch (error) {
    quitting = true;
    if (!(error instanceof StartupCancelledError)) {
      await record({
        level: "error",
        event: "startup_failed",
        lifecycleState: "stopped",
        protocolVersion: PROTOCOL_VERSION,
        elapsedMs: 0
      });
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
