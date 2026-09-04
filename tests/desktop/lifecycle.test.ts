import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationalLogEntry } from "../../src/diagnostics/logger.js";
import {
  runDesktop,
  scheduleAfterReady,
  type DesktopDependencies
} from "../../src/desktop/lifecycle.js";
import { createCompanionManager } from "../../src/lifecycle/companion-manager.js";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import type { HudHealth, LifecycleStateStore } from "../../src/lifecycle/types.js";
import { HudClientError } from "../../src/mcp/report-client.js";
import { EventEmitter } from "node:events";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function desktopHarness(lockAcquired = true) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const order: string[] = [];
  let isQuitting = () => false;
  const windowController = {
    create: vi.fn(async () => undefined),
    show: vi.fn(),
    hide: vi.fn(),
    selectTask: vi.fn(),
    onTaskActivity: vi.fn(),
    visibility: vi.fn(() => "hidden" as const),
    dispose: vi.fn()
  };
  const trayController = { dispose: vi.fn(), updateTasks: vi.fn() };
  const storeEvents = new EventEmitter();
  let taskSnapshot = { revision: 0, selectedTaskId: null as string | null, tasks: [] as Array<{ id: string; title: string; status: string; lastActivityAt: number; hiddenForTask: boolean }> };
  const taskStore = {
    snapshot: () => taskSnapshot,
    select: vi.fn(),
    on: (event: "changed", listener: (snapshot: unknown) => void) => storeEvents.on(event, listener)
  };
  const progressServer = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    address: vi.fn(() => ({
      host: "127.0.0.1",
      port: 17_837,
      url: "http://127.0.0.1:17837"
    })),
    store: taskStore
  };
  let trayCallbacks: Parameters<DesktopDependencies["createTrayController"]>[0] | undefined;
  let serverOptions: Parameters<DesktopDependencies["createProgressServer"]>[0] | undefined;
  const dependencies: DesktopDependencies = {
    app: {
      requestSingleInstanceLock: vi.fn(() => lockAcquired),
      releaseSingleInstanceLock: vi.fn(() => order.push("release-singleton")),
      whenReady: vi.fn(async () => undefined),
      on: vi.fn((event, callback) => listeners.set(event, callback)),
      quit: vi.fn(() => order.push("quit")),
      getVersion: vi.fn(() => "0.1.0")
    },
    createWindowController: vi.fn((options) => {
      isQuitting = options.quitting;
      return windowController;
    }),
    createTrayImage: vi.fn(() => ({ isEmpty: () => false })),
    createTray: vi.fn(() => ({ setContextMenu: vi.fn(), destroy: vi.fn() })),
    buildMenu: vi.fn(() => ({})),
    createTrayController: vi.fn((callbacks) => {
      trayCallbacks = callbacks;
      return trayController;
    }),
    createProgressServer: vi.fn((options) => {
      serverOptions = options;
      return progressServer;
    }),
    stateStore: {
      readSettings: vi.fn(async () => ({ desiredState: "on" as const, startWithWindows: false, generation: 1 })),
      setDesiredState: vi.fn(async (state) => {
        order.push(`desired:${state}`);
        return { desiredState: state, startWithWindows: false, generation: 1 };
      }),
      setStartWithWindows: vi.fn(async (enabled) => ({ startWithWindows: enabled, generation: 0 })),
      writeRuntime: vi.fn(async () => true),
      readRuntime: vi.fn(async () => null),
      clearRuntime: vi.fn(async () => undefined),
      clearRuntimeIfGeneration: vi.fn(async () => true),
      readInstallManifest: vi.fn(async () => null),
      runIfGeneration: vi.fn(async (_generation, _state, operation) => ({
        accepted: true as const,
        value: await operation(new AbortController().signal)
      }))
    },
    readToken: vi.fn(async () => "secret"),
    randomUUID: vi.fn(() => "instance-nonce"),
    now: vi.fn(() => new Date("2026-09-02T00:00:00.000Z")),
    pid: 12_345,
    tokenPath: "C:\\hud\\auth.token",
    uiDirectory: "C:\\hud\\ui",
    port: 17_837,
    diagnose: vi.fn(async () => undefined),
    operationalLogger: { write: vi.fn(async () => undefined) },
    reportError: vi.fn(),
    cleanupTimeoutMs: 25,
    withTimeout: vi.fn(async (operation) => operation)
  };
  return {
    dependencies,
    listeners,
    order,
    windowController,
    trayController,
    progressServer,
    isQuitting: () => isQuitting(),
    get trayCallbacks() { return trayCallbacks; },
    get serverOptions() { return serverOptions; }
    ,publishTaskSnapshot(snapshot: typeof taskSnapshot) {
      taskSnapshot = snapshot;
      storeEvents.emit("changed", snapshot);
    }
  };
}

