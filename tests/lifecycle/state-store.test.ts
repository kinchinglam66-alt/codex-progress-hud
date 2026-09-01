import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLifecycleStateStore } from "../../src/lifecycle/state-store.js";
import {
  defaultDiagnosticsDirectory,
  defaultInstallManifestPath,
  defaultLogDirectory,
  defaultRuntimePath,
  defaultSettingsPath
} from "../../src/server/paths.js";

let directory: string;

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

    expect(await store.readSettings()).toEqual({ startWithWindows: false });
    expect(await store.readRuntime()).toBeNull();
    expect(await store.readInstallManifest()).toBeNull();
  });

  it("persists explicit off without inventing other settings", async () => {
    const paths = testPaths();
    const store = createLifecycleStateStore(paths);

    await store.setDesiredState("off");

    expect(await store.readSettings()).toEqual({
      desiredState: "off",
      startWithWindows: false
    });
    expect(await readFile(paths.settingsPath, "utf8")).toBe(
      '{"startWithWindows":false,"desiredState":"off"}\n'
    );
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves start-with-Windows when changing desired state", async () => {
    const paths = testPaths();
    await writeFile(paths.settingsPath, '{"desiredState":"on","startWithWindows":true}\n');
    const store = createLifecycleStateStore(paths);

    expect(await store.setDesiredState("off")).toEqual({
      desiredState: "off",
      startWithWindows: true
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
        startWithWindows: false
      })
    );
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
