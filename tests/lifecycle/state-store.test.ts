import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
