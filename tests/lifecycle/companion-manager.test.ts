import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanionManager } from "../../src/lifecycle/companion-manager.js";
import { createProcessLauncher } from "../../src/lifecycle/process-launcher.js";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import type { HudHealth, LifecycleStateStore } from "../../src/lifecycle/types.js";
import { HudClientError } from "../../src/mcp/report-client.js";

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

  it("recovers a crash once and rate-limits another recovery across calls", async () => {
    const { manager, launcher, setOnline } = await harness({
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
  });

  it("opens and hides through authenticated controls", async () => {
    const { manager, client } = await harness();

    expect((await manager.open()).observedState).toBe("running");
    expect((await manager.hide()).observedState).toBe("hidden");
    expect(client.show).toHaveBeenCalledOnce();
    expect(client.hide).toHaveBeenCalledOnce();
  });

  it("closes gracefully after persisting explicit off", async () => {
    const { manager, store, client, terminate } = await harness({ online: true });

    expect(await manager.close()).toEqual({ desiredState: "off", observedState: "stopped" });
    expect((await store.readSettings()).desiredState).toBe("off");
    expect(client.shutdown).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("never force-terminates a PID that this manager did not spawn", async () => {
    const { manager, terminate } = await harness({
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
  });

  it("force-terminates only a spawned process whose live identity still matches", async () => {
    const { manager, terminate } = await harness({ shutdownStops: false });
    await manager.open();

    expect(await manager.close()).toEqual({ desiredState: "off", observedState: "stopped" });
    expect(terminate).toHaveBeenCalledOnce();
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

    const spawned = await launcher.spawnHud("C:\\Program Files\\HUD\\hud.exe");

    expect(spawn).toHaveBeenCalledWith("C:\\Program Files\\HUD\\hud.exe", ["--hud"], {
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
