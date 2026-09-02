import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanionManager } from "../../src/lifecycle/companion-manager.js";
import { createProcessLauncher } from "../../src/lifecycle/process-launcher.js";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import type { HudHealth, LifecycleStateStore } from "../../src/lifecycle/types.js";
import { CompanionHttpClient, HudClientError } from "../../src/mcp/report-client.js";
import type { OperationalLogEntry } from "../../src/diagnostics/logger.js";
import { holdLifecycleLock } from "../helpers/lifecycle-lock-holder.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const compatibleHealth: HudHealth = {
  service: "codex-progress-hud",
  pid: 4312,
  version: "0.2.0",
  protocolVersion: 1,
  visibility: "visible",
  instanceNonce: "owned-instance",
  startedAt: "2026-09-01T01:02:03.000Z"
};

async function harness(options: {
  desiredState?: "on" | "off";
  runtime?: boolean;
  online?: boolean;
  spawnMakesOnline?: boolean;
  shutdownStops?: boolean;
  logger?: { write(entry: OperationalLogEntry): Promise<void> };
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hud-manager-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const executablePath = join(directory, "CodexProgressHUD.exe");
  const paths = {
    settingsPath: join(directory, "settings.json"),
    runtimePath: join(directory, "runtime.json"),
    installManifestPath: join(directory, "install.json")
  };
  await writeFile(executablePath, "fixture");
  await writeFile(
    paths.installManifestPath,
    `${JSON.stringify({ executablePath, installDirectory: directory, version: "0.2.0" })}\n`
  );
  const store = createLifecycleStateStore(paths);
  if (options.desiredState !== undefined) await store.setDesiredState(options.desiredState);
  if (options.runtime) await store.writeRuntime(compatibleHealth);

  let online = options.online ?? false;
  let visibility: HudHealth["visibility"] = "visible";
  let elapsed = 0;
  const terminate = vi.fn(async () => {
    online = false;
  });
  const launcher = {
    spawnHud: vi.fn(async () => {
      if (options.spawnMakesOnline ?? true) online = true;
      return { pid: compatibleHealth.pid, terminate };
    })
  };
  const offline = () => new HudClientError("OFFLINE", "not reachable");
  const client = {
    identity: vi.fn(async () => {
      if (!online) throw offline();
      return { service: "codex-progress-hud" as const, protocolVersion: 1 as const };
    }),
    health: vi.fn(async () => {
      if (!online) throw offline();
      return { ...compatibleHealth, visibility };
    }),
    show: vi.fn(async () => {
      visibility = "visible";
    }),
    hide: vi.fn(async () => {
      visibility = "hidden";
    }),
    shutdown: vi.fn(async () => {
      if (options.shutdownStops ?? true) online = false;
    })
  };
  const delays: number[] = [];
  const logger = options.logger ?? { write: vi.fn(async (_entry: OperationalLogEntry) => undefined) };
  const manager = createCompanionManager({
    store,
    client,
    launcher,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
      elapsed += milliseconds;
    },
    now: () => elapsed,
    recoveryCooldownMs: 60_000,
    logger,
    diagnostics: {
      directory: join(directory, "diagnostics"),
      pluginVersion: "0.2.0",
      mcpVersion: "0.2.0",
      host: "127.0.0.1",
      port: 17_837,
      installManifestPath: paths.installManifestPath,
      dataDirectoryPath: directory
    }
  });
  return {
    directory,
    executablePath,
    paths,
    store,
    client,
    launcher,
    terminate,
    manager,
    logger,
    delays,
    setOnline(value: boolean) {
      online = value;
    }
  };
}

