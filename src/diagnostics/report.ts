import { basename, join } from "node:path";
import { windowDiagnosticsSchema, type WindowDiagnostics } from "./window-state.js";
import type { DesiredHudState, HudErrorCode, ObservedHudState } from "../lifecycle/types.js";
import type { TaskStatus } from "../core/types.js";
import type { OperationalEventCode } from "./logger.js";
import {
  assertTrustedDirectory,
  ensureTrustedDirectory,
  nodeFileSystemOperations,
  openVerifiedCreate,
  regularFileInformation,
  type FileSystemOperations
} from "./safe-files.js";

export interface DiagnosticReportInput {
  windowDiagnostics?: WindowDiagnostics;
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
  hooks?: { expected: boolean; trusted?: boolean; activitySeen: boolean; lastEventAt?: number };
  lease?: { active: boolean; count: number };
  compatibility?: { compatible: boolean; incompatibleClientSeen: boolean };
  tracking?: { taskCount: number; selectedStatus?: TaskStatus; lateAttached: boolean };
  operationalEvents?: Array<{ code: OperationalEventCode; at: string }>;
}

const DESIRED_STATES = new Set<DesiredHudState>(["on", "off"]);
const OBSERVED_STATES = new Set<ObservedHudState>([
  "starting", "running", "hidden", "stopped", "crashed", "unresponsive", "incompatible", "port_conflict"
]);
const ERROR_CODES = new Set<HudErrorCode | "OFFLINE">([
  "COMPANION_NOT_INSTALLED", "MANUALLY_DISABLED", "PORT_CONFLICT", "VERSION_MISMATCH",
  "START_TIMEOUT", "AUTH_ERROR", "SHUTDOWN_TIMEOUT", "COMPANION_CRASHED",
  "INTERNAL_ERROR", "OFFLINE"
]);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const TASK_STATUSES = new Set<TaskStatus>([
  "idle", "running", "quiescent", "paused", "stopped", "waiting_approval", "waiting_user",
  "stalled_suspected", "disconnected_suspected", "ended_unknown", "completed_unverified",
  "succeeded_verified", "failed", "interrupted"
]);
const OPERATIONAL_CODES = new Set<OperationalEventCode>([
  "startup_requested", "startup_ready", "startup_failed", "shutdown_requested",
  "shutdown_complete", "shutdown_timeout", "port_conflict", "protocol_mismatch", "child_exit",
  "crash_recovery", "hook_received", "hook_failed", "lease_acquired", "lease_expired",
  "late_attach", "stale_revision"
]);

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
  const hooksInput = input.hooks;
  const hooks = hooksInput === undefined ? undefined : {
    expected: hooksInput.expected,
    ...(hooksInput.trusted === undefined ? {} : { trusted: hooksInput.trusted }),
    activitySeen: hooksInput.activitySeen,
    ...(hooksInput.lastEventAt === undefined ? {} : { lastEventAt: safeInteger(hooksInput.lastEventAt, "Hook last event", 0, Number.MAX_SAFE_INTEGER) })
  };
  if (hooks !== undefined && (typeof hooks.expected !== "boolean" || (hooks.trusted !== undefined && typeof hooks.trusted !== "boolean") || typeof hooks.activitySeen !== "boolean")) throw new TypeError("Hook diagnostics must be booleans");
  const leaseInput = input.lease;
  const lease = leaseInput === undefined ? undefined : { active: leaseInput.active, count: safeInteger(leaseInput.count, "lease count", 0, 1_000) };
  if (lease !== undefined && typeof lease.active !== "boolean") throw new TypeError("lease state must be boolean");
  const compatibilityInput = input.compatibility;
  const compatibility = compatibilityInput === undefined ? undefined : { compatible: compatibilityInput.compatible, incompatibleClientSeen: compatibilityInput.incompatibleClientSeen };
  if (compatibility !== undefined && (typeof compatibility.compatible !== "boolean" || typeof compatibility.incompatibleClientSeen !== "boolean")) throw new TypeError("compatibility diagnostics must be booleans");
  const trackingInput = input.tracking;
  const tracking = trackingInput === undefined ? undefined : { taskCount: safeInteger(trackingInput.taskCount, "task count", 0, 1_000), ...(trackingInput.selectedStatus === undefined ? {} : { selectedStatus: trackingInput.selectedStatus }), lateAttached: trackingInput.lateAttached };
  if (tracking !== undefined && (typeof tracking.lateAttached !== "boolean" || (tracking.selectedStatus !== undefined && !TASK_STATUSES.has(tracking.selectedStatus)))) throw new TypeError("tracking diagnostics are invalid");
  const operationalEventsInput = input.operationalEvents;
  const operationalEvents = operationalEventsInput === undefined ? undefined : (() => {
    if (!Array.isArray(operationalEventsInput) || operationalEventsInput.length > 20) throw new TypeError("operational events must be bounded");
    return operationalEventsInput.map((event, index) => {
      if (typeof event !== "object" || event === null || !OPERATIONAL_CODES.has(event.code)) throw new TypeError(`operational event ${index} is invalid`);
      return { code: event.code, at: canonicalTimestamp(event.at, `operational event ${index} time`) };
    });
  })();
  return {
    generatedAt,
    ...(input.windowDiagnostics === undefined ? {} : { windowDiagnostics: windowDiagnosticsSchema.parse(input.windowDiagnostics) }),
    versions: { plugin, mcp, ...(companion === undefined ? {} : { companion }), protocol },
    lifecycle: { ...(desiredState === undefined ? {} : { desiredState }), observedState },
    paths: { installManifestExists, dataDirectoryExists },
    endpoint: { host, port },
    ...(runtimeAgeValue === undefined ? {} : { runtimeAgeMs: runtimeAgeValue }),
    errors,
    ...(hooks === undefined ? {} : { hooks }),
    ...(lease === undefined ? {} : { lease }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(tracking === undefined ? {} : { tracking }),
    ...(operationalEvents === undefined ? {} : { operationalEvents })
  };
}

