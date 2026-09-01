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
  };
}

export interface WindowCloseEventLike {
  preventDefault(): void;
}

export interface BrowserWindowLike {
  webContents: {
    session: {
      webRequest: {
        onBeforeSendHeaders(
          filter: { urls: string[] },
          listener: (
            details: { requestHeaders: Record<string, string> },
            callback: (response: { requestHeaders: Record<string, string> }) => void
          ) => void
        ): void;
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
    sandbox: true
  }
};

export class WindowController {
  private window: BrowserWindowLike | undefined;

  constructor(private readonly dependencies: WindowControllerDependencies) {}

  async create(options: WindowCreateOptions): Promise<void> {
    if (this.window !== undefined && !this.window.isDestroyed()) return;

    const window = this.dependencies.createWindow(WINDOW_OPTIONS);
    this.window = window;
    window.webContents.session.webRequest.onBeforeSendHeaders(
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
    window.on("close", (event) => {
      if (this.dependencies.quitting()) return;
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    window.setAlwaysOnTop(true, "floating");
    window.once("ready-to-show", () => this.show());
    await window.loadURL(options.url);
  }

  show(): void {
    if (this.window === undefined || this.window.isDestroyed() || this.window.isVisible()) return;
    this.window.showInactive();
  }

  hide(): void {
    if (this.window === undefined || this.window.isDestroyed() || !this.window.isVisible()) return;
    this.window.hide();
  }

  visibility(): "visible" | "hidden" {
    return this.window !== undefined && !this.window.isDestroyed() && this.window.isVisible()
      ? "visible"
      : "hidden";
  }

  dispose(): void {
    const window = this.window;
    this.window = undefined;
    if (window !== undefined && !window.isDestroyed()) window.destroy();
  }
}
