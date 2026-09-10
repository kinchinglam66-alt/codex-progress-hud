import { hudBounds, type HudRectangle } from "./hud-layout.js";
import { windowDiagnosticsSchema, type WindowDiagnostics } from "../diagnostics/window-state.js";
import { createWindowContentProbe, type ContentReader } from './window-content-probe.js';

export interface BrowserWindowOptionsLike {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  frame: boolean;
  transparent: boolean;
  alwaysOnTop: boolean;
  resizable: boolean;
  skipTaskbar: boolean;
  show: boolean;
  backgroundColor: string;
  webPreferences: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
    spellcheck: boolean;
    partition: string;
  };
}

export interface WindowCloseEventLike {
  preventDefault(): void;
}

export interface BrowserWindowLike {
  webContents: {
    executeJavaScript?: ContentReader['executeJavaScript'];
    capturePage?: ContentReader['capturePage'];
    on(event: "dom-ready" | "did-finish-load" | "did-start-loading", listener: () => void): void;
    on(event: "did-fail-load", listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): void;
    on(event: "render-process-gone", listener: (event: unknown, details: { reason: string; exitCode: number }) => void): void;
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }, url: string) => void
    ): void;
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: "deny" }
    ): void;
    session: {
      webRequest: {
        onBeforeSendHeaders(
          filter: { urls: string[] },
          listener: (
            details: { requestHeaders: Record<string, string> },
            callback: (response: { requestHeaders: Record<string, string> }) => void
          ) => void
        ): void;
        onBeforeSendHeaders(listener: null): void;
      };
    };
  };
  on(event: "close", listener: (event: WindowCloseEventLike) => void): this;
  on(event: "closed", listener: () => void): this;
  on(event: "responsive" | "unresponsive", listener: () => void): this;
  once(event: "ready-to-show", listener: () => void): this;
  loadURL(url: string): Promise<unknown>;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  getBounds?(): HudRectangle;
  setBounds?(bounds: HudRectangle): void;
}

export interface WindowControllerDependencies {
  createWindow(options: BrowserWindowOptionsLike): BrowserWindowLike;
  quitting(): boolean;
  workAreaFor?(bounds: HudRectangle): HudRectangle;
  watchDisplays?(changed: () => void): () => void;
  onHideSelectedTask?(taskId: string): void | Promise<void>;
}

export interface WindowCreateOptions {
  url: string;
  token: string;
}

export interface SelectedTaskVisibility {
  hiddenForTask?: boolean;
}

const WINDOW_OPTIONS: BrowserWindowOptionsLike = {
  width: 340,
  height: 146,
  minWidth: 1,
  minHeight: 1,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  skipTaskbar: true,
  show: false,
  backgroundColor: "#00000000",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    partition: "codex-progress-hud"
  }
};

export class WindowController {
  private window: BrowserWindowLike | undefined;
  private authorizationRequest: BrowserWindowLike["webContents"]["session"]["webRequest"] | undefined;
  private authorizationRegistered = false;
  private selectedTaskId: string | null = null;
  private manuallyHidden = false;
  private rows = 0;
  private layoutRevision = -1;
  private unwatchDisplays: (() => void) | undefined;
  private contentProbe: ReturnType<typeof createWindowContentProbe> | undefined;
  private rendering: Omit<WindowDiagnostics, "exists" | "visible" | "bounds"> = {
    page: "not-created", renderer: "unknown", domReady: false, readyToShow: false
  };

  constructor(private readonly dependencies: WindowControllerDependencies) {}

