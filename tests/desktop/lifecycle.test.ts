import { describe, expect, it, vi } from "vitest";
import {
  runDesktop,
  scheduleAfterReady,
  type DesktopDependencies
} from "../../src/desktop/lifecycle.js";

function desktopHarness(lockAcquired = true) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const order: string[] = [];
  const windowController = {
    create: vi.fn(async () => undefined),
    show: vi.fn(),
    hide: vi.fn(),
    visibility: vi.fn(() => "hidden" as const),
    dispose: vi.fn()
  };
  let trayCallbacks: Parameters<DesktopDependencies["createTrayController"]>[0] | undefined;
  let serverOptions: Parameters<DesktopDependencies["createProgressServer"]>[0] | undefined;
  const dependencies: DesktopDependencies = {
    app: {
      requestSingleInstanceLock: vi.fn(() => lockAcquired),
      whenReady: vi.fn(async () => undefined),
      on: vi.fn((event, callback) => listeners.set(event, callback)),
      quit: vi.fn(() => order.push("quit")),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn(),
      getVersion: vi.fn(() => "0.1.0")
    },
    createWindowController: vi.fn(() => windowController),
    createTray: vi.fn(() => ({ setContextMenu: vi.fn(), destroy: vi.fn() })),
    buildMenu: vi.fn(() => ({})),
    createTrayController: vi.fn((callbacks) => {
      trayCallbacks = callbacks;
      return { dispose: vi.fn() };
    }),
    createProgressServer: vi.fn((options) => {
      serverOptions = options;
      return {
        listen: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        address: vi.fn(() => ({
          host: "127.0.0.1",
          port: 17_837,
          url: "http://127.0.0.1:17837"
        }))
      };
    }),
    stateStore: {
      readSettings: vi.fn(async () => ({ startWithWindows: false })),
      setDesiredState: vi.fn(async (state) => {
        order.push(`desired:${state}`);
        return { desiredState: state, startWithWindows: false };
      }),
      writeRuntime: vi.fn(async () => undefined),
      readRuntime: vi.fn(async () => null),
      clearRuntime: vi.fn(async () => undefined),
      readInstallManifest: vi.fn(async () => null)
    },
    readToken: vi.fn(async () => "secret"),
    randomUUID: vi.fn(() => "instance-nonce"),
    now: vi.fn(() => new Date("2026-09-02T00:00:00.000Z")),
    pid: 12_345,
    tokenPath: "C:\\hud\\auth.token",
    uiDirectory: "C:\\hud\\ui",
    port: 17_837,
    diagnose: vi.fn(async () => undefined)
  };
  return {
    dependencies,
    listeners,
    order,
    windowController,
    get trayCallbacks() { return trayCallbacks; },
    get serverOptions() { return serverOptions; }
  };
}

describe("desktop lifecycle", () => {
  it("finishes module setup before starting the window after readiness", async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const startWindow = vi.fn();

    expect(scheduleAfterReady(ready, startWindow)).toBeUndefined();
    expect(startWindow).not.toHaveBeenCalled();

    markReady();
    await ready;
    await Promise.resolve();

    expect(startWindow).toHaveBeenCalledOnce();
  });

  it("quits before creating the server when the GUI single-instance lock fails", async () => {
    const harness = desktopHarness(false);

    await runDesktop(harness.dependencies);

    expect(harness.dependencies.app.quit).toHaveBeenCalledOnce();
    expect(harness.dependencies.createProgressServer).not.toHaveBeenCalled();
    expect(harness.dependencies.stateStore.writeRuntime).not.toHaveBeenCalled();
  });

  it("shows the existing window when a second GUI instance starts", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    harness.listeners.get("second-instance")?.();

    expect(harness.windowController.show).toHaveBeenCalledOnce();
  });

  it("writes runtime identity on readiness and exposes it through server controls", async () => {
    const harness = desktopHarness();

    await runDesktop(harness.dependencies);

    expect(harness.dependencies.stateStore.writeRuntime).toHaveBeenCalledWith({
      pid: 12_345,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "instance-nonce",
      startedAt: "2026-09-02T00:00:00.000Z"
    });
    expect(harness.serverOptions?.health?.()).toEqual({
      service: "codex-progress-hud",
      pid: 12_345,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "instance-nonce",
      startedAt: "2026-09-02T00:00:00.000Z",
      visibility: "hidden"
    });
  });

  it("records the runtime start time only after Electron readiness", async () => {
    const harness = desktopHarness();
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    vi.mocked(harness.dependencies.app.whenReady).mockReturnValue(ready);

    const starting = runDesktop(harness.dependencies);
    expect(harness.dependencies.now).not.toHaveBeenCalled();

    markReady();
    await starting;

    expect(harness.dependencies.now).toHaveBeenCalledOnce();
  });

  it("connects authenticated HTTP controls to the window and clean shutdown", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    await harness.serverOptions?.showWindow?.();
    await harness.serverOptions?.hideWindow?.();
    await harness.serverOptions?.requestShutdown?.();

    expect(harness.windowController.show).toHaveBeenCalledOnce();
    expect(harness.windowController.hide).toHaveBeenCalledOnce();
    expect(harness.dependencies.app.quit).toHaveBeenCalledOnce();
  });

  it("sets desired state off before tray Exit quits", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    await harness.trayCallbacks?.onExit();

    expect(harness.order).toEqual(["desired:off", "quit"]);
  });

  it("updates the per-user login item only after an explicit tray click", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    expect(harness.dependencies.app.setLoginItemSettings).not.toHaveBeenCalled();
    await harness.trayCallbacks?.onToggleLogin(true);

    expect(harness.dependencies.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true
    });
  });

  it("clears runtime identity during clean exit", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);
    const event = { preventDefault: vi.fn() };

    await harness.listeners.get("before-quit")?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
    expect(harness.dependencies.app.quit).toHaveBeenCalledOnce();
  });
});
