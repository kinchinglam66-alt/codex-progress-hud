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
    session: {
      webRequest: {
        onBeforeSendHeaders: vi.fn()
      }
    }
  };
  private visible = false;
  private destroyed = false;

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

    expect(options).toMatchObject({
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
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
});
