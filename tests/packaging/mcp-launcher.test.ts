import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const launcher = resolve(root, "plugins/codex-progress-hud/scripts/codex-progress-hud-launcher.exe");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function appData(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hud-launcher-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

function run(path: string, extraEnvironment: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(launcher, ["--mcp-stdio"], {
    env: { ...process.env, ...extraEnvironment, APPDATA: path },
    encoding: "utf8",
    input,
    windowsHide: true,
    shell: false
  });
}

async function manifest(appDataPath: string, value: unknown): Promise<void> {
  const path = join(appDataPath, "codex-progress-hud", "install.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

describe.runIf(process.platform === "win32")("packaged MCP launcher", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build-native-launcher.mjs"], { cwd: root, stdio: "pipe" });
  });
  it("keeps stdout empty and returns a coded error when not installed", async () => {
    const result = run(await appData());
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("COMPANION_NOT_INSTALLED");
  });

  it("rejects malformed and out-of-directory manifests", async () => {
    const first = await appData();
    await manifest(first, { executablePath: 3 });
    const malformed = run(first);
    expect(malformed.status).toBe(3);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("INVALID_INSTALL_MANIFEST");

    const second = await appData();
    await manifest(second, {
      executablePath: "C:\\outside\\Codex Progress HUD.exe",
      installDirectory: "C:\\inside",
      version: "0.2.0"
    });
    const outside = run(second);
    expect(outside.status).toBe(3);
    expect(outside.stdout).toBe("");
    expect(outside.stderr).toContain("INVALID_INSTALL_MANIFEST");
  });

  it("distinguishes an unavailable executable", async () => {
    const data = await appData();
    const installDirectory = join(data, "installed");
    await mkdir(installDirectory, { recursive: true });
    await manifest(data, {
      executablePath: join(installDirectory, "Codex Progress HUD.exe"),
      installDirectory,
      version: "0.2.0"
    });
    const result = run(data);
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("COMPANION_EXECUTABLE_MISSING");
  });

  it("distinguishes an installed executable with missing packaged resources", async () => {
    const data = await appData();
    const installDirectory = join(data, "installed");
    const executablePath = join(installDirectory, "Codex Progress HUD.exe");
    await mkdir(installDirectory, { recursive: true });
    await writeFile(executablePath, "incomplete bundle");
    await manifest(data, { executablePath, installDirectory, version: "0.2.0" });

    const result = run(data);

    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("COMPANION_EXECUTABLE_MISSING");
  });

  it("forwards stdin and --mcp-stdio, yields stdout, and propagates the executable exit code", async () => {
    const data = await appData();
    const installDirectory = join(data, "installed");
    const executablePath = join(installDirectory, "Codex Progress HUD.exe");
    const sourcePath = join(data, "fake-companion.cs");
    const archive = join(installDirectory, "resources", "app.asar");
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, "fixture", "utf8");
    await writeFile(sourcePath, [
      "using System;",
      "public static class Program {",
      "  public static int Main(string[] args) {",
      "    Console.Write(String.Join(\"|\", args) + \"|\" + Console.ReadLine());",
      "    int code;",
      "    return int.TryParse(Environment.GetEnvironmentVariable(\"HUD_FAKE_EXIT\"), out code) ? code : 0;",
      "  }",
      "}"
    ].join("\n"), "utf8");
    execFileSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", ["/nologo", `/out:${executablePath}`, sourcePath]);
    await manifest(data, { executablePath, installDirectory, version: "0.2.0" });

    const success = run(data, {}, "mcp-request\n");
    expect(success.status).toBe(0);
    expect(success.stdout.replaceAll("\\", "/").trimEnd()).toMatch(/resources\/app\.asar\/dist\/main\.js\|--mcp-stdio\|mcp-request$/u);
    expect(success.stderr).toBe("");

    const failed = run(data, { HUD_FAKE_EXIT: "7" }, "mcp-request\n");
    expect(failed.status).toBe(7);
    expect(failed.stdout.replaceAll("\\", "/").trimEnd()).toMatch(/resources\/app\.asar\/dist\/main\.js\|--mcp-stdio\|mcp-request$/u);
  });

  it("streams stdin before the MCP client closes its long-lived pipe", async () => {
    const data = await appData();
    const installDirectory = join(data, "installed");
    const executablePath = join(installDirectory, "Codex Progress HUD.exe");
    const sourcePath = join(data, "stream-probe.cs");
    const archive = join(installDirectory, "resources", "app.asar");
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, "fixture", "utf8");
    await writeFile(sourcePath, [
      "using System;",
      "public static class Program {",
      "  public static int Main() {",
      "    Console.WriteLine(Console.ReadLine());",
      "    return 0;",
      "  }",
      "}"
    ].join("\n"), "utf8");
    execFileSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", ["/nologo", `/out:${executablePath}`, sourcePath]);
    await manifest(data, { executablePath, installDirectory, version: "0.2.0" });

    const child = spawn(launcher, ["--mcp-stdio"], {
      env: { ...process.env, APPDATA: data },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    const output = new Promise<string>((resolveOutput, reject) => {
      const timer = setTimeout(() => reject(new Error("stdin was not streamed before EOF")), 2_000);
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (chunk: string) => {
        clearTimeout(timer);
        resolveOutput(chunk);
      });
    });
    child.stdin.write("live-request\n");

    await expect(output).resolves.toBe("live-request\r\n");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  });
});
