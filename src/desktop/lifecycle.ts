import { randomUUID as nodeRandomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  reportError(error: unknown, context: string): void;
}

const TRAY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class StartupCancelledError extends Error {}

async function defaultDesktopDependencies(): Promise<DesktopDependencies> {
  const electron = await import("electron");
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const tokenPath = defaultTokenPath();
  const configuredPort = Number.parseInt(process.env.CODEX_PROGRESS_HUD_PORT ?? "17837", 10);
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
    stateStore: createLifecycleStateStore({
      settingsPath: defaultSettingsPath(),
      runtimePath: defaultRuntimePath(),
      installManifestPath: defaultInstallManifestPath()
    }),
    readToken: async (path) => (await readFile(path, "utf8")).trim(),
    randomUUID: nodeRandomUUID,
    now: () => new Date(),
    pid: process.pid,
    tokenPath,
    uiDirectory: resolve(currentDirectory, "../ui"),
    port: Number.isFinite(configuredPort) ? configuredPort : 17_837,
    diagnose: () => undefined,
    reportError: (error, context) => console.error(`Codex Progress HUD ${context}`, error)
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
  let cleanupPromise: Promise<void> | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  let trayController: TrayController | undefined;
  let tray: TrayLike | undefined;
  let progressServer: DesktopProgressServer | undefined;
  let windowController: DesktopWindowController | undefined;

  const reportError = (error: unknown, context: string): void => {
    try {
      resolved.reportError(error, context);
    } catch {
      // Error reporting must not prevent cleanup or create an unhandled rejection.
    }
  };

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const steps: Array<[string, () => void | Promise<void>]> = [
        ["server close", () => progressServer?.close()],
        ["tray dispose", () => trayController?.dispose() ?? tray?.destroy()],
        ["window dispose", () => windowController?.dispose()],
        ["runtime clear", () => resolved.stateStore.clearRuntime()]
      ];
      for (const [name, step] of steps) {
        try {
          await step();
        } catch (error) {
          reportError(error, `desktop cleanup: ${name}`);
        }
      }
      cleanupComplete = true;
    })();
    return cleanupPromise;
  };

  let finishQuitPromise: Promise<void> | undefined;
  const finishQuitAfterStartup = (): void => {
    finishQuitPromise ??= startupSettled
      .then(cleanup)
      .then(() => resolved.app.quit())
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
    const runtimeIdentity: RuntimeIdentity = {
      pid: resolved.pid,
      version: resolved.app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      instanceNonce: resolved.randomUUID(),
      startedAt: resolved.now().toISOString()
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
        resolved.app.quit();
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
        resolved.app.quit();
      },
      onError: (error, action) => reportError(error, `tray action: ${action}`)
    });
    tray = undefined;
  } catch (error) {
    quitting = true;
    if (error instanceof StartupCancelledError) return;
    await cleanup();
    reportError(error, "desktop startup");
    resolved.app.quit();
    throw error;
  } finally {
    settleStartup();
  }
}
