import { spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import { holdLifecycleLock } from "../helpers/lifecycle-lock-holder.js";
import {
  defaultDiagnosticsDirectory,
  defaultInstallManifestPath,
  defaultLogDirectory,
  defaultRuntimePath,
  defaultSettingsPath
} from "../../src/server/paths.js";

let directory: string;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-lifecycle-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function testPaths() {
  return {
    settingsPath: join(directory, "settings.json"),
    runtimePath: join(directory, "runtime.json"),
    installManifestPath: join(directory, "install.json")
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

const realFileSystem = { link, lstat, mkdir, readFile, rename, unlink, writeFile };

function storeWithFileSystem(
  overrides: Partial<typeof realFileSystem>
) {
  return createLifecycleStateStore(testPaths(), {
    fileSystem: { ...realFileSystem, ...overrides }
  });
}

describe("lifecycle state paths", () => {
  it("places lifecycle files and directories under the configured data directory", () => {
    const environment = { CODEX_PROGRESS_HUD_DATA_DIR: directory };

    expect(defaultSettingsPath(environment)).toBe(join(directory, "settings.json"));
    expect(defaultRuntimePath(environment)).toBe(join(directory, "runtime.json"));
    expect(defaultInstallManifestPath(environment)).toBe(join(directory, "install.json"));
    expect(defaultLogDirectory(environment)).toBe(join(directory, "logs"));
    expect(defaultDiagnosticsDirectory(environment)).toBe(join(directory, "diagnostics"));
  });
});

describe("lifecycle state store", () => {
  it("returns defaults when persistent files are missing", async () => {
    const store = createLifecycleStateStore(testPaths());

    expect(await store.readSettings()).toEqual({ startWithWindows: false, generation: 0 });
    expect(await store.readRuntime()).toBeNull();
    expect(await store.readInstallManifest()).toBeNull();
  });

  it("persists explicit off without inventing other settings", async () => {
    const paths = testPaths();
    const store = createLifecycleStateStore(paths);

    await store.setDesiredState("off");

    expect(await store.readSettings()).toEqual({
      desiredState: "off",
      startWithWindows: false,
      generation: 1
    });
    expect(await readFile(paths.settingsPath, "utf8")).toBe(
      '{"startWithWindows":false,"generation":1,"desiredState":"off"}\n'
    );
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves start-with-Windows when changing desired state", async () => {
    const paths = testPaths();
    await writeFile(paths.settingsPath, '{"desiredState":"on","startWithWindows":true}\n');
    const store = createLifecycleStateStore(paths);

    expect(await store.setDesiredState("off")).toEqual({
      desiredState: "off",
      startWithWindows: true,
      generation: 1
    });
  });

  it("settles overlapping desired-state writes with a valid final document", async () => {
    const paths = testPaths();
    const store = createLifecycleStateStore(paths);

    const writes = Array.from({ length: 32 }, (_, index) =>
      store.setDesiredState(index % 2 === 0 ? "on" : "off")
    );
    const results = await Promise.allSettled(writes);
    const rejections = results.filter((result) => result.status === "rejected");

    expect(
      rejections,
      rejections.map((result) => String(result.reason)).join("\n")
    ).toEqual([]);
    expect(JSON.parse(await readFile(paths.settingsPath, "utf8"))).toEqual(
      expect.objectContaining({
        desiredState: expect.stringMatching(/^(on|off)$/),
        startWithWindows: false,
        generation: 32
      })
    );
  });

  it("expires a caller-budgeted real lock wait without a delayed mutation", async () => {
    const paths = testPaths();
    const store = createLifecycleStateStore(paths);
    await store.setDesiredState("off");
    const lock = await holdLifecycleLock(join(directory, ".lifecycle-state.lock"));
    const startedAt = performance.now();

    const result = await store.setDesiredState("on", { timeoutMs: 90 })
      .then(() => ({ kind: "resolved" as const }))
      .catch((error: unknown) => ({ kind: "rejected" as const, error }));
    const elapsedMs = performance.now() - startedAt;
    await lock.releaseWithWrites([{
      path: paths.settingsPath,
      content: '{"desiredState":"off","startWithWindows":false,"generation":2}\n'
    }]);

    expect(result).toMatchObject({ kind: "rejected" });
    expect(elapsedMs).toBeLessThan(300);
    await lock.release();
    await new Promise((resolve_) => setTimeout(resolve_, 150));
    expect(await store.readSettings()).toMatchObject({ desiredState: "off", generation: 2 });
  }, 10_000);

  it.each([
    ["lock directory creation", "mkdir"],
    ["owner file creation", "writeFile"],
    ["owner identity read", "lstat"]
  ] as const)("hard-bounds stalled %s before product mutation", async (_name, operationName) => {
    const paths = testPaths();
    const baseline = createLifecycleStateStore(paths);
    await baseline.setDesiredState("off");
    const entered = deferred();
    const release = deferred();
    const overrides: Partial<typeof realFileSystem> = {};
    if (operationName === "mkdir") {
      overrides.mkdir = (async (...arguments_: Parameters<typeof mkdir>) => {
        entered.resolve();
        await release.promise;
        return mkdir(...arguments_);
      }) as typeof mkdir;
    } else if (operationName === "writeFile") {
      overrides.writeFile = (async (...arguments_: Parameters<typeof writeFile>) => {
        if (String(arguments_[0]).includes(".owner-")) {
          entered.resolve();
          await release.promise;
        }
        return writeFile(...arguments_);
      }) as typeof writeFile;
    } else {
      overrides.lstat = (async (...arguments_: Parameters<typeof lstat>) => {
        if (String(arguments_[0]).includes(".owner-")) {
          entered.resolve();
          await release.promise;
        }
        return lstat(...arguments_);
      }) as typeof lstat;
    }
    const stalled = storeWithFileSystem(overrides);
    const startedAt = performance.now();
    const pending = stalled.setDesiredState("on", { timeoutMs: 90 });
    await Promise.race([
      entered.promise,
      pending.then(
        () => { throw new Error(`${operationName} stall seam was ignored`); },
        () => { throw new Error(`${operationName} stall seam was ignored`); }
      )
    ]);

    const result = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) =>
        setTimeout(() => resolve_({ kind: "watchdog" }), 300)
      )
    ]);
    const elapsedMs = performance.now() - startedAt;
    release.resolve();
    await pending.catch(() => undefined);
    await new Promise((resolve_) => setTimeout(resolve_, 150));

    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "LifecycleStateTimeoutError" }
    });
    expect(elapsedMs).toBeLessThan(300);
    expect(await baseline.readSettings()).toMatchObject({ desiredState: "off", generation: 1 });
    expect(await baseline.readRuntime()).toBeNull();
    expect((await readdir(directory)).filter((name) => name.includes(".lock"))).toEqual([]);
  }, 2_000);

  it("hard-bounds a stalled lock metadata read without a late product mutation", async () => {
    const paths = testPaths();
    const baseline = createLifecycleStateStore(paths);
    await baseline.setDesiredState("off");
    const lockPath = join(directory, ".lifecycle-state.lock");
    const held = await holdLifecycleLock(lockPath);
    const entered = deferred();
    const releaseRead = deferred();
    const stalled = storeWithFileSystem({
      readFile: (async (...arguments_: Parameters<typeof readFile>) => {
        if (String(arguments_[0]) === lockPath) {
          entered.resolve();
          await releaseRead.promise;
        }
        return readFile(...arguments_);
      }) as typeof readFile
    });
    const startedAt = performance.now();
    const pending = stalled.setDesiredState("on", { timeoutMs: 90 });
    await Promise.race([
      entered.promise,
      pending.then(
        () => { throw new Error("lock read stall seam was ignored"); },
        () => { throw new Error("lock read stall seam was ignored"); }
      )
    ]);

    const result = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) =>
        setTimeout(() => resolve_({ kind: "watchdog" }), 300)
      )
    ]);
    const elapsedMs = performance.now() - startedAt;
    releaseRead.resolve();
    await held.releaseWithWrites([{
      path: paths.settingsPath,
      content: '{"desiredState":"off","startWithWindows":false,"generation":2}\n'
    }]);
    await pending.catch(() => undefined);
    await new Promise((resolve_) => setTimeout(resolve_, 150));

    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "LifecycleStateTimeoutError" }
    });
    expect(elapsedMs).toBeLessThan(300);
    expect(await baseline.readSettings()).toMatchObject({ desiredState: "off", generation: 2 });
    expect(await baseline.readRuntime()).toBeNull();
  }, 2_000);

  it("hard-bounds a stalled product-state read without mutating after timeout", async () => {
    const paths = testPaths();
    const baseline = createLifecycleStateStore(paths);
    await baseline.setDesiredState("off");
    const entered = deferred();
    const releaseRead = deferred();
    const stalled = storeWithFileSystem({
      readFile: (async (...arguments_: Parameters<typeof readFile>) => {
        if (String(arguments_[0]) === paths.settingsPath) {
          entered.resolve();
          await releaseRead.promise;
        }
        return readFile(...arguments_);
      }) as typeof readFile
    });
    const startedAt = performance.now();
    const pending = stalled.readSettings({ timeoutMs: 90 });
    await Promise.race([
      entered.promise,
      pending.then(
        () => { throw new Error("product read stall seam was ignored"); },
        () => { throw new Error("product read stall seam was ignored"); }
      )
    ]);

    const result = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) =>
        setTimeout(() => resolve_({ kind: "watchdog" }), 300)
      )
    ]);
    const elapsedMs = performance.now() - startedAt;
    releaseRead.resolve();
    await pending.catch(() => undefined);
    await new Promise((resolve_) => setTimeout(resolve_, 150));

    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "LifecycleStateTimeoutError" }
    });
    expect(elapsedMs).toBeLessThan(300);
    expect(await baseline.readSettings()).toMatchObject({ desiredState: "off", generation: 1 });
    expect(await baseline.readRuntime()).toBeNull();
  }, 2_000);

  it("returns after a committed mutation while identity-safe release finishes in the background", async () => {
    const paths = testPaths();
    const baseline = createLifecycleStateStore(paths);
    await baseline.setDesiredState("off");
    const lockPath = join(directory, ".lifecycle-state.lock");
    const releaseReadEntered = deferred();
    const allowReleaseRead = deferred();
    let lockReads = 0;
    const stalled = storeWithFileSystem({
      readFile: (async (...arguments_: Parameters<typeof readFile>) => {
        if (String(arguments_[0]) === lockPath && ++lockReads === 2) {
          releaseReadEntered.resolve();
          await allowReleaseRead.promise;
        }
        return readFile(...arguments_);
      }) as typeof readFile
    });
    const startedAt = performance.now();
    const pending = stalled.setDesiredState("on", { timeoutMs: 90 });
    await Promise.race([
      releaseReadEntered.promise,
      pending.then(
        () => { throw new Error("release read stall seam was ignored"); },
        () => { throw new Error("release read stall seam was ignored"); }
      )
    ]);

    const result = await Promise.race([
      pending.then(
        (settings) => ({ kind: "resolved" as const, settings }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) =>
        setTimeout(() => resolve_({ kind: "watchdog" }), 300)
      )
    ]);
    const elapsedMs = performance.now() - startedAt;
    await unlink(lockPath);
    const successor = await holdLifecycleLock(lockPath);
    allowReleaseRead.resolve();
    await new Promise((resolve_) => setTimeout(resolve_, 150));

    expect(result).toMatchObject({
      kind: "resolved",
      settings: { desiredState: "on", generation: 2 }
    });
    expect(elapsedMs).toBeLessThan(300);
    await expect(lstat(lockPath)).resolves.toBeDefined();
    const successorRuntime = {
      pid: 9002,
      version: "0.2.0",
      protocolVersion: 1,
      instanceNonce: "successor-release",
      startedAt: "2026-09-01T01:02:03.000Z"
    };
    await successor.releaseWithWrites([
      {
        path: paths.settingsPath,
        content: '{"desiredState":"off","startWithWindows":false,"generation":3}\n'
      },
      { path: paths.runtimePath, content: `${JSON.stringify(successorRuntime)}\n` }
    ]);
    await pending.catch(() => undefined);
    expect(await baseline.readSettings()).toMatchObject({ desiredState: "off", generation: 3 });
    expect(await baseline.readRuntime()).toEqual(successorRuntime);
  }, 2_000);

  it.each([
    ["without expected identity", false],
    ["after reading expected identity", true]
  ] as const)(
    "hard-bounds clearRuntime %s before the final identity-matched unlink",
    async (_name, useExpected) => {
      const paths = testPaths();
      const baseline = createLifecycleStateStore(paths);
      const originalRuntime = {
        pid: 4312,
        version: "0.1.0",
        protocolVersion: 1,
        instanceNonce: "runtime-to-clear",
        startedAt: "2026-09-01T01:02:03.000Z"
      };
      await baseline.writeRuntime(originalRuntime);
      const finalIdentityReadEntered = deferred();
      const allowFinalIdentityRead = deferred();
      let runtimeIdentityReads = 0;
      let expectedRuntimeReadCompleted = false;
      const stalled = storeWithFileSystem({
        readFile: (async (...arguments_: Parameters<typeof readFile>) => {
          const content = await readFile(...arguments_);
          if (String(arguments_[0]) === paths.runtimePath) expectedRuntimeReadCompleted = true;
          return content;
        }) as typeof readFile,
        lstat: (async (...arguments_: Parameters<typeof lstat>) => {
          if (String(arguments_[0]) === paths.runtimePath && ++runtimeIdentityReads === 2) {
            finalIdentityReadEntered.resolve();
            await allowFinalIdentityRead.promise;
          }
          return lstat(...arguments_);
        }) as typeof lstat
      });
      const startedAt = performance.now();
      const pending = stalled.clearRuntime(
        useExpected ? originalRuntime : undefined,
        { timeoutMs: 90 }
      );
      await finalIdentityReadEntered.promise;

      const result = await Promise.race([
        pending.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error })
        ),
        new Promise<{ kind: "watchdog" }>((resolve_) =>
          setTimeout(() => resolve_({ kind: "watchdog" }), 300)
        )
      ]);
      const elapsedMs = performance.now() - startedAt;
      const successorRuntime = {
        ...originalRuntime,
        pid: 9003,
        instanceNonce: "successor-after-clear-timeout"
      };
      await unlink(paths.runtimePath);
      await writeFile(paths.runtimePath, `${JSON.stringify(successorRuntime)}\n`);
      allowFinalIdentityRead.resolve();
      await pending.catch(() => undefined);
      await new Promise((resolve_) => setTimeout(resolve_, 150));

      expect(expectedRuntimeReadCompleted).toBe(useExpected);
      expect(result).toMatchObject({
        kind: "rejected",
        error: { name: "LifecycleStateTimeoutError" }
      });
      expect(elapsedMs).toBeLessThan(300);
      expect(await baseline.readRuntime()).toEqual(successorRuntime);
    },
    2_000
  );

  it("does not return a post-acquisition timeout until the callback cannot commit late", async () => {
    const store = createLifecycleStateStore(testPaths());
    await store.setDesiredState("on");
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve_) => { entered = resolve_; });
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve_) => { release = resolve_; });
    let committed = false;

    const startedAt = performance.now();
    const operation = store.runIfGeneration(1, "on", async (signal?: AbortSignal) => {
      entered();
      if (signal === undefined) {
        await releaseGate;
      } else if (!signal.aborted) {
        await Promise.race([
          releaseGate,
          new Promise<void>((resolve_) =>
            signal.addEventListener("abort", () => resolve_(), { once: true })
          )
        ]);
      }
      if (!signal?.aborted) committed = true;
      return "callback-finished";
    }, { timeoutMs: 40 });
    await callbackEntered;

    const result = await operation
      .then(() => ({ kind: "resolved" as const }))
      .catch((error: unknown) => ({ kind: "rejected" as const, error }));
    const elapsedMs = performance.now() - startedAt;
    release();
    await new Promise((resolve_) => setTimeout(resolve_, 50));

    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "LifecycleStateTimeoutError" }
    });
    expect(elapsedMs).toBeLessThan(300);
    expect(committed).toBe(false);
  });

  it("expires safely while queued behind an entered local mutation", async () => {
    const store = createLifecycleStateStore(testPaths());
    await store.setDesiredState("on");
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve_) => { entered = resolve_; });
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve_) => { release = resolve_; });
    const first = store.runIfGeneration(1, "on", async () => {
      entered();
      await releaseGate;
    });
    await callbackEntered;
    const startedAt = performance.now();

    const second = store.setDesiredState("off", { timeoutMs: 40 });
    const result = await Promise.race([
      second.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) =>
        setTimeout(() => resolve_({ kind: "watchdog" }), 300)
      )
    ]);
    const elapsedMs = performance.now() - startedAt;
    release();
    await first;
    await second.catch(() => undefined);

    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "LifecycleStateTimeoutError" }
    });
    expect(elapsedMs).toBeLessThan(300);
    expect(await store.readSettings()).toMatchObject({ desiredState: "on", generation: 1 });
  });

  it("releases an externally aborted operation queued behind an entered local mutation", async () => {
    const store = createLifecycleStateStore(testPaths());
    await store.setDesiredState("on");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondMutationEntered = false;
    const first = store.runIfGeneration(1, "on", async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const controller = new AbortController();
    const second = store.runIfGeneration(1, "on", async () => {
      secondMutationEntered = true;
    }, { signal: controller.signal });
    await Promise.resolve();
    const startedAt = performance.now();
    controller.abort();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      second.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "watchdog" }>((resolve_) => {
        watchdog = setTimeout(() => resolve_({ kind: "watchdog" }), 300);
      })
    ]);
    const elapsedMs = performance.now() - startedAt;
    if (watchdog !== undefined) clearTimeout(watchdog);

    releaseFirst.resolve();
    await first;
    const settings = await store.readSettings();

    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "LifecycleStateTimeoutError" }
    });
    expect(elapsedMs).toBeLessThan(100);
    expect(secondMutationEntered).toBe(false);
    expect(settings).toMatchObject({ desiredState: "on", generation: 1 });
  });

  it("writes and reads valid runtime identity", async () => {
    const store = createLifecycleStateStore(testPaths());
    const identity = {
      pid: 4312,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "nonce-123",
      startedAt: "2026-09-01T01:02:03.000Z"
    };

    await store.writeRuntime(identity);

    expect(await store.readRuntime()).toEqual(identity);
  });

  it("clears runtime only for the current off generation and exact expected identity", async () => {
    const firstStore = createLifecycleStateStore(testPaths());
    const secondStore = createLifecycleStateStore(testPaths());
    const identity = {
      pid: 4312,
      version: "0.2.0",
      protocolVersion: 1,
      instanceNonce: "same-process",
      startedAt: "2026-09-01T01:02:03.000Z"
    };
    const firstOn = await firstStore.setDesiredState("on");
    await firstStore.writeRuntime(identity, firstOn.generation);
    const oldClose = await firstStore.setDesiredState("off");
    const successorOn = await secondStore.setDesiredState("on");
    await secondStore.writeRuntime(identity, successorOn.generation);

    await expect(
      firstStore.clearRuntimeIfGeneration(oldClose.generation, identity)
    ).resolves.toBe(false);
    expect(await firstStore.readRuntime()).toEqual(identity);

    const currentClose = await firstStore.setDesiredState("off");
    await expect(firstStore.clearRuntimeIfGeneration(currentClose.generation, {
      ...identity,
      startedAt: "2026-09-01T01:02:04.000Z"
    })).resolves.toBe(false);
    expect(await firstStore.readRuntime()).toEqual(identity);

    await expect(
      firstStore.clearRuntimeIfGeneration(currentClose.generation, identity)
    ).resolves.toBe(true);
    expect(await firstStore.readRuntime()).toBeNull();
  });

  it("rejects a canonical timestamp shape with an impossible calendar date", async () => {
    const paths = testPaths();
    const identity = {
      pid: 4312,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "nonce-123",
      startedAt: "2026-02-31T01:02:03.000Z"
    };
    await writeFile(paths.runtimePath, `${JSON.stringify(identity)}\n`);

    await expect(createLifecycleStateStore(paths).readRuntime()).rejects.toThrow(
      `Invalid lifecycle JSON file: ${paths.runtimePath}`
    );
  });

  it("accepts a canonical timestamp on a valid leap date unchanged", async () => {
    const paths = testPaths();
    const identity = {
      pid: 4312,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "nonce-123",
      startedAt: "2028-02-29T01:02:03.000Z"
    };
    await writeFile(paths.runtimePath, `${JSON.stringify(identity)}\n`);

    expect(await createLifecycleStateStore(paths).readRuntime()).toEqual(identity);
  });

  it("waits for queued same-path writes before reading", async () => {
    const store = createLifecycleStateStore(testPaths());
    const firstIdentity = {
      pid: 4312,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "first-write",
      startedAt: "2026-09-01T01:02:03.000Z"
    };
    const finalIdentity = {
      ...firstIdentity,
      pid: 4313,
      instanceNonce: "queued-write"
    };

    const firstWrite = store.writeRuntime(firstIdentity);
    const queuedWrite = store.writeRuntime(finalIdentity);
    const [readResult, ...writeResults] = await Promise.allSettled([
      store.readRuntime(),
      firstWrite,
      queuedWrite
    ]);
    const writeRejections = writeResults.filter((result) => result.status === "rejected");

    expect(
      writeRejections,
      writeRejections.map((result) => String(result.reason)).join("\n")
    ).toEqual([]);
    expect(readResult).toEqual({ status: "fulfilled", value: finalIdentity });
  });

  it("reads a valid install manifest", async () => {
    const paths = testPaths();
    const manifest = {
      executablePath: "C:\\Program Files\\Codex Progress HUD\\Codex Progress HUD.exe",
      installDirectory: "C:\\Program Files\\Codex Progress HUD",
      version: "0.1.0"
    };
    await writeFile(paths.installManifestPath, `${JSON.stringify(manifest)}\n`);

    expect(await createLifecycleStateStore(paths).readInstallManifest()).toEqual(manifest);
  });

  it.each([
    ["settings", "settingsPath", "settings.json"],
    ["runtime", "runtimePath", "runtime.json"],
    ["install manifest", "installManifestPath", "install.json"]
  ] as const)("rejects malformed %s JSON without exposing its content", async (_, key, fileName) => {
    const paths = testPaths();
    const secret = "malformed-secret-content";
    await writeFile(paths[key], `{${secret}`);
    const store = createLifecycleStateStore(paths);
    const read =
      fileName === "settings.json"
        ? store.readSettings()
        : fileName === "runtime.json"
          ? store.readRuntime()
          : store.readInstallManifest();

    await expect(read).rejects.toThrow(fileName);
    await expect(read).rejects.not.toThrow(secret);
  });

  it.each([
    ["settings extra key", "settingsPath", { startWithWindows: false, extra: true }, "readSettings"],
    ["settings negative generation", "settingsPath", { startWithWindows: false, generation: -1 }, "readSettings"],
    ["runtime fractional pid", "runtimePath", { pid: 1.5, version: "0.2.0", protocolVersion: 1, instanceNonce: "nonce", startedAt: "2026-09-01T01:02:03.000Z" }, "readRuntime"],
    ["runtime empty version", "runtimePath", { pid: 1, version: "", protocolVersion: 1, instanceNonce: "nonce", startedAt: "2026-09-01T01:02:03.000Z" }, "readRuntime"],
    ["runtime wrong protocol", "runtimePath", { pid: 1, version: "0.2.0", protocolVersion: 2, instanceNonce: "nonce", startedAt: "2026-09-01T01:02:03.000Z" }, "readRuntime"],
    ["runtime empty nonce", "runtimePath", { pid: 1, version: "0.2.0", protocolVersion: 1, instanceNonce: "", startedAt: "2026-09-01T01:02:03.000Z" }, "readRuntime"],
    ["runtime invalid timestamp", "runtimePath", { pid: 1, version: "0.2.0", protocolVersion: 1, instanceNonce: "nonce", startedAt: "not-a-date" }, "readRuntime"],
    ["runtime extra key", "runtimePath", { pid: 1, version: "0.2.0", protocolVersion: 1, instanceNonce: "nonce", startedAt: "2026-09-01T01:02:03.000Z", extra: true }, "readRuntime"],
    ["manifest relative executable", "installManifestPath", { executablePath: "hud.exe", installDirectory: "C:\\HUD", version: "0.2.0" }, "readInstallManifest"],
    ["manifest relative directory", "installManifestPath", { executablePath: "C:\\HUD\\hud.exe", installDirectory: "HUD", version: "0.2.0" }, "readInstallManifest"],
    ["manifest empty version", "installManifestPath", { executablePath: "C:\\HUD\\hud.exe", installDirectory: "C:\\HUD", version: "" }, "readInstallManifest"],
    ["manifest extra key", "installManifestPath", { executablePath: "C:\\HUD\\hud.exe", installDirectory: "C:\\HUD", version: "0.2.0", extra: true }, "readInstallManifest"]
  ] as const)("rejects semantically invalid valid JSON: %s", async (_name, key, value, method) => {
    const paths = testPaths();
    await writeFile(paths[key], `${JSON.stringify(value)}\n`);
    const store = createLifecycleStateStore(paths);

    await expect(store[method]()).rejects.toThrow(`Invalid lifecycle JSON file: ${paths[key]}`);
  });

  it("coordinates real child-process reads, writes, and deletes without sharing failures", async () => {
    const paths = testPaths();
    const worker = resolve(projectRoot, "tests/fixtures/state-store-worker.mjs");
    const moduleUrl = pathToFileURL(resolve(projectRoot, "dist/lifecycle/state-store.js")).href;
    const iterations = 20;
    const arguments_ = [worker, moduleUrl, JSON.stringify(paths), String(iterations)];
    const workerCount = 6;
    const workers = Array.from({ length: workerCount }, (_, index) => new Promise<string>((resolve_, reject) => {
      const child = spawn(process.execPath, [...arguments_, String(index)], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve_(stdout.trim());
        else reject(new Error(`state worker ${index} exited ${code}: ${stderr.trim()}`));
      });
    }));

    const outputs = await Promise.all(workers);
    expect(outputs.every((output) => JSON.parse(output).ok === true)).toBe(true);
    const settings = JSON.parse(await readFile(paths.settingsPath, "utf8")) as { generation: number };
    expect(Number.isSafeInteger(settings.generation)).toBe(true);
    expect(settings.generation).toBeGreaterThan(0);
    expect(settings.generation).toBeLessThanOrEqual(workerCount * iterations);
    const runtimeContent = await readFile(paths.runtimePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (runtimeContent !== null) expect(() => JSON.parse(runtimeContent)).not.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp") || name.includes(".lock"))).toEqual([]);
  }, 30_000);

  it("clears runtime identity and tolerates an already missing file", async () => {
    const store = createLifecycleStateStore(testPaths());
    await store.writeRuntime({
      pid: 4312,
      version: "0.1.0",
      protocolVersion: 1,
      instanceNonce: "nonce-123",
      startedAt: "2026-09-01T01:02:03.000Z"
    });

    await store.clearRuntime();
    await store.clearRuntime();

    expect(await store.readRuntime()).toBeNull();
  });
});