  async create(options: WindowCreateOptions): Promise<void> {
    if (this.window !== undefined && !this.window.isDestroyed()) return;

    let initialUrl: URL;
    try {
      initialUrl = new URL(options.url);
    } catch {
      throw new Error("Progress HUD window requires an exact loopback origin");
    }
    const loopback = initialUrl.hostname === "127.0.0.1" || initialUrl.hostname === "[::1]";
    if (
      initialUrl.protocol !== "http:" ||
      !loopback ||
      options.url !== initialUrl.origin
    ) {
      throw new Error("Progress HUD window requires an exact loopback origin");
    }
    const allowedOrigin = initialUrl.origin;

    const window = this.dependencies.createWindow(WINDOW_OPTIONS);
    this.window = window;
    this.contentProbe = window.webContents.executeJavaScript && window.webContents.capturePage
      ? createWindowContentProbe({
          executeJavaScript: code => window.webContents.executeJavaScript!(code),
          capturePage: (rect, options) => window.webContents.capturePage!(rect, options)
        }) : undefined;
    this.rendering = { page: "loading", renderer: "unknown", domReady: false, readyToShow: false };
    const current = () => this.window === window && !window.isDestroyed();
    window.webContents.on("did-start-loading", () => {
      if (current() && this.rendering.page !== 'loading') this.contentProbe?.dispose();
      if (current()) this.rendering = { page: "loading", renderer: "unknown", domReady: false, readyToShow: this.rendering.readyToShow };
    });
    window.webContents.on("dom-ready", () => {
      if (current()) Object.assign(this.rendering, { page: "dom-ready", domReady: true, renderer: "responsive" });
    });
    window.webContents.on("did-finish-load", () => {
      if (current()) this.rendering.page = "loaded";
    });
    window.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (current() && isMainFrame) {
        this.rendering.page = "failed";
        if (Number.isInteger(code) && code >= -2147483648 && code <= 2147483647) this.rendering.loadErrorCode = code;
      }
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (!current()) return;
      this.rendering.renderer = "gone";
      if (Number.isInteger(details.exitCode) && details.exitCode >= -2147483648 && details.exitCode <= 2147483647) this.rendering.rendererExitCode = details.exitCode;
    });
    window.on("responsive", () => { if (current()) this.rendering.renderer = "responsive"; });
    window.on("unresponsive", () => { if (current()) this.rendering.renderer = "unresponsive"; });
    const webRequest = window.webContents.session.webRequest;
    this.authorizationRequest = webRequest;
    try {
      webRequest.onBeforeSendHeaders(
        { urls: [`${options.url}/*`] },
        (details, callback) => {
          callback({
            requestHeaders: {
              ...details.requestHeaders,
              Authorization: `Bearer ${options.token}`
            }
          });
        }
      );
      this.authorizationRegistered = true;
      window.webContents.on("will-navigate", (event, url) => {
        try {
          if (new URL(url).origin === allowedOrigin) return;
        } catch {
          // Invalid navigation targets are denied with external targets.
        }
        event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.on("close", (event) => {
        if (this.dependencies.quitting()) return;
        event.preventDefault();
        this.hide();
      });
      window.on("closed", () => {
        if (this.window !== window) return;
        this.contentProbe?.dispose();
        this.contentProbe = undefined;
        this.detachAuthorization();
        this.window = undefined;
      });
      window.setAlwaysOnTop(true, "floating");
      window.once("ready-to-show", () => {
        if (this.window !== window || this.dependencies.quitting()) return;
        this.rendering.readyToShow = true;
        this.fitWindow();
        if (!this.manuallyHidden) this.show();
      });
      this.unwatchDisplays = this.dependencies.watchDisplays?.(() => this.fitWindow());
      this.fitWindow();
      await window.loadURL(options.url);
    } catch (error) {
      this.release(window);
      throw error;
    }
  }

  show(): void {
    if (this.dependencies.quitting()) return;
    this.manuallyHidden = false;
    if (this.window === undefined || this.window.isDestroyed() || this.window.isVisible()) return;
    this.window.showInactive();
  }

  hide(): void {
    this.manuallyHidden = true;
    if (this.window === undefined || this.window.isDestroyed()) return;
    this.window.hide();
  }

  selectTask(taskId: string | null, options: SelectedTaskVisibility = {}): void {
    this.selectedTaskId = taskId;
  }

  hideSelectedTask(): void {
    if (this.selectedTaskId !== null) {
      try {
        void Promise.resolve(this.dependencies.onHideSelectedTask?.(this.selectedTaskId)).catch(() => undefined);
      } catch {
        // A close event must still hide the window if the mutation cannot start.
      }
    }
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.hide();
  }

  onTaskActivity(taskId: string, options: { isNewTask?: boolean; terminal?: boolean; hiddenForTask?: boolean } = {}): void {
    if (options.terminal || !options.isNewTask || options.hiddenForTask || this.selectedTaskId === taskId) return;
    this.selectedTaskId = taskId;
    if (!this.manuallyHidden) this.show();
  }

  updateRows(rows: number, revision: number): void {
    if (!Number.isInteger(rows) || rows < 0 || rows > 32 ||
        !Number.isSafeInteger(revision) || revision < this.layoutRevision) return;
    this.rows = rows;
    this.layoutRevision = revision;
    this.fitWindow();
  }

  private fitWindow(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || this.dependencies.quitting() ||
        !window.getBounds || !window.setBounds || !this.dependencies.workAreaFor) return;
    const current = window.getBounds();
    const bounds = hudBounds(current, this.dependencies.workAreaFor(current), this.rows);
    if (Object.keys(bounds).some(key => bounds[key as keyof HudRectangle] !== current[key as keyof HudRectangle])) {
      window.setBounds(bounds);
    }
  }

  visibility(): "visible" | "hidden" {
    return this.window !== undefined && !this.window.isDestroyed() && this.window.isVisible()
      ? "visible"
      : "hidden";
  }

  diagnostics(): WindowDiagnostics {
    const exists = this.window !== undefined && !this.window.isDestroyed();
    if (exists && this.rendering.page === 'loaded' && !this.dependencies.quitting()) this.contentProbe?.start();
    return windowDiagnosticsSchema.parse({
      ...this.rendering, exists, visible: exists && this.window!.isVisible(),
      content: this.contentProbe?.snapshot(),
      ...(exists && this.window!.getBounds ? { bounds: this.window!.getBounds() } : {})
    });
  }

  dispose(): void {
    const window = this.window;
    if (window !== undefined) this.release(window);
  }

  private detachAuthorization(): void {
    this.unwatchDisplays?.();
    this.unwatchDisplays = undefined;
    const webRequest = this.authorizationRequest;
    this.authorizationRequest = undefined;
    if (!this.authorizationRegistered) return;
    this.authorizationRegistered = false;
    webRequest?.onBeforeSendHeaders(null);
  }

  private release(window: BrowserWindowLike): void {
    if (this.window !== window) return;
    this.contentProbe?.dispose();
    this.contentProbe = undefined;
    this.detachAuthorization();
    this.window = undefined;
    if (!window.isDestroyed()) window.destroy();
  }
}
