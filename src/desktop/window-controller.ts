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
}

export interface WindowControllerDependencies {
  createWindow(options: BrowserWindowOptionsLike): BrowserWindowLike;
  quitting(): boolean;
  onHideSelectedTask?(taskId: string): void | Promise<void>;
}

export interface WindowCreateOptions {
  url: string;
  token: string;
}

const WINDOW_OPTIONS: BrowserWindowOptionsLike = {
  width: 340,
  height: 146,
  minWidth: 300,
  minHeight: 130,
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
    partition: "codex-progress-hud"
  }
};

export class WindowController {
  private window: BrowserWindowLike | undefined;
  private authorizationRequest: BrowserWindowLike["webContents"]["session"]["webRequest"] | undefined;
  private authorizationRegistered = false;
  private selectedTaskId: string | null = null;

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
        this.hideSelectedTask();
      });
      window.on("closed", () => {
        if (this.window !== window) return;
        this.detachAuthorization();
        this.window = undefined;
      });
      window.setAlwaysOnTop(true, "floating");
      window.once("ready-to-show", () => this.show());
      await window.loadURL(options.url);
    } catch (error) {
      this.release(window);
      throw error;
    }
  }

  show(): void {
    if (this.window === undefined || this.window.isDestroyed() || this.window.isVisible()) return;
    this.window.showInactive();
  }

  hide(): void {
    if (this.window === undefined || this.window.isDestroyed() || !this.window.isVisible()) return;
    this.window.hide();
  }

  selectTask(taskId: string | null): void {
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
    this.show();
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