function formatSnapshot(snapshot: Omit<DiagnosticReportInput, "directory">): string {
  const errors = snapshot.errors.length === 0
    ? "- None"
    : snapshot.errors.map((error) => line("Code", error.code)).join("\n");
  const installation = snapshot.paths.installManifestExists ? "detected" : "not detected";
  const hookConclusion = snapshot.hooks === undefined
    ? "not reported"
    : !snapshot.hooks.expected
      ? "not expected by this plugin build"
      : snapshot.hooks.trusted === false
        ? `not trusted; ${snapshot.hooks.activitySeen ? "activity seen" : "no activity"}`
        : snapshot.hooks.trusted === undefined
          ? `expected; trust not confirmed; ${snapshot.hooks.activitySeen ? "activity seen" : "no activity"}`
        : !snapshot.hooks.activitySeen ? "trusted; no activity" : "trusted; activity seen";
  const leaseConclusion = snapshot.lease === undefined
    ? "not reported" : snapshot.lease.active ? `connected (${snapshot.lease.count})` : "disconnected";
  const companionConclusion = snapshot.lifecycle.observedState === "unresponsive" ? "unresponsive"
    : ["running", "starting", "hidden", "incompatible"].includes(snapshot.lifecycle.observedState) ? "online" : "offline";
  const compatibilityConclusion = snapshot.compatibility === undefined
    ? "not reported" : snapshot.compatibility.compatible ? "compatible" : "mismatch";
  const compatibilityDetail = snapshot.compatibility?.incompatibleClientSeen
    ? `${compatibilityConclusion}; incompatible client seen`
    : compatibilityConclusion;
  const trackingConclusion = snapshot.tracking === undefined
    ? "not reported"
    : snapshot.tracking.selectedStatus === "quiescent"
      ? `active but quiescent${snapshot.tracking.lateAttached ? "; late-attached" : ""}`
      : `${snapshot.tracking.taskCount} task(s)${snapshot.tracking.lateAttached ? "; late-attached" : ""}`;
  const eventLines = snapshot.operationalEvents === undefined || snapshot.operationalEvents.length === 0
    ? "- None"
    : snapshot.operationalEvents.map((event) => `- ${event.code} at ${event.at}`).join("\n");
  const hostForUri = snapshot.endpoint.host === "::1" ? "[::1]" : snapshot.endpoint.host;
  const markdown = [
    "# Codex Progress HUD Diagnostic",
    "",
    line("Generated at", snapshot.generatedAt),
    "",
    "## Conclusion",
    "",
    `- Installation: ${installation}`,
    `- Hook trust/activity: ${hookConclusion}`,
    `- MCP lease: ${leaseConclusion}`,
    `- Companion process: ${companionConclusion}`,
    `- Protocol compatibility: ${compatibilityDetail}`,
    `- Tracking: ${trackingConclusion}`,
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
    "## Window rendering (not proof of on-screen pixels)",
    "",
    line("Window exists", snapshot.windowDiagnostics?.exists),
    line("Window visible (native flag)", snapshot.windowDiagnostics?.visible),
    line("Page load", snapshot.windowDiagnostics?.page),
    line("DOM ready", snapshot.windowDiagnostics?.domReady),
    line("Ready to show", snapshot.windowDiagnostics?.readyToShow),
    line("Renderer state", snapshot.windowDiagnostics?.renderer),
    line("Load error code", snapshot.windowDiagnostics?.loadErrorCode),
    line("Renderer exit code", snapshot.windowDiagnostics?.rendererExitCode),
    line("Content probe (one-shot)", snapshot.windowDiagnostics?.content?.status),
    line("DOM flags and dimensions", snapshot.windowDiagnostics?.content?.dom === undefined ? undefined : JSON.stringify(snapshot.windowDiagnostics.content.dom)),
    line("Internal paint sample statistics", snapshot.windowDiagnostics?.content?.paint === undefined ? undefined : JSON.stringify(snapshot.windowDiagnostics.content.paint)),
    line("Window bounds", snapshot.windowDiagnostics?.bounds === undefined ? undefined : JSON.stringify(snapshot.windowDiagnostics.bounds)),
    "",
    "## Local endpoint",
    "",
    line("Host", snapshot.endpoint.host),
    line("Port", snapshot.endpoint.port),
    "",
    "## Path checks",
    "",
    line("%USERPROFILE%\\.codex-progress-hud\\install.json", snapshot.paths.installManifestExists),
    line("%USERPROFILE%\\.codex-progress-hud", snapshot.paths.dataDirectoryExists),
    "",
    "## Categorized errors",
    "",
    errors,
    "",
    "## Operational history (codes and timestamps only)",
    "",
    eventLines,
    "",
    "## Safe verification commands",
    "",
    "```powershell",
    'Test-Path "$env:USERPROFILE\\.codex-progress-hud\\install.json"',
    'Test-Path "$env:USERPROFILE\\.codex-progress-hud\\runtime.json"',
    `Invoke-RestMethod -Uri "http://${hostForUri}:${snapshot.endpoint.port}/health"`,
    "```",
    ""
  ].join("\n");
  return markdown;
}