type DesktopHarness = ReturnType<typeof desktopHarness>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function realStateStores() {
  const directory = await mkdtemp(join(tmpdir(), "hud-desktop-publication-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    settingsPath: join(directory, "settings.json"),
    runtimePath: join(directory, "runtime.json"),
    installManifestPath: join(directory, "install.json")
  };
  const desktopStore = createLifecycleStateStore(paths);
  const closingStore = createLifecycleStateStore(paths);
  await desktopStore.setDesiredState("on");
  return { directory, paths, desktopStore, closingStore };
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
    expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
  });

  it("ignores explicit second-instance activation after quit cleanup begins", async () => {
    const harness = desktopHarness();
    const cleanupGate = deferred<void>();
    harness.progressServer.close.mockImplementation(async () => {
      await cleanupGate.promise;
      return undefined;
    });
    await runDesktop(harness.dependencies);
    vi.mocked(harness.dependencies.stateStore.setDesiredState).mockClear();

    const event = { preventDefault: vi.fn() };
    harness.listeners.get("before-quit")?.(event);
    harness.listeners.get("second-instance")?.({}, ["app.exe", "--hud"]);
    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.order[0]).toBe("release-singleton");
    expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
    expect(harness.windowController.show).not.toHaveBeenCalled();

    cleanupGate.resolve();
    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalledOnce());
  });

  it("keeps the shutdown listener reachable when singleton release fails", async () => {
    const harness = desktopHarness();
    const failure = new Error("singleton release failed");
    vi.mocked(harness.dependencies.app.releaseSingleInstanceLock).mockImplementation(() => {
      throw failure;
    });
    await runDesktop(harness.dependencies);

    const event = { preventDefault: vi.fn() };
    harness.listeners.get("before-quit")?.(event);
    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalledOnce());

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.progressServer.close).not.toHaveBeenCalled();
    expect(harness.dependencies.reportError).toHaveBeenCalledWith(
      failure,
      "desktop cleanup: singleton release"
    );
  });

  it("shows the existing window when a second GUI instance has explicit intent", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    harness.listeners.get("second-instance")?.({}, ["app.exe", "--hud"]);

    await vi.waitFor(() => expect(harness.windowController.show).toHaveBeenCalledOnce());
    expect(harness.dependencies.stateStore.setDesiredState).toHaveBeenCalledWith("on");
  });

  it("does not show for a second-instance on generation superseded by another store", async () => {
    const harness = desktopHarness();
    const { desktopStore, closingStore } = await realStateStores();
    const activationCommitted = deferred<number>();
    const allowActivationReturn = deferred<void>();
    const activationGuardComplete = deferred<void>();
    let activation: ReturnType<LifecycleStateStore["setDesiredState"]> | undefined;
    const activationStore: LifecycleStateStore = {
      ...desktopStore,
      setDesiredState: (state, options) => {
        const pending = (async () => {
          const settings = await desktopStore.setDesiredState(state, options);
          if (state === "on") {
            activationCommitted.resolve(settings.generation);
            await allowActivationReturn.promise;
          }
          return settings;
        })();
        if (state === "on") activation = pending;
        return pending;
      },
      runIfGeneration: async (generation, desiredState, operation, options) => {
        const result = await desktopStore.runIfGeneration(
          generation,
          desiredState,
          operation,
          options
        );
        activationGuardComplete.resolve();
        return result;
      }
    };
    harness.dependencies.stateStore = activationStore;
    await runDesktop(harness.dependencies, { kind: "manager", generation: 1 });
    await closingStore.setDesiredState("off");

    harness.listeners.get("second-instance")?.({}, ["app.exe", "--hud"]);
    const activationGeneration = await activationCommitted.promise;
    const closingSettings = await closingStore.setDesiredState("off");
    expect(closingSettings.generation).toBe(activationGeneration + 1);

    allowActivationReturn.resolve();
    await activation;
    await Promise.resolve();
    expect(harness.windowController.show).not.toHaveBeenCalled();
    await activationGuardComplete.promise;
    expect(await closingStore.readSettings()).toMatchObject({
      desiredState: "off",
      generation: closingSettings.generation
    });
  });

  it("does not show for a second-instance activation resumed after shutdown begins", async () => {
    const harness = desktopHarness();
    const { desktopStore, closingStore } = await realStateStores();
    const activationCommitted = deferred<void>();
    const allowActivationReturn = deferred<void>();
    let activation: ReturnType<LifecycleStateStore["setDesiredState"]> | undefined;
    harness.dependencies.stateStore = {
      ...desktopStore,
      setDesiredState: (state, options) => {
        const pending = (async () => {
          const settings = await desktopStore.setDesiredState(state, options);
          if (state === "on") {
            activationCommitted.resolve();
            await allowActivationReturn.promise;
          }
          return settings;
        })();
        if (state === "on") activation = pending;
        return pending;
      }
    };
    await runDesktop(harness.dependencies, { kind: "manager", generation: 1 });
    await closingStore.setDesiredState("off");

    harness.listeners.get("second-instance")?.({}, ["app.exe", "--hud"]);
    await activationCommitted.promise;
    const event = { preventDefault: vi.fn() };
    harness.listeners.get("before-quit")?.(event);
    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalledOnce());

    allowActivationReturn.resolve();
    await activation;
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.windowController.show).not.toHaveBeenCalled();
  });

  it("does not reinterpret a manager-launched second instance as explicit activation", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    harness.listeners.get("second-instance")?.(
      {},
      ["app.exe", "--hud", "--manager-generation=7"]
    );

    await Promise.resolve();
    expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
    expect(harness.windowController.show).not.toHaveBeenCalled();
  });

  it("explicit activation reopens persisted off before publishing runtime", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.stateStore.readSettings).mockResolvedValue({
      desiredState: "off",
      startWithWindows: false,
      generation: 8
    });

    await runDesktop(harness.dependencies, { kind: "explicit" });

    expect(harness.dependencies.stateStore.setDesiredState).toHaveBeenCalledWith("on");
    expect(harness.dependencies.stateStore.writeRuntime).toHaveBeenCalledWith(
      expect.any(Object),
      1
    );
  });

  it("manager launch cannot reopen or publish after manual off wins", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.stateStore.readSettings).mockResolvedValue({
      desiredState: "off",
      startWithWindows: false,
      generation: 8
    });

    await runDesktop(harness.dependencies, { kind: "manager", generation: 7 });

    expect(harness.dependencies.app.quit).toHaveBeenCalledOnce();
    expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
    expect(harness.dependencies.stateStore.writeRuntime).not.toHaveBeenCalled();
    expect(harness.dependencies.createProgressServer).not.toHaveBeenCalled();
  });

  it("manager launch cannot publish under a superseded on generation", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.stateStore.readSettings).mockResolvedValue({
      desiredState: "on",
      startWithWindows: false,
      generation: 8
    });

    await runDesktop(harness.dependencies, { kind: "manager", generation: 7 });

    expect(harness.dependencies.app.quit).toHaveBeenCalledOnce();
    expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
    expect(harness.dependencies.stateStore.writeRuntime).not.toHaveBeenCalled();
    expect(harness.dependencies.createProgressServer).not.toHaveBeenCalled();
  });

  it("manager launch publishes runtime only under its matching on generation", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.stateStore.readSettings).mockResolvedValue({
      desiredState: "on",
      startWithWindows: false,
      generation: 7
    });

    await runDesktop(harness.dependencies, { kind: "manager", generation: 7 });

    expect(harness.dependencies.stateStore.setDesiredState).not.toHaveBeenCalled();
    expect(harness.dependencies.stateStore.writeRuntime).toHaveBeenCalledWith(
      expect.any(Object),
      7
    );
    expect(harness.dependencies.createProgressServer).toHaveBeenCalledOnce();
  });

  it("publishes nothing when off commits after runtime but before the readiness guard", async () => {
    const harness = desktopHarness();
    const { desktopStore, closingStore } = await realStateStores();
    const runtimeWritten = deferred<void>();
    const allowRuntimeReturn = deferred<void>();
    const writeRuntime = vi.fn<LifecycleStateStore["writeRuntime"]>(async (...arguments_) => {
      const written = await desktopStore.writeRuntime(...arguments_);
      runtimeWritten.resolve();
      await allowRuntimeReturn.promise;
      return written;
    });
    harness.dependencies.stateStore = { ...desktopStore, writeRuntime };

    const starting = runDesktop(harness.dependencies, { kind: "manager", generation: 1 });
    await runtimeWritten.promise;
    await closingStore.setDesiredState("off");
    allowRuntimeReturn.resolve();
    await starting;

    expect(harness.dependencies.createProgressServer).not.toHaveBeenCalled();
    expect(harness.progressServer.listen).not.toHaveBeenCalled();
    expect(harness.windowController.create).not.toHaveBeenCalled();
    expect(harness.dependencies.createTray).not.toHaveBeenCalled();
    expect(
      vi.mocked(harness.dependencies.operationalLogger!.write).mock.calls
        .some(([entry]) => entry.event === "startup_ready")
    ).toBe(false);
    expect(await closingStore.readRuntime()).toBeNull();
  });

  it("lets close observe the complete instance when the readiness guard wins first", async () => {
    const harness = desktopHarness();
    const { directory, paths, desktopStore, closingStore } = await realStateStores();
    const guardEntered = deferred<void>();
    const allowReadiness = deferred<void>();
    const guardedStore: LifecycleStateStore = {
      ...desktopStore,
      runIfGeneration: (generation, desiredState, operation, options) =>
        desktopStore.runIfGeneration(generation, desiredState, async (signal) => {
          guardEntered.resolve();
          await allowReadiness.promise;
          return operation(signal);
        }, options)
    };
    harness.dependencies.stateStore = guardedStore;
    let online = true;
    let observedCompleteInstance = false;
    const health: HudHealth = {
      service: "codex-progress-hud",
      pid: 12_345,
      version: "0.1.0",
      protocolVersion: 1,
      visibility: "hidden",
      instanceNonce: "instance-nonce",
      startedAt: "2026-09-02T00:00:00.000Z"
    };
    const closingManager = createCompanionManager({
      store: closingStore,
      client: {
        identity: vi.fn(async () => ({ service: "codex-progress-hud" as const, protocolVersion: 1 as const })),
        health: vi.fn(async () => {
          if (!online) throw new HudClientError("OFFLINE", "stopped");
          observedCompleteInstance =
            harness.progressServer.listen.mock.calls.length === 1 &&
            harness.windowController.create.mock.calls.length === 1 &&
            vi.mocked(harness.dependencies.createTray).mock.calls.length === 1 &&
            vi.mocked(harness.dependencies.operationalLogger!.write).mock.calls
              .some(([entry]) => entry.event === "startup_ready");
          return health;
        }),
        show: vi.fn(async () => undefined),
        hide: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => { online = false; })
      },
      launcher: { spawnHud: vi.fn() },
      sleep: async () => undefined,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(directory, "diagnostics"),
        pluginVersion: "0.1.0",
        mcpVersion: "0.1.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: paths.installManifestPath,
        dataDirectoryPath: directory
      }
    });

    const starting = runDesktop(harness.dependencies, { kind: "manager", generation: 1 });
    await Promise.race([
      guardEntered.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("readiness guard was not entered")), 300)
      )
    ]);
    let closeSettled = false;
    const closing = closingManager.close().then((result) => {
      closeSettled = true;
      return result;
    });
    await new Promise((resolve_) => setTimeout(resolve_, 25));
    expect(closeSettled).toBe(false);

    allowReadiness.resolve();
    await starting;
    await expect(closing).resolves.toEqual({ desiredState: "off", observedState: "stopped" });

    expect(observedCompleteInstance).toBe(true);
    expect(await closingStore.readRuntime()).toBeNull();
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
    }, 1);
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

  it("records desktop startup using category-only entries", async () => {
    const harness = desktopHarness();

    await runDesktop(harness.dependencies);

    expect(vi.mocked(harness.dependencies.operationalLogger!.write).mock.calls.map(([entry]) => entry)).toEqual([
      {
        at: "2026-09-02T00:00:00.000Z",
        level: "info",
        event: "startup_requested",
        lifecycleState: "starting",
        protocolVersion: 1
      },
      {
        at: "2026-09-02T00:00:00.000Z",
        level: "info",
        event: "startup_ready",
        lifecycleState: "hidden",
        protocolVersion: 1,
        elapsedMs: 0
      }
    ]);
  });

  it("does not wait for a permanently pending logger before desktop startup", async () => {
    const harness = desktopHarness();
    harness.dependencies.operationalLogger = {
      write: vi.fn(() => new Promise<void>(() => undefined))
    };

    await expect(Promise.race([
      runDesktop(harness.dependencies),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("desktop startup waited for logger")), 100)
      )
    ])).resolves.toBeUndefined();

    expect(harness.dependencies.createProgressServer).toHaveBeenCalledOnce();
  });

  it("records real desktop startup elapsed time", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.now)
      .mockReturnValueOnce(new Date("2026-09-02T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-09-02T00:00:00.275Z"));

    await runDesktop(harness.dependencies);

    expect(harness.dependencies.operationalLogger!.write).toHaveBeenLastCalledWith({
      at: "2026-09-02T00:00:00.275Z",
      level: "info",
      event: "startup_ready",
      lifecycleState: "hidden",
      protocolVersion: 1,
      elapsedMs: 275
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

    expect(harness.dependencies.now).toHaveBeenCalledTimes(2);
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

  it("wires task activity to the window and projects selectedTaskId into tray state", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    harness.publishTaskSnapshot({
      revision: 1,
      selectedTaskId: "task-b",
      tasks: [
        { id: "task-a", title: "Alpha", status: "running", lastActivityAt: 90, hiddenForTask: false },
        { id: "task-b", title: "Beta", status: "running", lastActivityAt: 100, hiddenForTask: false }
      ]
    });

    expect(harness.windowController.selectTask).toHaveBeenCalledWith("task-b");
    expect(harness.windowController.onTaskActivity).toHaveBeenCalledWith("task-a", {
      isNewTask: true,
      terminal: false,
      hiddenForTask: false
    });
    expect(harness.windowController.onTaskActivity).toHaveBeenCalledWith("task-b", {
      isNewTask: true,
      terminal: false,
      hiddenForTask: false
    });
    expect(harness.trayController.updateTasks).toHaveBeenCalledWith([
      expect.objectContaining({ id: "task-a", selected: false }),
      expect.objectContaining({ id: "task-b", selected: true })
    ]);
  });

  it("sets desired state off before tray Exit quits", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    await harness.trayCallbacks?.onExit();

    expect(harness.order).toEqual(["desired:off", "quit"]);
  });

  it("does not publish a stale tray Exit after a newer explicit on generation", async () => {
    const harness = desktopHarness();
    const { desktopStore, closingStore } = await realStateStores();
    const offCommitted = deferred<number>();
    const allowOffReturn = deferred<void>();
    harness.dependencies.stateStore = {
      ...desktopStore,
      setDesiredState: async (state, options) => {
        const settings = await desktopStore.setDesiredState(state, options);
        if (state === "off") {
          offCommitted.resolve(settings.generation);
          await allowOffReturn.promise;
        }
        return settings;
      }
    };
    await runDesktop(harness.dependencies, { kind: "manager", generation: 1 });
    const runtimeBefore = await closingStore.readRuntime();

    const exiting = harness.trayCallbacks?.onExit();
    const exitGeneration = await offCommitted.promise;
    const activation = await closingStore.setDesiredState("on");
    expect(activation.generation).toBe(exitGeneration + 1);

    allowOffReturn.resolve();
    await exiting;

    expect(harness.dependencies.app.quit).not.toHaveBeenCalled();
    expect(harness.isQuitting()).toBe(false);
    expect(await closingStore.readSettings()).toMatchObject({
      desiredState: "on",
      generation: activation.generation
    });
    expect(await closingStore.readRuntime()).toEqual(runtimeBefore);
  });

  it("runs the safe diagnostic action from the tray seam", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);

    await harness.trayCallbacks?.onDiagnose();

    expect(harness.dependencies.diagnose).toHaveBeenCalledWith({
      observedState: "hidden",
      runtimeAgeMs: 0,
      errors: []
    });
  });

  it("passes categorized desktop errors into Diagnose without raw payloads", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);
    harness.trayCallbacks?.onError(
      new Error("Bearer secret token=secret private command output"),
      "Show HUD"
    );

    await harness.trayCallbacks?.onDiagnose();

    expect(harness.dependencies.diagnose).toHaveBeenLastCalledWith({
      observedState: "hidden",
      runtimeAgeMs: 0,
      errors: [{ code: "INTERNAL_ERROR", occurredAt: "2026-09-02T00:00:00.000Z" }]
    });
    expect(JSON.stringify(vi.mocked(harness.dependencies.diagnose).mock.calls)).not.toContain(
      "Bearer secret"
    );
  });

  it("clears runtime identity during clean exit", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);
    const event = { preventDefault: vi.fn() };

    harness.listeners.get("before-quit")?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
      expect(harness.dependencies.app.quit).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(harness.dependencies.operationalLogger!.write).mock.calls.map(([entry]) => entry.event)).toEqual([
      "startup_requested",
      "startup_ready",
      "shutdown_requested",
      "shutdown_complete"
    ]);
  });

  it("does not wait for a permanently pending logger before cleanup and quit", async () => {
    const harness = desktopHarness();
    const write = vi
      .fn<(_entry: OperationalLogEntry) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockReturnValue(new Promise<void>(() => undefined));
    harness.dependencies.operationalLogger = { write };
    await runDesktop(harness.dependencies);
    const event = { preventDefault: vi.fn() };

    harness.listeners.get("before-quit")?.(event);

    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalledOnce(), {
      timeout: 100
    });
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    ["readiness", (harness: DesktopHarness, failure: Error) => {
      vi.mocked(harness.dependencies.app.whenReady).mockRejectedValue(failure);
    }],
    ["runtime construction", (harness: DesktopHarness, failure: Error) => {
      vi.mocked(harness.dependencies.app.getVersion).mockImplementation(() => { throw failure; });
    }],
    ["runtime write", (harness: DesktopHarness, failure: Error) => {
      vi.mocked(harness.dependencies.stateStore.writeRuntime).mockRejectedValue(failure);
    }],
    ["server construction", (harness: DesktopHarness, failure: Error) => {
      vi.mocked(harness.dependencies.createProgressServer).mockImplementation(() => {
        throw failure;
      });
    }],
    ["server listen", (harness: DesktopHarness, failure: Error) => {
      harness.progressServer.listen.mockRejectedValue(failure);
    }],
    ["token read", (harness: DesktopHarness, failure: Error) => {
      vi.mocked(harness.dependencies.readToken).mockRejectedValue(failure);
    }],
    ["window creation", (harness: DesktopHarness, failure: Error) => {
      harness.windowController.create.mockRejectedValue(failure);
    }],
    ["tray creation", (harness: DesktopHarness, failure: Error) => {
      vi.mocked(harness.dependencies.createTray).mockImplementation(() => { throw failure; });
    }]
  ])("fails fast when %s fails after the instance lock", async (_name, arrange) => {
    const harness = desktopHarness();
    const failure = new Error(`failed ${_name}`);
    arrange(harness, failure);

    await expect(runDesktop(harness.dependencies)).rejects.toBe(failure);

    expect(harness.dependencies.app.quit).toHaveBeenCalled();
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
    expect(harness.dependencies.reportError).toHaveBeenCalledWith(failure, "desktop startup");
    expect(JSON.stringify(vi.mocked(harness.dependencies.operationalLogger!.write).mock.calls)).not.toContain(
      failure.message
    );
    expect(harness.dependencies.operationalLogger!.write).toHaveBeenCalledWith({
      at: "2026-09-02T00:00:00.000Z",
      level: "error",
      event: "startup_failed",
      lifecycleState: "stopped",
      protocolVersion: 1,
      elapsedMs: 0
    });
  });

  it("continues every cleanup obligation and reports each cleanup failure", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);
    harness.progressServer.close.mockRejectedValue(new Error("close failed"));
    harness.trayController.dispose.mockImplementation(() => { throw new Error("tray failed"); });
    harness.windowController.dispose.mockImplementation(() => { throw new Error("window failed"); });
    vi.mocked(harness.dependencies.stateStore.clearRuntime).mockRejectedValue(
      new Error("runtime failed")
    );
    const event = { preventDefault: vi.fn() };

    const result = harness.listeners.get("before-quit")?.(event);
    if (result instanceof Promise) void result.catch(() => undefined);

    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalled());
    expect(harness.progressServer.close).toHaveBeenCalledOnce();
    expect(harness.trayController.dispose).toHaveBeenCalledOnce();
    expect(harness.windowController.dispose).toHaveBeenCalledOnce();
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
    expect(harness.dependencies.reportError).toHaveBeenCalledTimes(4);
  });

  it("does not strand quitting or quit when Exit cannot persist off", async () => {
    const harness = desktopHarness();
    const failure = new Error("settings unavailable");
    vi.mocked(harness.dependencies.stateStore.setDesiredState).mockRejectedValue(failure);
    await runDesktop(harness.dependencies);

    await expect(harness.trayCallbacks?.onExit()).rejects.toBe(failure);

    expect(harness.isQuitting()).toBe(false);
    expect(harness.dependencies.app.quit).not.toHaveBeenCalled();
  });

  it("cancels startup when quit begins during an awaited startup step", async () => {
    const harness = desktopHarness();
    const token = deferred<string>();
    vi.mocked(harness.dependencies.readToken).mockReturnValue(token.promise);
    const starting = runDesktop(harness.dependencies);
    await vi.waitFor(() => expect(harness.dependencies.readToken).toHaveBeenCalledOnce());

    const event = { preventDefault: vi.fn() };
    const result = harness.listeners.get("before-quit")?.(event);
    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalled());
    token.resolve("secret");
    await starting;

    expect(harness.windowController.create).not.toHaveBeenCalled();
    expect(harness.dependencies.createTrayImage).not.toHaveBeenCalled();
    expect(harness.dependencies.createTray).not.toHaveBeenCalled();
  });

  it("rejects an empty tray image through startup fail-fast cleanup", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.createTrayImage).mockReturnValue({ isEmpty: () => true });

    await expect(runDesktop(harness.dependencies)).rejects.toThrow("tray image is empty");

    expect(harness.dependencies.createTray).not.toHaveBeenCalled();
    expect(harness.dependencies.app.quit).toHaveBeenCalled();
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
  });

  it("times out a stuck server close while later cleanup and quit still run", async () => {
    const harness = desktopHarness();
    await runDesktop(harness.dependencies);
    harness.progressServer.close.mockReturnValue(new Promise<undefined>(() => undefined));
    const timeoutFailure = new Error("server close timed out");
    vi.mocked(harness.dependencies.withTimeout).mockImplementation(
      async (operation, timeoutMs, name) => {
        expect(timeoutMs).toBe(25);
        if (name === "server close") throw timeoutFailure;
        return operation;
      }
    );
    const event = { preventDefault: vi.fn() };

    harness.listeners.get("before-quit")?.(event);

    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalled());
    expect(harness.trayController.dispose).toHaveBeenCalledOnce();
    expect(harness.windowController.dispose).toHaveBeenCalledOnce();
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
    expect(harness.dependencies.reportError).toHaveBeenCalledWith(
      timeoutFailure,
      "desktop cleanup: server close"
    );
  });

  it("reports app quit failure but rethrows the original startup error", async () => {
    const harness = desktopHarness();
    const startupFailure = new Error("token failed");
    const quitFailure = new Error("quit failed");
    vi.mocked(harness.dependencies.readToken).mockRejectedValue(startupFailure);
    vi.mocked(harness.dependencies.app.quit).mockImplementation(() => { throw quitFailure; });

    await expect(runDesktop(harness.dependencies)).rejects.toBe(startupFailure);

    expect(harness.dependencies.reportError).toHaveBeenCalledWith(
      startupFailure,
      "desktop startup"
    );
    expect(harness.dependencies.reportError).toHaveBeenCalledWith(
      quitFailure,
      "desktop quit"
    );
  });

  it("does not wait for never-settling startup before cleanup and quit", async () => {
    const harness = desktopHarness();
    vi.mocked(harness.dependencies.app.whenReady).mockReturnValue(
      new Promise<void>(() => undefined)
    );
    void runDesktop(harness.dependencies);
    const event = { preventDefault: vi.fn() };

    harness.listeners.get("before-quit")?.(event);

    await vi.waitFor(
      () => expect(harness.dependencies.app.quit).toHaveBeenCalled(),
      { timeout: 100 }
    );
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledOnce();
  });

  it("prevents late startup continuation from creating runtime, window, or tray", async () => {
    const harness = desktopHarness();
    const ready = deferred<void>();
    vi.mocked(harness.dependencies.app.whenReady).mockReturnValue(ready.promise);
    const starting = runDesktop(harness.dependencies);
    const event = { preventDefault: vi.fn() };
    harness.listeners.get("before-quit")?.(event);
    await vi.waitFor(() => expect(harness.dependencies.app.quit).toHaveBeenCalled());

    ready.resolve(undefined);
    await starting;

    expect(harness.dependencies.stateStore.writeRuntime).not.toHaveBeenCalled();
    expect(harness.dependencies.createProgressServer).not.toHaveBeenCalled();
    expect(harness.windowController.create).not.toHaveBeenCalled();
    expect(harness.dependencies.createTray).not.toHaveBeenCalled();
    expect(harness.dependencies.stateStore.clearRuntime).toHaveBeenCalledTimes(2);
  });
});
