import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  WindowController,
  type BrowserWindowOptionsLike
} from "../../src/desktop/window-controller.js";

class FakeWindow extends EventEmitter {
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly showInactive = vi.fn(() => {
    this.visible = true;
  });
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });
  readonly loadURL = vi.fn(async () => undefined);
  readonly setAlwaysOnTop = vi.fn();
  readonly webContents = {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      this.webContentsListeners.set(event, listener);
    }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: "deny" | "allow" }) => {
      this.windowOpenHandler = handler;
    }),
    session: {
      webRequest: {
        onBeforeSendHeaders: vi.fn()
      }
    }
  };
  private visible = false;
  private destroyed = false;
  readonly webContentsListeners = new Map<string, (...args: any[]) => void>();
  windowOpenHandler: ((details: { url: string }) => { action: "deny" | "allow" }) | undefined;

  isVisible(): boolean {
    return this.visible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

describe("WindowController", () => {
  it("creates the overlay with the required Electron security and rendering options", async () => {
    const window = new FakeWindow();
    let options: BrowserWindowOptionsLike | undefined;
    const controller = new WindowController({
      createWindow: (received) => {
        options = received;
        return window;
      },
      quitting: () => false
    });

    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });

    expect(options).toEqual({
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
    });
  });

  it("loads an exact loopback origin and denies external navigation and every popup", async () => {
    const window = new FakeWindow();
    const controller = new WindowController({ createWindow: () => window, quitting: () => false });

    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });
    const localEvent = { preventDefault: vi.fn() };
    const externalEvent = { preventDefault: vi.fn() };
    window.webContentsListeners.get("will-navigate")?.(localEvent, "http://127.0.0.1:17837/styles.css");
    window.webContentsListeners.get("will-navigate")?.(externalEvent, "https://example.com/private");

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:17837");
    expect(localEvent.preventDefault).not.toHaveBeenCalled();
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.windowOpenHandler?.({ url: "http://127.0.0.1:17837/popup" })).toEqual({ action: "deny" });
    expect(window.windowOpenHandler?.({ url: "https://example.com" })).toEqual({ action: "deny" });
  });

  it.each([
    "https://127.0.0.1:17837",
    "http://localhost:17837",
    "http://example.com:17837",
    "http://127.0.0.1:17837/path",
    "http://127.0.0.1:17837?query=1"
  ])("rejects a non-exact loopback initial URL: %s", async (url) => {
    const controller = new WindowController({ createWindow: () => new FakeWindow(), quitting: () => false });

    await expect(controller.create({ url, token: "secret" })).rejects.toThrow("loopback origin");
  });

  it("hides rather than destroys on window close", async () => {
    const window = new FakeWindow();
    const controller = new WindowController({
      createWindow: () => window,
      quitting: () => false
    });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });
    const event = { preventDefault: vi.fn() };

    window.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
  });

  it("permits destruction while the app is quitting", async () => {
    const window = new FakeWindow();
    const controller = new WindowController({
      createWindow: () => window,
      quitting: () => true
    });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });
    const event = { preventDefault: vi.fn() };

    window.emit("close", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
  });

  it("shows idempotently", async () => {
    const window = new FakeWindow();
    const controller = new WindowController({
      createWindow: () => window,
      quitting: () => false
    });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });

    controller.show();
    controller.show();

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(controller.visibility()).toBe("visible");
  });

  it("hides only the selected task and does not reopen while the server says it is hidden", async () => {
    const window = new FakeWindow();
    const controller = new WindowController({ createWindow: () => window, quitting: () => false });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });
    controller.selectTask("task-a");
    controller.hideSelectedTask();
    controller.onTaskActivity("task-a", { isNewTask: true, hiddenForTask: true });

    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it("delegates X-hide to the revisioned visibility mutation handler", async () => {
    const window = new FakeWindow();
    const hideSelectedTask = vi.fn(async () => undefined);
    const controller = new WindowController({
      createWindow: () => window,
      quitting: () => false,
      onHideSelectedTask: hideSelectedTask
    });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });
    controller.selectTask("task-a");

    window.emit("close", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(hideSelectedTask).toHaveBeenCalledWith("task-a"));
  });

  it("shows a different new task once without stealing focus for terminal notifications", async () => {
    const window = new FakeWindow();
    const controller = new WindowController({ createWindow: () => window, quitting: () => false });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });
    controller.selectTask("task-a");
    controller.hideSelectedTask();
    controller.onTaskActivity("task-b", { isNewTask: true });
    controller.onTaskActivity("task-b", { terminal: true });

    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it("unregisters authorization interception before destroying the window", async () => {
    const order: string[] = [];
    const window = new FakeWindow();
    window.webContents.session.webRequest.onBeforeSendHeaders.mockImplementation(
      (...args: unknown[]) => {
        if (args.length === 1 && args[0] === null) order.push("detach");
      }
    );
    window.destroy.mockImplementation(() => {
      order.push("destroy");
    });
    const controller = new WindowController({
      createWindow: () => window,
      quitting: () => true
    });
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });

    controller.dispose();

    expect(order).toEqual(["detach", "destroy"]);
  });

  it("cleans up a failed create so a later create can retry", async () => {
    const failure = new Error("load failed");
    const firstWindow = new FakeWindow();
    firstWindow.loadURL.mockRejectedValue(failure);
    const secondWindow = new FakeWindow();
    const createWindow = vi.fn()
      .mockReturnValueOnce(firstWindow)
      .mockReturnValueOnce(secondWindow);
    const controller = new WindowController({ createWindow, quitting: () => false });

    await expect(
      controller.create({ url: "http://127.0.0.1:17837", token: "secret" })
    ).rejects.toBe(failure);
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });

    expect(firstWindow.webContents.session.webRequest.onBeforeSendHeaders)
      .toHaveBeenLastCalledWith(null);
    expect(firstWindow.destroy).toHaveBeenCalledOnce();
    expect(secondWindow.loadURL).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("cleans up when authorization registration fails so create can retry", async () => {
    const failure = new Error("registration failed");
    const firstWindow = new FakeWindow();
    firstWindow.webContents.session.webRequest.onBeforeSendHeaders.mockImplementationOnce(
      () => { throw failure; }
    );
    const secondWindow = new FakeWindow();
    const createWindow = vi.fn()
      .mockReturnValueOnce(firstWindow)
      .mockReturnValueOnce(secondWindow);
    const controller = new WindowController({ createWindow, quitting: () => false });

    await expect(
      controller.create({ url: "http://127.0.0.1:17837", token: "secret" })
    ).rejects.toBe(failure);
    await controller.create({ url: "http://127.0.0.1:17837", token: "secret" });

    expect(firstWindow.destroy).toHaveBeenCalledOnce();
    expect(firstWindow.webContents.session.webRequest.onBeforeSendHeaders)
      .toHaveBeenCalledOnce();
    expect(secondWindow.loadURL).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });
});
