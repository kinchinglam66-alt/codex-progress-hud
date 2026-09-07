import { hudBounds, type HudRectangle } from "./hud-layout.js";

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
        this.detachAuthorization();
        this.window = undefined;
      });
      window.setAlwaysOnTop(true, "floating");
      window.once("ready-to-show", () => {
        if (this.window !== window || this.dependencies.quitting()) return;
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
    this.detachAuthorization();
    this.window = undefined;
    if (!window.isDestroyed()) window.destroy();
  }
}
