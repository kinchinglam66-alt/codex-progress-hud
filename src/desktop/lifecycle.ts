import { randomUUID as nodeRandomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectEntryIntent, type DesktopLaunchReason } from "../main.js";
import { createOperationalLogger, type OperationalLogEntry, type OperationalLogger } from "../diagnostics/logger.js";
import { writeDiagnosticReport } from "../diagnostics/report.js";
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
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }): void;
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
  diagnose(snapshot: DesktopDiagnosticSnapshot): void | Promise<void>;
  operationalLogger?: OperationalLogger;
  reportError(error: unknown, context: string): void;
  cleanupTimeoutMs: number;
  withTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T>;
}

export interface DesktopDiagnosticSnapshot {
  observedState: ObservedHudState;
  runtimeAgeMs: number;
  errors: Array<{ code: HudErrorCode | "OFFLINE"; occurredAt: string }>;
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
        errors: snapshot.errors
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
  if (!resolved.app.requestSingleInstanceLock()) {
    if (launchReason.kind === "explicit") await resolved.stateStore.setDesiredState("on");
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
  let runtimeIdentity: RuntimeIdentity | undefined;
  let launchSettings: Awaited<ReturnType<LifecycleStateStore["readSettings"]>>;
  const recentErrors: DesktopDiagnosticSnapshot["errors"] = [];

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
      void resolved.operationalLogger
        ?.write({ at: at.toISOString(), ...entry })
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

  const cleanup = async (recordShutdown: boolean): Promise<void> => {
    const shutdownAt = resolved.now();
    if (recordShutdown) {
      record({
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
    windowController = resolved.createWindowController({ quitting: () => quitting });
    resolved.app.on("second-instance", (_event: unknown, commandLine?: unknown) => {
      try {
        const intent = Array.isArray(commandLine) &&
          commandLine.every((argument) => typeof argument === "string")
          ? selectEntryIntent(commandLine)
          : undefined;
        if (intent?.mode !== "hud" || intent.launchReason !== "explicit") return;
      } catch (error) {
        reportError(error, "second-instance launch intent");
        return;
      }
      void resolved.stateStore.setDesiredState("on")
        .then(() => windowController?.show())
        .catch((error: unknown) => reportError(error, "second-instance activation"));
    });
    resolved.app.on("before-quit", (event: { preventDefault(): void }) => {
      quitting = true;
      if (cleanupComplete) return;
      event.preventDefault();
      finishQuitAfterStartup();
    });

    launchSettings = await resolved.stateStore.readSettings();
    if (launchReason.kind === "automatic-login" && launchSettings.desiredState !== "on") {
      quitting = true;
      quit();
      return;
    }
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
          visibility: publishingWindowController.visibility()
        });
        assertStarting();
        progressServer = resolved.createProgressServer({
          port: resolved.port,
          tokenPath: resolved.tokenPath,
          uiDirectory: resolved.uiDirectory,
          health,
          showWindow: () => publishingWindowController.show(),
          hideWindow: () => publishingWindowController.hide(),
          requestShutdown: () => {
            quitting = true;
            quit();
          },
          runIfGeneration: (generation, desiredState, operation) =>
            resolved.stateStore.runIfGeneration(generation, desiredState, operation)
        });

        await progressServer.listen();
        assertStarting();
        const token = await resolved.readToken(resolved.tokenPath);
        assertStarting();
        await publishingWindowController.create({ url: progressServer.address().url, token });
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
          onShow: () => publishingWindowController.show(),
          onHide: () => publishingWindowController.hide(),
          onToggleLogin: async (enabled) => {
            resolved.app.setLoginItemSettings({
              openAtLogin: enabled,
              args: ["--automatic-login"]
            });
            await resolved.stateStore.setStartWithWindows(enabled);
          },
          onDiagnose: () => resolved.diagnose({
            observedState: quitting
              ? "stopped"
              : publishingWindowController.visibility() === "visible"
                ? "running"
                : "hidden",
            runtimeAgeMs: Math.max(0, resolved.now().getTime() - publishingStartupAt.getTime()),
            errors: [...recentErrors]
          }),
          onExit: async () => {
            await resolved.stateStore.setDesiredState("off");
            quitting = true;
            quit();
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
