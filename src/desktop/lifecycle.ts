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

export interface DesktopDependencies {
  app: DesktopAppLike;
  createWindowController(options: { quitting(): boolean }): DesktopWindowController;
  createTray(): TrayLike;
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
}

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
    createTray: () => new electron.Tray(electron.nativeImage.createFromPath(process.execPath)),
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
    diagnose: () => undefined
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
  let trayController: TrayController | undefined;
  let progressServer: DesktopProgressServer | undefined;
  const windowController = resolved.createWindowController({ quitting: () => quitting });

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await progressServer?.close();
      trayController?.dispose();
      windowController.dispose();
      await resolved.stateStore.clearRuntime();
    })();
    return cleanupPromise;
  };

  resolved.app.on("second-instance", () => windowController.show());
  resolved.app.on("before-quit", async (event: { preventDefault(): void }) => {
    quitting = true;
    if (cleanupComplete) return;
    event.preventDefault();
    try {
      await cleanup();
    } finally {
      cleanupComplete = true;
      resolved.app.quit();
    }
  });

  await resolved.app.whenReady();
  const runtimeIdentity: RuntimeIdentity = {
    pid: resolved.pid,
    version: resolved.app.getVersion(),
    protocolVersion: PROTOCOL_VERSION,
    instanceNonce: resolved.randomUUID(),
    startedAt: resolved.now().toISOString()
  };
  await resolved.stateStore.writeRuntime(runtimeIdentity);

  const health = (): HudHealth => ({
    service: "codex-progress-hud",
    ...runtimeIdentity,
    protocolVersion: PROTOCOL_VERSION,
    visibility: windowController.visibility()
  });
  progressServer = resolved.createProgressServer({
    port: resolved.port,
    tokenPath: resolved.tokenPath,
    uiDirectory: resolved.uiDirectory,
    health,
    showWindow: () => windowController.show(),
    hideWindow: () => windowController.hide(),
    requestShutdown: () => {
      quitting = true;
      resolved.app.quit();
    }
  });

  try {
    await progressServer.listen();
    const token = await resolved.readToken(resolved.tokenPath);
    await windowController.create({ url: progressServer.address().url, token });
    trayController = resolved.createTrayController({
      tray: resolved.createTray(),
      buildMenu: resolved.buildMenu,
      loginEnabled: resolved.app.getLoginItemSettings().openAtLogin,
      onShow: () => windowController.show(),
      onHide: () => windowController.hide(),
      onToggleLogin: (enabled) => resolved.app.setLoginItemSettings({ openAtLogin: enabled }),
      onDiagnose: resolved.diagnose,
      onExit: async () => {
        quitting = true;
        await resolved.stateStore.setDesiredState("off");
        resolved.app.quit();
      }
    });
  } catch (error) {
    quitting = true;
    await cleanup();
    throw error;
  }
}