describe("companion lifecycle manager", () => {
  it("does not start a process while observing status", async () => {
    const { manager, launcher } = await harness();

    expect(await manager.status()).toEqual({ observedState: "stopped" });
    expect(launcher.spawnHud).not.toHaveBeenCalled();
  });

  it("suppresses background writes after explicit off", async () => {
    const { manager, launcher } = await harness({ desiredState: "off" });

    await expect(manager.ensureForWrite("progress_report")).resolves.toEqual({
      kind: "suppressed",
      code: "MANUALLY_DISABLED"
    });
    await expect(manager.ensureForWrite("task_outcome")).resolves.toEqual({
      kind: "suppressed",
      code: "MANUALLY_DISABLED"
    });
    expect(launcher.spawnHud).not.toHaveBeenCalled();
  });

  it("tracking_start clears explicit off and starts the companion", async () => {
    const { manager, store, launcher } = await harness({ desiredState: "off" });

    await expect(manager.ensureForWrite("tracking_start")).resolves.toMatchObject({
      kind: "ready",
      snapshot: { desiredState: "on", observedState: "running" }
    });
    expect((await store.readSettings()).desiredState).toBe("on");
    expect(launcher.spawnHud).toHaveBeenCalledOnce();
  });

  it("rejects an executable path outside its manifest install directory", async () => {
    const { manager, paths, launcher, directory } = await harness();
    await writeFile(
      paths.installManifestPath,
      `${JSON.stringify({
        executablePath: join(directory, "..", "foreign.exe"),
        installDirectory: directory,
        version: "0.2.0"
      })}\n`
    );

    await expect(manager.open()).resolves.toMatchObject({
      observedState: "stopped",
      code: "COMPANION_NOT_INSTALLED"
    });
    expect(launcher.spawnHud).not.toHaveBeenCalled();
  });

  it("coalesces concurrent startup calls into one launch", async () => {
    const { manager, launcher } = await harness();

    const [first, second] = await Promise.all([
      manager.ensureForWrite("progress_report"),
      manager.ensureForWrite("progress_report")
    ]);

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    expect(launcher.spawnHud).toHaveBeenCalledOnce();
  });

  it("records startup using only category fields", async () => {
    const { manager, logger } = await harness();

    await manager.open();

    expect(vi.mocked(logger.write).mock.calls.map(([entry]) => entry)).toEqual([
      {
        at: "1970-01-01T00:00:00.000Z",
        level: "info",
        event: "startup_requested",
        lifecycleState: "starting",
        protocolVersion: 1
      },
      {
        at: "1970-01-01T00:00:00.000Z",
        level: "info",
        event: "startup_ready",
        lifecycleState: "running",
        protocolVersion: 1,
        elapsedMs: 0
      }
    ]);
  });

  it("does not wait for a permanently pending logger before startup", async () => {
    const pendingLogger = {
      write: vi.fn((_entry: OperationalLogEntry) => new Promise<void>(() => undefined))
    };
    const { manager, launcher } = await harness({ logger: pendingLogger });

    const result = await Promise.race([
      manager.open(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("startup waited for logger")), 500)
      )
    ]);

    expect(result.observedState).toBe("running");
    expect(launcher.spawnHud).toHaveBeenCalledOnce();
  });

  it("uses bounded readiness backoff and makes only one launch attempt", async () => {
    const { manager, launcher, delays } = await harness({ spawnMakesOnline: false });

    await expect(manager.ensureForWrite("progress_report")).resolves.toMatchObject({
      kind: "error",
      code: "START_TIMEOUT"
    });
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000, 500]);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(8_000);
    expect(launcher.spawnHud).toHaveBeenCalledOnce();
  });

  it.each([
    ["PORT_CONFLICT", "PORT_CONFLICT"],
    ["VERSION_MISMATCH", "VERSION_MISMATCH"],
    ["AUTH_ERROR", "AUTH_ERROR"]
  ] as const)(
    "preserves terminal %s readiness failures instead of timing out",
    async (clientCode, expectedCode) => {
      const { manager, client, launcher, delays } = await harness({ spawnMakesOnline: false });
      client.identity.mockImplementation(async () => {
        if (launcher.spawnHud.mock.calls.length === 0) {
          throw new HudClientError("OFFLINE", "not reachable");
        }
        if (clientCode !== "AUTH_ERROR") {
          throw new HudClientError(clientCode, "terminal identity failure");
        }
        return { service: "codex-progress-hud" as const, protocolVersion: 1 as const };
      });
      client.health.mockImplementation(async () => {
        throw new HudClientError("AUTH_ERROR", "terminal authenticated health failure");
      });

      await expect(manager.ensureForWrite("progress_report")).resolves.toMatchObject({
        kind: "error",
        code: expectedCode
      });
      expect(delays).toEqual([]);
      expect(launcher.spawnHud).toHaveBeenCalledOnce();
    }
  );

  it("recovers a crash once and rate-limits another recovery across calls", async () => {
    const { manager, launcher, logger, setOnline } = await harness({
      desiredState: "on",
      runtime: true
    });

    await expect(manager.ensureForWrite("progress_report")).resolves.toMatchObject({ kind: "ready" });
    setOnline(false);
    await expect(manager.ensureForWrite("task_outcome")).resolves.toMatchObject({
      kind: "error",
      code: "COMPANION_CRASHED"
    });
    expect(launcher.spawnHud).toHaveBeenCalledOnce();
    expect(logger.write).toHaveBeenCalledWith({
      at: "1970-01-01T00:00:00.000Z",
      level: "warn",
      event: "crash_recovery",
      lifecycleState: "crashed",
      protocolVersion: 1
    });
  });

  it("coalesces simultaneous crash recovery for every caller", async () => {
    const { manager, launcher, terminate, setOnline } = await harness({
      desiredState: "on",
      runtime: true,
      spawnMakesOnline: false
    });
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    launcher.spawnHud.mockImplementation(async () => {
      await spawnGate;
      setOnline(true);
      return { pid: compatibleHealth.pid, terminate };
    });

    const first = manager.ensureForWrite("progress_report");
    const second = manager.ensureForWrite("task_outcome");
    await vi.waitFor(() => expect(launcher.spawnHud).toHaveBeenCalledOnce());
    releaseSpawn();

    const results = await Promise.all([first, second]);
    expect(results[0]).toMatchObject({ kind: "ready", snapshot: { observedState: "running" } });
    expect(results[1]).toEqual(results[0]);
    expect(launcher.spawnHud).toHaveBeenCalledOnce();
  });

  it("opens and hides through authenticated controls", async () => {
    const { manager, client } = await harness();

    expect((await manager.open()).observedState).toBe("running");
    expect((await manager.hide()).observedState).toBe("hidden");
    expect(client.show).toHaveBeenCalledOnce();
    expect(client.hide).toHaveBeenCalledOnce();
  });

  it("maps a final show request timeout to the public startup timeout snapshot", async () => {
    const { manager, client } = await harness({ desiredState: "on", online: true });
    client.show.mockRejectedValueOnce(new HudClientError("REQUEST_TIMEOUT", "internal request timeout"));

    await expect(manager.open()).resolves.toEqual({
      desiredState: "on",
      observedState: "stopped",
      code: "START_TIMEOUT"
    });
  });

  it("closes gracefully after persisting explicit off", async () => {
    const { manager, store, client, logger, terminate } = await harness({ online: true });

    expect(await manager.close()).toEqual({ desiredState: "off", observedState: "stopped" });
    expect((await store.readSettings()).desiredState).toBe("off");
    expect(client.shutdown).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();
    expect(vi.mocked(logger.write).mock.calls.map(([entry]) => entry.event)).toEqual([
      "shutdown_requested",
      "shutdown_complete"
    ]);
  });

  it("prevents a deferred startup from publishing runtime or showing after close commits off", async () => {
    const { manager, launcher, terminate, setOnline, store, client } = await harness({
      spawnMakesOnline: false
    });
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    launcher.spawnHud.mockImplementation(async () => {
      await spawnGate;
      setOnline(true);
      return { pid: compatibleHealth.pid, terminate };
    });

    const opening = manager.open();
    await vi.waitFor(() => expect(launcher.spawnHud).toHaveBeenCalledOnce());
    await expect(manager.close()).resolves.toEqual({ desiredState: "off", observedState: "stopped" });
    releaseSpawn();
    await opening;

    expect(await store.readRuntime()).toBeNull();
    expect(client.show).not.toHaveBeenCalled();
    expect(client.shutdown).toHaveBeenCalledOnce();
    await expect(client.health()).rejects.toMatchObject({ code: "OFFLINE" });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("suppresses a request-cancelled in-flight write after close without reactivating", async () => {
    const { manager, store, launcher, client } = await harness({ desiredState: "on", online: true });
    let entered!: () => void;
    const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const operationGate = new Promise<void>((resolve) => { release = resolve; });
    let submitted = false;
    const writing = (manager as any).executeWrite("progress_report", async (options: { signal: AbortSignal }) => {
      entered();
      await operationGate;
      if (options.signal.aborted) throw new HudClientError("REQUEST_CANCELLED", "cancelled");
      submitted = true;
      return "submitted";
    });
    await operationEntered;
    launcher.spawnHud.mockClear();
    client.show.mockClear();

    await manager.close();
    release();

    await expect(writing).resolves.toEqual({ kind: "suppressed", code: "MANUALLY_DISABLED" });
    expect(submitted).toBe(false);
    expect(await store.readSettings()).toMatchObject({ desiredState: "off", generation: 2 });
    expect(launcher.spawnHud).not.toHaveBeenCalled();
    expect(client.show).not.toHaveBeenCalled();
  });

  it("does not retry a locally in-flight write after close commits off", async () => {
    const { manager } = await harness({ desiredState: "on", online: true });
    let attempts = 0;

    const result = await (manager as any).executeWrite(
      "progress_report",
      async () => {
        attempts += 1;
        await manager.close();
        throw new HudClientError("OFFLINE", "closed during first submit");
      }
    );

    expect(result).toEqual({ kind: "suppressed", code: "MANUALLY_DISABLED" });
    expect(attempts).toBe(1);
  });

  it("recovers an OFFLINE write once without changing its generation lease", async () => {
    const { manager, launcher, setOnline } = await harness({ desiredState: "on", online: true });
    const generations: number[] = [];

    const result = await manager.executeWrite("tracking_start", async ({ generation }) => {
      generations.push(generation);
      if (generations.length === 1) {
        setOnline(false);
        throw new HudClientError("OFFLINE", "companion disappeared");
      }
      return "submitted";
    });

    expect(result).toEqual({ kind: "completed", value: "submitted" });
    expect(generations).toEqual([1, 1]);
    expect(launcher.spawnHud).toHaveBeenCalledWith(expect.any(String), { generation: 1 });
  });

  it.each([
    ["generation rejection", "GENERATION_REJECTED"],
    ["manager-owned cancellation", "REQUEST_CANCELLED"]
  ] as const)("suppresses second-submit %s after recovery when manual off wins", async (_name, code) => {
    const { manager, launcher, client, setOnline, store } = await harness({
      desiredState: "on",
      online: true
    });
    let attempts = 0;

    const result = await manager.executeWrite("tracking_start", async ({ signal }) => {
      attempts += 1;
      if (attempts === 1) {
        setOnline(false);
        throw new HudClientError("OFFLINE", "companion disappeared before recovery");
      }
      await manager.close();
      if (code === "REQUEST_CANCELLED") expect(signal.aborted).toBe(true);
      throw new HudClientError(code, "manual off won before retry submit");
    });

    expect(result).toEqual({ kind: "suppressed", code: "MANUALLY_DISABLED" });
    expect(attempts).toBe(2);
    expect(await store.readSettings()).toMatchObject({ desiredState: "off", generation: 2 });
    expect(launcher.spawnHud).toHaveBeenCalledTimes(1);
    expect(client.show).not.toHaveBeenCalled();
  });

  it("keeps off authoritative when a second manager closes a first manager's deferred startup", async () => {
    const first = await harness({ spawnMakesOnline: false });
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    first.launcher.spawnHud.mockImplementation(async () => {
      await spawnGate;
      first.setOnline(true);
      return { pid: compatibleHealth.pid, terminate: first.terminate };
    });
    const second = createCompanionManager({
      store: first.store,
      client: first.client,
      launcher: { spawnHud: vi.fn() },
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(first.directory, "diagnostics-second"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: first.paths.installManifestPath,
        dataDirectoryPath: first.directory
      }
    });

    const opening = first.manager.open();
    await vi.waitFor(() => expect(first.launcher.spawnHud).toHaveBeenCalledOnce());
    await second.close();
    releaseSpawn();
    await opening;

    expect((await first.store.readSettings()).desiredState).toBe("off");
    expect(await first.store.readRuntime()).toBeNull();
    expect(first.client.show).not.toHaveBeenCalled();
    expect(first.client.shutdown).toHaveBeenCalledOnce();
    await expect(first.client.health()).rejects.toMatchObject({ code: "OFFLINE" });
    expect(first.terminate).not.toHaveBeenCalled();
  });

  it("does not reacquire an activation lease after another manager rejects stale tracking_start", async () => {
    const first = await harness({ desiredState: "off" });
    const second = createCompanionManager({
      store: first.store,
      client: first.client,
      launcher: { spawnHud: vi.fn() },
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(first.directory, "diagnostics-second-tracking"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: first.paths.installManifestPath,
        dataDirectoryPath: first.directory
      }
    });
    let attempts = 0;

    const result = await first.manager.executeWrite("tracking_start", async () => {
      attempts += 1;
      await second.close();
      throw new HudClientError("GENERATION_REJECTED", "stale generation");
    });

    expect(result).toEqual({ kind: "suppressed", code: "MANUALLY_DISABLED" });
    expect(attempts).toBe(1);
    expect((await first.store.readSettings()).desiredState).toBe("off");
  });

  it.each([
    ["authentication", new HudClientError("AUTH_ERROR", "secret"), "AUTH_ERROR"],
    ["version", new HudClientError("VERSION_MISMATCH", "secret"), "VERSION_MISMATCH"],
    ["malformed", new Error("malformed private health"), "INTERNAL_ERROR"]
  ] as const)("keeps desired off and categorizes an initial close %s failure", async (
    _name,
    failure,
    code
  ) => {
    const { manager, client, store } = await harness({ online: true });
    client.health.mockRejectedValueOnce(failure);

    await expect(manager.close()).resolves.toEqual({
      desiredState: "off",
      observedState: "stopped",
      code
    });
    expect((await store.readSettings()).desiredState).toBe("off");
    expect(client.shutdown).not.toHaveBeenCalled();
  });

  it("derives hanging startup request deadlines from the startup wall-clock budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-manager-budget-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tokenPath = join(directory, "auth.token");
    const executablePath = join(directory, "CodexProgressHUD.exe");
    const installManifestPath = join(directory, "install.json");
    await writeFile(tokenPath, "budget-token\n");
    await writeFile(executablePath, "fixture");
    await writeFile(installManifestPath, `${JSON.stringify({
      executablePath,
      installDirectory: directory,
      version: "0.2.0"
    })}\n`);
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const manager = createCompanionManager({
      store: createLifecycleStateStore({
        settingsPath: join(directory, "settings.json"),
        runtimePath: join(directory, "runtime.json"),
        installManifestPath
      }),
      client: new CompanionHttpClient(`http://127.0.0.1:${address.port}`, tokenPath),
      launcher: { spawnHud: vi.fn(async () => ({ pid: 99, terminate: vi.fn(async () => undefined) })) },
      startupTimeoutMs: 120,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(directory, "diagnostics"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: address.port,
        installManifestPath,
        dataDirectoryPath: directory
      }
    });
    const startedAt = performance.now();

    await expect(manager.ensureForWrite("progress_report")).resolves.toMatchObject({
      kind: "error",
      code: "START_TIMEOUT"
    });
    expect(performance.now() - startedAt).toBeLessThan(700);
  }, 2_000);

  it("bounds a launcher that never resolves by the startup wall-clock budget", async () => {
    const fixture = await harness({ spawnMakesOnline: false });
    fixture.launcher.spawnHud.mockReturnValue(new Promise(() => undefined));
    const bounded = createCompanionManager({
      store: fixture.store,
      client: fixture.client,
      launcher: fixture.launcher,
      startupTimeoutMs: 90,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(fixture.directory, "diagnostics-bounded"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: fixture.paths.installManifestPath,
        dataDirectoryPath: fixture.directory
      }
    });
    const startedAt = performance.now();

    await expect(bounded.open()).resolves.toMatchObject({ code: "START_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(700);
  }, 2_000);

  it("bounds an executable existence check that never settles without spawning or publishing runtime", async () => {
    const fixture = await harness({ desiredState: "off" });
    const manager = createCompanionManager({
      store: fixture.store,
      client: fixture.client,
      launcher: fixture.launcher,
      pathExists: () => new Promise<boolean>(() => undefined),
      startupTimeoutMs: 90,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(fixture.directory, "diagnostics-path-exists-timeout"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: fixture.paths.installManifestPath,
        dataDirectoryPath: fixture.directory
      }
    });
    const startedAt = performance.now();

    const result = await Promise.race([
      manager.open(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("pathExists exceeded the startup deadline")), 300)
      )
    ]);

    expect(result).toMatchObject({ code: "START_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(fixture.launcher.spawnHud).not.toHaveBeenCalled();
    expect(await fixture.store.readRuntime()).toBeNull();
  }, 2_000);

  it("bounds stale-spawn termination by the startup deadline without late publication", async () => {
    const fixture = await harness({ desiredState: "on", online: false, shutdownStops: false });
    const terminate = vi.fn(() => new Promise<void>(() => undefined));
    fixture.launcher.spawnHud.mockImplementation(async () => {
      fixture.setOnline(true);
      return { pid: compatibleHealth.pid, terminate };
    });
    const store = {
      ...fixture.store,
      writeRuntime: vi.fn(async () => false)
    } satisfies LifecycleStateStore;
    const manager = createCompanionManager({
      store,
      client: fixture.client,
      launcher: fixture.launcher,
      startupTimeoutMs: 90,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(fixture.directory, "diagnostics-stale-terminate-timeout"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: fixture.paths.installManifestPath,
        dataDirectoryPath: fixture.directory
      }
    });
    const startedAt = performance.now();

    const result = await Promise.race([
      manager.open(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("stale terminate exceeded the startup deadline")), 300)
      )
    ]);

    expect(result).toMatchObject({ desiredState: "on", code: "START_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(terminate).toHaveBeenCalledOnce();
    await new Promise((resolve_) => setTimeout(resolve_, 150));
    expect(await fixture.store.readRuntime()).toBeNull();
    expect((await fixture.store.readSettings()).desiredState).toBe("on");
    expect(fixture.client.show).not.toHaveBeenCalled();
  }, 2_000);

  it("bounds complete open while another process holds the lifecycle lock without a late runtime publication", async () => {
    const fixture = await harness({ desiredState: "off" });
    const lock = await holdLifecycleLock(join(fixture.directory, ".lifecycle-state.lock"));
    cleanups.push(() => lock.release());
    const manager = createCompanionManager({
      store: fixture.store,
      client: fixture.client,
      launcher: fixture.launcher,
      startupTimeoutMs: 90,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(fixture.directory, "diagnostics-lock-open"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: fixture.paths.installManifestPath,
        dataDirectoryPath: fixture.directory
      }
    });
    const startedAt = performance.now();

    await expect(manager.open()).resolves.toMatchObject({ code: "START_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(300);
    const successor = {
      pid: 9001,
      version: "0.2.0",
      protocolVersion: 1,
      instanceNonce: "successor-open",
      startedAt: "2026-09-01T01:02:03.000Z"
    };
    await lock.releaseWithWrites([
      {
        path: fixture.paths.settingsPath,
        content: '{"desiredState":"off","startWithWindows":false,"generation":2}\n'
      },
      { path: fixture.paths.runtimePath, content: `${JSON.stringify(successor)}\n` }
    ]);
    await new Promise((resolve_) => setTimeout(resolve_, 150));
    expect(await fixture.store.readSettings()).toMatchObject({ desiredState: "off", generation: 2 });
    expect(await fixture.store.readRuntime()).toEqual(successor);
    expect(fixture.launcher.spawnHud).not.toHaveBeenCalled();
  }, 10_000);

  it("reports a live hanging listener as a degraded shutdown timeout without claiming completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-close-budget-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tokenPath = join(directory, "auth.token");
    await writeFile(tokenPath, "budget-token\n");
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const store = createLifecycleStateStore({
      settingsPath: join(directory, "settings.json"),
      runtimePath: join(directory, "runtime.json"),
      installManifestPath: join(directory, "install.json")
    });
    await store.writeRuntime(compatibleHealth);
    const logger = { write: vi.fn(async (_entry: OperationalLogEntry) => undefined) };
    const manager = createCompanionManager({
      store,
      client: new CompanionHttpClient(`http://127.0.0.1:${address.port}`, tokenPath),
      launcher: { spawnHud: vi.fn() },
      shutdownTimeoutMs: 90,
      logger,
      diagnostics: {
        directory: join(directory, "diagnostics"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: address.port,
        installManifestPath: join(directory, "install.json"),
        dataDirectoryPath: directory
      }
    });
    const startedAt = performance.now();

    await expect(manager.close()).resolves.toEqual({
      desiredState: "off",
      observedState: "stopped",
      code: "SHUTDOWN_TIMEOUT"
    });
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect((await store.readSettings()).desiredState).toBe("off");
    expect(await store.readRuntime()).toEqual({
      pid: 4312,
      version: "0.2.0",
      protocolVersion: 1,
      instanceNonce: "owned-instance",
      startedAt: "2026-09-01T01:02:03.000Z"
    });
    expect(vi.mocked(logger.write).mock.calls.map(([entry]) => entry.event)).not.toContain("shutdown_complete");
  }, 2_000);

  it("bounds a close-time runtime clear behind a real process lock and never deletes its successor", async () => {
    const fixture = await harness({ desiredState: "on", runtime: true, online: true });
    let heldLock: Awaited<ReturnType<typeof holdLifecycleLock>> | undefined;
    fixture.client.health.mockImplementationOnce(async () => {
      heldLock = await holdLifecycleLock(join(fixture.directory, ".lifecycle-state.lock"));
      cleanups.push(() => heldLock!.release());
      throw new HudClientError("OFFLINE", "not reachable");
    });
    const manager = createCompanionManager({
      store: fixture.store,
      client: fixture.client,
      launcher: fixture.launcher,
      shutdownTimeoutMs: 90,
      logger: { write: async () => undefined },
      diagnostics: {
        directory: join(fixture.directory, "diagnostics-lock-close"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: fixture.paths.installManifestPath,
        dataDirectoryPath: fixture.directory
      }
    });
    const startedAt = performance.now();

    await expect(manager.close()).resolves.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(300);
    if (heldLock === undefined) throw new Error("close did not reach the locked runtime clear");
    const successor = {
      pid: 9002,
      version: "0.2.0",
      protocolVersion: 1,
      instanceNonce: "successor-close",
      startedAt: "2026-09-01T01:02:03.000Z"
    };
    await heldLock.releaseWithWrites([
      { path: fixture.paths.runtimePath, content: `${JSON.stringify(successor)}\n` }
    ]);
    await new Promise((resolve_) => setTimeout(resolve_, 150));
    expect(await fixture.store.readRuntime()).toEqual(successor);
  }, 10_000);

  it("does not wait for a permanently pending logger before shutdown", async () => {
    const pendingLogger = {
      write: vi.fn((_entry: OperationalLogEntry) => new Promise<void>(() => undefined))
    };
    const { manager, client } = await harness({ online: true, logger: pendingLogger });

    const result = await Promise.race([
      manager.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("shutdown waited for logger")), 500)
      )
    ]);

    expect(result).toEqual({ desiredState: "off", observedState: "stopped" });
    expect(client.shutdown).toHaveBeenCalledOnce();
  });

  it("never force-terminates a PID that this manager did not spawn", async () => {
    const { manager, logger, terminate } = await harness({
      desiredState: "on",
      runtime: true,
      online: true,
      shutdownStops: false
    });

    await expect(manager.close()).resolves.toMatchObject({
      desiredState: "off",
      observedState: "stopped",
      code: "SHUTDOWN_TIMEOUT"
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(logger.write).toHaveBeenLastCalledWith({
      at: "1970-01-01T00:00:05.000Z",
      level: "error",
      event: "shutdown_timeout",
      lifecycleState: "stopped",
      protocolVersion: 1,
      elapsedMs: 5000
    });
  });

  it.each([
    ["PORT_CONFLICT", "port_conflict", "port_conflict"],
    ["VERSION_MISMATCH", "protocol_mismatch", "incompatible"]
  ] as const)("records %s as a category without the client error payload", async (
    clientCode,
    event,
    lifecycleState
  ) => {
    const { manager, client, logger } = await harness({ online: true });
    client.identity.mockRejectedValue(
      new HudClientError(clientCode, "Bearer secret token=secret private command output")
    );

    await manager.ensureForWrite("progress_report");

    expect(logger.write).toHaveBeenCalledWith({
      at: "1970-01-01T00:00:00.000Z",
      level: "error",
      event,
      lifecycleState,
      protocolVersion: 1
    });
    expect(JSON.stringify(vi.mocked(logger.write).mock.calls)).not.toContain("Bearer secret");
  });

  it("force-terminates only a spawned process whose live identity still matches", async () => {
    const { manager, terminate } = await harness({ shutdownStops: false });
    await manager.open();

    expect(await manager.close()).toEqual({ desiredState: "off", observedState: "stopped" });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("bounds a matching owned HUD terminate call with the same shutdown deadline", async () => {
    const fixture = await harness({ shutdownStops: false });
    let terminateStarted = false;
    const terminate = vi.fn(() => {
      terminateStarted = true;
      return new Promise<void>(() => undefined);
    });
    fixture.launcher.spawnHud.mockImplementation(async () => {
      fixture.setOnline(true);
      return { pid: compatibleHealth.pid, terminate };
    });
    const logger = { write: vi.fn(async (_entry: OperationalLogEntry) => undefined) };
    const manager = createCompanionManager({
      store: fixture.store,
      client: fixture.client,
      launcher: fixture.launcher,
      shutdownTimeoutMs: 90,
      logger,
      diagnostics: {
        directory: join(fixture.directory, "diagnostics-terminate-timeout"),
        pluginVersion: "0.2.0",
        mcpVersion: "0.2.0",
        host: "127.0.0.1",
        port: 17_837,
        installManifestPath: fixture.paths.installManifestPath,
        dataDirectoryPath: fixture.directory
      }
    });
    await manager.open();
    const startedAt = performance.now();

    const closing = Promise.race([
      manager.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("terminate exceeded the close deadline")), 300)
      )
    ]);
    await expect(closing).resolves.toEqual({
      desiredState: "off",
      observedState: "stopped",
      code: "SHUTDOWN_TIMEOUT"
    });
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(terminateStarted).toBe(true);
    expect(await fixture.store.readRuntime()).not.toBeNull();
    expect(vi.mocked(logger.write).mock.calls.map(([entry]) => entry.event)).not.toContain("shutdown_complete");
  }, 2_000);

  it.each([
    ["unauthorized", new HudClientError("AUTH_ERROR", "authentication failed")],
    ["incompatible", new HudClientError("VERSION_MISMATCH", "protocol changed")],
    ["malformed", new Error("malformed health response")]
  ])("does not force-terminate after a fresh %s shutdown probe failure", async (_kind, failure) => {
    const { manager, client, terminate } = await harness({ shutdownStops: false });
    await manager.open();
    client.health.mockImplementation(async () => {
      if (client.shutdown.mock.calls.length > 0) throw failure;
      return compatibleHealth;
    });

    await expect(manager.close()).resolves.toMatchObject({
      desiredState: "off",
      observedState: "stopped",
      code: "SHUTDOWN_TIMEOUT"
    });
    expect(terminate).not.toHaveBeenCalled();
  });
});

describe("process launcher", () => {
  it("spawns the exact executable without a shell and detaches stdio", async () => {
    const child = {
      pid: 9123,
      unref: vi.fn<() => void>(),
      kill: vi.fn<() => boolean>(() => true)
    };
    const spawn = vi.fn(() => child);
    const launcher = createProcessLauncher(spawn);

    const spawned = await launcher.spawnHud("C:\\Program Files\\HUD\\hud.exe", { generation: 7 });

    expect(spawn).toHaveBeenCalledWith("C:\\Program Files\\HUD\\hud.exe", ["--hud", "--manager-generation=7"], {
      detached: true,
      stdio: "ignore",
      shell: false
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawned.pid).toBe(9123);
    await spawned.terminate();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
