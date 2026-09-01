import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeDiagnosticReport,
  type DiagnosticReportInput
} from "../../src/diagnostics/report.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("diagnostic report", () => {
  it("writes only whitelisted lifecycle diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hud-diagnostic-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const input: DiagnosticReportInput & Record<string, unknown> = {
      directory,
      generatedAt: "2026-09-02T00:00:00.000Z",
      versions: { plugin: "0.2.0", mcp: "0.2.0", companion: "0.2.0", protocol: 1 },
      lifecycle: { desiredState: "on", observedState: "running" },
      paths: { installManifestExists: true, dataDirectoryExists: true },
      endpoint: { host: "127.0.0.1", port: 17_837 },
      runtimeAgeMs: 12_000,
      errors: [{ code: "AUTH_ERROR", occurredAt: "2026-09-02T00:00:00.000Z" }],
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
});
