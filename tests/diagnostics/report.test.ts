import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeDiagnosticReport,
  renderDiagnosticReport,
  type DiagnosticReportInput
} from "../../src/diagnostics/report.js";

const cleanups: Array<() => Promise<void>> = [];

function validInput(directory: string): DiagnosticReportInput {
  return {
    directory,
    generatedAt: "2026-09-02T00:00:00.000Z",
    versions: { plugin: "0.2.0", mcp: "0.2.0", companion: "0.2.0", protocol: 1 },
    lifecycle: { desiredState: "on", observedState: "running" },
    paths: { installManifestExists: true, dataDirectoryExists: true },
    endpoint: { host: "127.0.0.1", port: 17_837 },
    runtimeAgeMs: 12_000,
    errors: [{ code: "AUTH_ERROR", occurredAt: "2026-09-02T00:00:00.000Z" }]
  };
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("diagnostic report", () => {
  it("reports window rendering separately and strips arbitrary diagnostic content", () => {
    const input = { ...validInput("unused"), windowDiagnostics: {
      exists: true, visible: true, page: "failed", renderer: "gone", domReady: false, readyToShow: true,
      loadErrorCode: -7, rendererExitCode: 9, token: "private-secret", url: "https://private-secret",
      bounds: { x: 1, y: 2, width: 340, height: 82, title: "private-secret" }
    } };
    const report = renderDiagnosticReport(input as DiagnosticReportInput);
    expect(report).toContain("Window visible (native flag): true");
    expect(report).toContain("Page load: failed");
    expect(report).toContain("Renderer state: gone");
    expect(report).toContain("Load error code: -7");
    expect(report).not.toContain("private-secret");
    expect(() => renderDiagnosticReport({ ...input, windowDiagnostics: { ...input.windowDiagnostics, page: "private-secret" } } as any)).toThrow();
  });
  it("reports installation, Hook trust/activity, MCP lease, companion, compatibility, and tracking separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-dimensions-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const input = {
      ...validInput(directory),
      paths: { installManifestExists: false, dataDirectoryExists: true },
      lifecycle: { observedState: "stopped" as const },
      hooks: { expected: true, trusted: false, activitySeen: false, lastEventAt: 0 },
      lease: { active: false, count: 0 },
      compatibility: { compatible: false, incompatibleClientSeen: true },
      tracking: { taskCount: 1, selectedStatus: "quiescent" as const, lateAttached: true }
    };

    const result = await writeDiagnosticReport(input as any);
    const markdown = await readFile(result.path, "utf8");

    expect(markdown).toContain("Installation: not detected");
    expect(markdown).toContain("Hook trust/activity: not trusted; no activity");
    expect(markdown).toContain("MCP lease: disconnected");
    expect(markdown).toContain("Companion process: offline");
    expect(markdown).toContain("Protocol compatibility: mismatch");
    expect(markdown).toContain("Tracking: active but quiescent; late-attached");
  });

  it("does not turn an incompatible reachable companion offline and preserves prior client mismatch evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-truthful-state-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const result = await writeDiagnosticReport({
      ...validInput(directory),
      lifecycle: { observedState: "incompatible" },
      hooks: { expected: false, trusted: false, activitySeen: false },
      compatibility: { compatible: true, incompatibleClientSeen: true },
      operationalEvents: [{ code: "protocol_mismatch", at: "2026-09-02T00:00:00.000Z" }]
    });
    const markdown = await readFile(result.path, "utf8");

    expect(markdown).toContain("Hook trust/activity: not expected by this plugin build");
    expect(markdown).toContain("Companion process: online");
    expect(markdown).toContain("Protocol compatibility: compatible; incompatible client seen");
    expect(markdown).toContain("protocol_mismatch at 2026-09-02T00:00:00.000Z");
  });

  it("does not claim an expected Hook is untrusted before activity is observed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-hook-unknown-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const result = await writeDiagnosticReport({
      ...validInput(directory),
      hooks: { expected: true, activitySeen: false }
    });
    const markdown = await readFile(result.path, "utf8");

    expect(markdown).toContain("Hook trust/activity: expected; trust not confirmed; no activity");
    expect(markdown).not.toContain("untrusted");
  });

  it("keeps diagnostic output content-free even when runtime inputs contain secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-content-free-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const input = {
      ...validInput(directory),
      hooks: {
        expected: true, trusted: true, activitySeen: true, lastEventAt: 1,
        session_id: "raw-session-secret", prompt: "private prompt", cwd: "C:\\private\\repo"
      },
      tracking: {
        taskCount: 1, selectedStatus: "running" as const, lateAttached: false,
        title: "private task title", taskHandle: "raw-handle-secret"
      },
      operationalEvents: [{ code: "hook_received", at: "2026-09-02T00:00:00.000Z", payload: "secret" }]
    };

    const result = await writeDiagnosticReport(input as any);
    const markdown = await readFile(result.path, "utf8");
    for (const secret of ["raw-session-secret", "private prompt", "C:\\private\\repo", "private task title", "raw-handle-secret", "secret"]) {
      expect(markdown).not.toContain(secret);
    }
    expect(markdown).toContain("hook_received");
    expect(markdown).toContain("2026-09-02T00:00:00.000Z");
  });

  it("writes only whitelisted lifecycle diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const input: DiagnosticReportInput & Record<string, unknown> = {
      ...validInput(directory),
      bearerToken: "super-secret-token",
      taskTitle: "Secret task title",
      taskId: "secret-task-id",
      sourcePath: "C:\\secret\\source.ts",
      commandOutput: "private command output",
      arbitraryContents: { private: "arbitrary private contents" }
    };
    const result = await writeDiagnosticReport(input);

    const markdown = await readFile(result.path, "utf8");
    expect(markdown).toContain("Plugin version: 0.2.0");
    expect(markdown).toContain("Observed state: running");
    expect(markdown).toContain("Host: 127.0.0.1");
    expect(markdown).toContain("AUTH_ERROR");
    expect(markdown).toContain("%APPDATA%\\codex-progress-hud\\install.json: true");
    expect(markdown).toContain("%APPDATA%\\codex-progress-hud: true");
    expect(markdown).toContain("## Safe verification commands");
    expect(markdown).toContain('Test-Path "$env:APPDATA\\codex-progress-hud\\install.json"');
    expect(markdown).toContain('Invoke-RestMethod -Uri "http://127.0.0.1:17837/health"');
    expect(result.path).toMatch(/^[A-Za-z]:\\|^\//u);
    for (const secret of [
      "Bearer secret",
      "token=secret",
      "super-secret-token",
      "Secret task title",
      "secret-task-id",
      "C:\\secret\\source.ts",
      "private command output",
      "arbitrary private contents"
    ]) {
      expect(markdown).not.toContain(secret);
    }
    expect(markdown).not.toContain(directory);
  });

  it.each([
    ["generated time", (input: any) => { input.generatedAt = "September 2, 2026"; }],
    ["plugin version", (input: any) => { input.versions.plugin = "0.2.0\nBearer secret"; }],
    ["MCP version", (input: any) => { input.versions.mcp = "token=secret"; }],
    ["companion version", (input: any) => { input.versions.companion = "[private](file:///source)"; }],
    ["protocol", (input: any) => { input.versions.protocol = Number.NaN; }],
    ["desired state", (input: any) => { input.lifecycle.desiredState = "Bearer secret"; }],
    ["observed state", (input: any) => { input.lifecycle.observedState = "running\n# injected"; }],
    ["path boolean", (input: any) => { input.paths.installManifestExists = "C:\\private"; }],
    ["host", (input: any) => { input.endpoint.host = '127.0.0.1"; Write-Output secret; #'; }],
    ["port", (input: any) => { input.endpoint.port = 70_000; }],
    ["runtime age", (input: any) => { input.runtimeAgeMs = Number.POSITIVE_INFINITY; }],
    ["error code", (input: any) => { input.errors[0].code = "Bearer secret"; }],
    ["error time", (input: any) => { input.errors[0].occurredAt = "token=secret"; }]
  ])("rejects invalid %s values before creating a report", async (_label, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-invalid-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const input = validInput(directory) as any;
    mutate(input);

    await expect(writeDiagnosticReport(input)).rejects.toThrow();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("does not invoke Proxy-controlled collection methods while snapshotting errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-proxy-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    let mapReads = 0;
    let lengthReads = 0;
    let elementReads = 0;
    const errors = new Proxy([] as Array<{ code: string }>, {
      get(_target, property) {
        if (property === "map") {
          mapReads += 1;
          return () => [{ code: "Bearer secret" }];
        }
        if (property === "length") {
          lengthReads += 1;
          return 1;
        }
        if (property === "0") {
          elementReads += 1;
          return { code: elementReads === 1 ? "AUTH_ERROR" : "Bearer secret" };
        }
        return undefined;
      }
    });
    const input = validInput(directory);
    input.errors = errors as DiagnosticReportInput["errors"];

    const result = await writeDiagnosticReport(input);

    const markdown = await readFile(result.path, "utf8");
    expect(markdown).toContain("AUTH_ERROR");
    expect(markdown).not.toContain("Bearer secret");
    expect({ mapReads, lengthReads, elementReads }).toEqual({
      mapReads: 0,
      lengthReads: 1,
      elementReads: 1
    });
  });

  it("returns an absolute path for a relative configured directory", async () => {
    const directory = await mkdtemp(join(process.cwd(), "hud-relative-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const result = await writeDiagnosticReport(validInput(relative(process.cwd(), directory)));

    expect(isAbsolute(result.path)).toBe(true);
    await expect(readFile(result.path, "utf8")).resolves.toContain("# Codex Progress HUD Diagnostic");
  });

  it("rejects a linked report directory instead of writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hud-diagnostic-link-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "redirect-target");
    const linked = join(root, "linked-reports");
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");

    await expect(writeDiagnosticReport(validInput(linked))).rejects.toThrow(/link|trusted directory/iu);
    await expect(readdir(target)).resolves.toEqual([]);
  });

  it("rejects an ancestor junction before creating a missing child through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hud-diagnostic-ancestor-link-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const outside = join(root, "outside");
    const linkedAncestor = join(root, "linked-ancestor");
    const missingChild = join(linkedAncestor, "must-not-be-created");
    await mkdir(outside);
    await symlink(outside, linkedAncestor, process.platform === "win32" ? "junction" : "dir");

    await expect(writeDiagnosticReport(validInput(missingChild))).rejects.toThrow(
      /link|trusted directory/iu
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("never overwrites an existing predictable report filename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-existing-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const predictable = join(directory, "codex-progress-hud-2026-09-02T00-00-00-000Z.md");
    await writeFile(predictable, "do-not-overwrite");

    const result = await writeDiagnosticReport(validInput(directory));

    expect(result.path).not.toBe(predictable);
    await expect(readFile(predictable, "utf8")).resolves.toBe("do-not-overwrite");
  });

  it("rejects a linked predictable report file without changing its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-file-link-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const target = join(directory, "redirect-target.txt");
    const predictable = join(directory, "codex-progress-hud-2026-09-02T00-00-00-000Z.md");
    await writeFile(target, "do-not-change");
    await link(target, predictable);

    await expect(writeDiagnosticReport(validInput(directory))).rejects.toThrow(/regular file|link/iu);
    await expect(readFile(target, "utf8")).resolves.toBe("do-not-change");
  });
});
