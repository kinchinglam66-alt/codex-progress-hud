import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesiredHudState, HudErrorCode, ObservedHudState } from "../lifecycle/types.js";

export interface DiagnosticReportInput {
  directory: string;
  generatedAt: string;
  versions: {
    plugin: string;
    mcp: string;
    companion?: string;
    protocol: number;
  };
  lifecycle: {
    desiredState?: DesiredHudState;
    observedState: ObservedHudState;
  };
  paths: {
    installManifestExists: boolean;
    dataDirectoryExists: boolean;
  };
  endpoint: { host: string; port: number };
  runtimeAgeMs?: number;
  errors: Array<{ code: HudErrorCode | "OFFLINE"; occurredAt?: string }>;
}

function line(label: string, value: string | number | boolean | undefined): string {
  return `- ${label}: ${value ?? "unknown"}`;
}

export async function writeDiagnosticReport(
  input: DiagnosticReportInput
): Promise<{ path: string }> {
  await mkdir(input.directory, { recursive: true });
  const filename = `codex-progress-hud-${input.generatedAt.replace(/[:.]/g, "-")}.md`;
  const path = join(input.directory, filename);
  const errors = input.errors.length === 0
    ? "- None"
    : input.errors.map((error) => line("Code", error.code)).join("\n");
  const markdown = [
    "# Codex Progress HUD Diagnostic",
    "",
    line("Generated at", input.generatedAt),
    "",
    "## Versions",
    "",
    line("Plugin version", input.versions.plugin),
    line("MCP version", input.versions.mcp),
    line("Companion version", input.versions.companion),
    line("Protocol version", input.versions.protocol),
    "",
    "## Lifecycle",
    "",
    line("Desired state", input.lifecycle.desiredState),
    line("Observed state", input.lifecycle.observedState),
    line("Runtime age (ms)", input.runtimeAgeMs),
    "",
    "## Local endpoint",
    "",
    line("Host", input.endpoint.host),
    line("Port", input.endpoint.port),
    "",
    "## Path checks",
    "",
    line("%APPDATA%\\codex-progress-hud\\install.json", input.paths.installManifestExists),
    line("%APPDATA%\\codex-progress-hud", input.paths.dataDirectoryExists),
    "",
    "## Categorized errors",
    "",
    errors,
    "",
    "## Safe verification commands",
    "",
    "```powershell",
    'Test-Path "$env:APPDATA\\codex-progress-hud\\install.json"',
    'Test-Path "$env:APPDATA\\codex-progress-hud\\runtime.json"',
    `Invoke-RestMethod -Uri "http://${input.endpoint.host}:${input.endpoint.port}/health"`,
    "```",
    ""
  ].join("\n");
  await writeFile(path, markdown, { encoding: "utf8", mode: 0o600 });
  return { path };
}