/** The same allowlisted report is available without filesystem access. */
export function renderDiagnosticReport(input: DiagnosticReportInput): string {
  return formatSnapshot(snapshotInput(input));
}

async function writeDiagnosticReportWithFileSystem(
  input: DiagnosticReportInput,
  fileSystem: FileSystemOperations
): Promise<{ path: string }> {
  const directory = input.directory;
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("directory must be a non-empty path");
  }
  const snapshot = snapshotInput(input);
  const markdown = formatSnapshot(snapshot);
  const trustedDirectory = await ensureTrustedDirectory(directory, fileSystem);
  const filename = `codex-progress-hud-${snapshot.generatedAt.replace(/[:.]/g, "-")}.md`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = join(
      trustedDirectory.path,
      suffix === 0 ? filename : filename.replace(/\.md$/u, `-${suffix}.md`)
    );
    try {
      const handle = await openVerifiedCreate(
        trustedDirectory,
        basename(candidate),
        fileSystem
      );
      try {
        await handle.writeFile(markdown, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
      return { path: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertTrustedDirectory(trustedDirectory, fileSystem);
      const existing = await regularFileInformation(candidate, fileSystem);
      if (existing === null) throw error;
    }
  }
  throw new Error("diagnostic report filename space exhausted");
}

/** Internal composition seam for deterministic filesystem-boundary tests. */
export function createDiagnosticReportWriter(
  fileSystem: FileSystemOperations
): (input: DiagnosticReportInput) => Promise<{ path: string }> {
  return (input) => writeDiagnosticReportWithFileSystem(input, fileSystem);
}

export async function writeDiagnosticReport(
  input: DiagnosticReportInput
): Promise<{ path: string }> {
  return writeDiagnosticReportWithFileSystem(input, nodeFileSystemOperations);
}
