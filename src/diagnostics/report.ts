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
  [key: string]: unknown;
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
    "# Codex Progress HUD Diagnostic Report",
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
    line("Install manifest exists", input.paths.installManifestExists),
    line("Data directory exists", input.paths.dataDirectoryExists),
    "",
    "## Categorized errors",
    "",
    errors,
    ""
  ].join("\n");
  await writeFile(path, markdown, { encoding: "utf8", mode: 0o600 });
  return { path };
}
