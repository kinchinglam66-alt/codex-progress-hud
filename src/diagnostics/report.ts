import { basename, join } from "node:path";
import type { DesiredHudState, HudErrorCode, ObservedHudState } from "../lifecycle/types.js";
import {
  assertTrustedDirectory,
  ensureTrustedDirectory,
  openVerifiedCreate,
  regularFileInformation
} from "./safe-files.js";

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

const DESIRED_STATES = new Set<DesiredHudState>(["on", "off"]);
const OBSERVED_STATES = new Set<ObservedHudState>([
  "starting", "running", "hidden", "stopped", "crashed", "incompatible", "port_conflict"
]);
const ERROR_CODES = new Set<HudErrorCode | "OFFLINE">([
  "COMPANION_NOT_INSTALLED", "MANUALLY_DISABLED", "PORT_CONFLICT", "VERSION_MISMATCH",
  "START_TIMEOUT", "AUTH_ERROR", "SHUTDOWN_TIMEOUT", "COMPANION_CRASHED",
  "INTERNAL_ERROR", "OFFLINE"
]);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function version(value: unknown, name: string): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a safe version`);
  }
  return value;
}

function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be a bounded integer`);
  }
  return value as number;
}

function markdownValue(value: string | number | boolean | undefined): string {
  if (value === undefined) return "unknown";
  return String(value).replace(/[\\`*{}\[\]<>#|]/gu, "\\$&");
}

function line(label: string, value: string | number | boolean | undefined): string {
  return `- ${label}: ${markdownValue(value)}`;
}

function snapshotInput(input: DiagnosticReportInput): Omit<DiagnosticReportInput, "directory"> {
  const generatedAt = canonicalTimestamp(input.generatedAt, "generatedAt");
  const versionsInput = input.versions;
  const plugin = version(versionsInput.plugin, "plugin version");
  const mcp = version(versionsInput.mcp, "MCP version");
  const companionValue = versionsInput.companion;
  const companion = companionValue === undefined
    ? undefined
    : version(companionValue, "companion version");
  const protocol = safeInteger(versionsInput.protocol, "protocol version", 1, 65_535);
  const lifecycleInput = input.lifecycle;
  const desiredState = lifecycleInput.desiredState;
  if (desiredState !== undefined && !DESIRED_STATES.has(desiredState)) {
    throw new TypeError("desired state must be allowed");
  }
  const observedState = lifecycleInput.observedState;
  if (!OBSERVED_STATES.has(observedState)) throw new TypeError("observed state must be allowed");
  const pathsInput = input.paths;
  const installManifestExists = pathsInput.installManifestExists;
  const dataDirectoryExists = pathsInput.dataDirectoryExists;
  if (typeof installManifestExists !== "boolean" || typeof dataDirectoryExists !== "boolean") {
    throw new TypeError("path checks must be booleans");
  }
  const endpointInput = input.endpoint;
  const host = endpointInput.host;
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new TypeError("host must be a loopback endpoint");
  }
  const port = safeInteger(endpointInput.port, "port", 1, 65_535);
  const runtimeAgeValue = input.runtimeAgeMs;
  if (
    runtimeAgeValue !== undefined &&
    (!Number.isSafeInteger(runtimeAgeValue) || runtimeAgeValue < 0)
  ) {
    throw new TypeError("runtime age must be a non-negative bounded integer");
  }
  const errorsInput = input.errors;
  if (!Array.isArray(errorsInput)) {
    throw new TypeError("errors must be a bounded array");
  }
  const errorsLength = errorsInput.length;
  if (!Number.isSafeInteger(errorsLength) || errorsLength < 0 || errorsLength > 10) {
    throw new TypeError("errors must be a bounded array");
  }
  const errors: DiagnosticReportInput["errors"] = [];
  for (let index = 0; index < errorsLength; index += 1) {
    const error = Reflect.get(errorsInput, String(index)) as DiagnosticReportInput["errors"][number];
    if (typeof error !== "object" || error === null) {
      throw new TypeError("error entry must be an object");
    }
    const code = error.code;
    if (!ERROR_CODES.has(code)) throw new TypeError("error code must be allowed");
    const occurredAtValue = error.occurredAt;
    errors.push({
      code,
      ...(occurredAtValue === undefined
        ? {}
        : { occurredAt: canonicalTimestamp(occurredAtValue, `error ${index} time`) })
    });
  }
  return {
    generatedAt,
    versions: { plugin, mcp, ...(companion === undefined ? {} : { companion }), protocol },
    lifecycle: { ...(desiredState === undefined ? {} : { desiredState }), observedState },
    paths: { installManifestExists, dataDirectoryExists },
    endpoint: { host, port },
    ...(runtimeAgeValue === undefined ? {} : { runtimeAgeMs: runtimeAgeValue }),
    errors
  };
}

export async function writeDiagnosticReport(
  input: DiagnosticReportInput
): Promise<{ path: string }> {
  const directory = input.directory;
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("directory must be a non-empty path");
  }
  const snapshot = snapshotInput(input);
  const trustedDirectory = await ensureTrustedDirectory(directory);
  const filename = `codex-progress-hud-${snapshot.generatedAt.replace(/[:.]/g, "-")}.md`;
  const errors = snapshot.errors.length === 0
    ? "- None"
    : snapshot.errors.map((error) => line("Code", error.code)).join("\n");
  const hostForUri = snapshot.endpoint.host === "::1" ? "[::1]" : snapshot.endpoint.host;
  const markdown = [
    "# Codex Progress HUD Diagnostic",
    "",
    line("Generated at", snapshot.generatedAt),
    "",
    "## Versions",
    "",
    line("Plugin version", snapshot.versions.plugin),
    line("MCP version", snapshot.versions.mcp),
    line("Companion version", snapshot.versions.companion),
    line("Protocol version", snapshot.versions.protocol),
    "",
    "## Lifecycle",
    "",
    line("Desired state", snapshot.lifecycle.desiredState),
    line("Observed state", snapshot.lifecycle.observedState),
    line("Runtime age (ms)", snapshot.runtimeAgeMs),
    "",
    "## Local endpoint",
    "",
    line("Host", snapshot.endpoint.host),
    line("Port", snapshot.endpoint.port),
    "",
    "## Path checks",
    "",
    line("%APPDATA%\\codex-progress-hud\\install.json", snapshot.paths.installManifestExists),
    line("%APPDATA%\\codex-progress-hud", snapshot.paths.dataDirectoryExists),
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
    `Invoke-RestMethod -Uri "http://${hostForUri}:${snapshot.endpoint.port}/health"`,
    "```",
    ""
  ].join("\n");
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = join(
      trustedDirectory.path,
      suffix === 0 ? filename : filename.replace(/\.md$/u, `-${suffix}.md`)
    );
    try {
      const handle = await openVerifiedCreate(trustedDirectory, basename(candidate));
      try {
        await handle.writeFile(markdown, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
      return { path: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertTrustedDirectory(trustedDirectory);
      const existing = await regularFileInformation(candidate);
      if (existing === null) throw error;
    }
  }
  throw new Error("diagnostic report filename space exhausted");
}
