import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCompanionManager } from "../lifecycle/companion-manager.js";
import { processLauncher } from "../lifecycle/process-launcher.js";
import { createLifecycleStateStore } from "../lifecycle/state-store.js";
import {
  defaultDataDirectory,
  defaultDiagnosticsDirectory,
  defaultInstallManifestPath,
  defaultRuntimePath,
  defaultServiceUrl,
  defaultSettingsPath
} from "../server/paths.js";
import { CompanionHttpClient } from "./report-client.js";
import {
  createToolHandlers,
  progressReportSchema,
  taskOutcomeSchema,
  trackingStartSchema,
  taskControlSchema,
  validationObservedSchema
} from "./tools.js";

export async function runMcpServer(): Promise<void> {
  const version = "0.1.0";
  const server = new McpServer({ name: "codex-progress-hud", version });
  const progressClient = new CompanionHttpClient();
  const serviceUrl = new URL(defaultServiceUrl());
  const companionManager = createCompanionManager({
    store: createLifecycleStateStore({
      settingsPath: defaultSettingsPath(),
      runtimePath: defaultRuntimePath(),
      installManifestPath: defaultInstallManifestPath()
    }),
    client: progressClient,
    launcher: processLauncher,
    diagnostics: {
      directory: defaultDiagnosticsDirectory(),
      pluginVersion: version,
      mcpVersion: version,
      host: serviceUrl.hostname,
      port: Number(serviceUrl.port || (serviceUrl.protocol === "https:" ? 443 : 80)),
      installManifestPath: defaultInstallManifestPath(),
      dataDirectoryPath: defaultDataDirectory()
    }
  });
  const handlers = createToolHandlers({ progressClient, companionManager });

  server.registerTool(
    "progress_report",
    {
      title: "Report task progress",
      description:
        "Report a concise task phase, optional measured progress, ETA range, or waiting state to the local Progress HUD using the opaque task_handle injected by Hooks. Never include secrets, prompts, source code, reasoning, or command output.",
      inputSchema: progressReportSchema
    },
    (input) => handlers.progressReport(input)
  );

  server.registerTool(
    "task_outcome",
    {
      title: "Report task outcome",
      description:
        "Report a terminal semantic outcome for the opaque task_handle injected by Hooks. A verified claim requires a prior validation_observed report that actually passed; runtime failure and interruption remain authoritative.",
      inputSchema: taskOutcomeSchema
    },
    (input) => handlers.taskOutcome(input)
  );

  server.registerTool(
    "validation_observed",
    {
      title: "Report validation observation",
      description:
        "Report only whether bounded validation was observed to pass or fail for the opaque task_handle injected by Hooks. This is evidence, not a Codex execution control.",
      inputSchema: validationObservedSchema
    },
    (input) => handlers.validationObserved(input)
  );

  server.registerTool(
    "task_status",
    {
      title: "Read HUD task status",
      description: "Read the current local Progress HUD snapshot observationally; never launch or mutate the companion."
    },
    () => handlers.taskStatus()
  );

  server.registerTool(
    "tracking_start",
    {
      title: "Start HUD tracking",
      description:
        "Manually start or restart HUD tracking for the supplied opaque task_handle when the user explicitly requests it. This is not required for automatic Hook tracking and does not start or stop Codex execution.",
      inputSchema: trackingStartSchema
    },
    (input) => handlers.trackingStart(input)
  );

  server.registerTool(
    "tracking_pause",
    {
      title: "Pause HUD tracking",
      description:
        "Pause HUD updates and active-work timing for the supplied opaque task_handle. This is idempotent and does not pause Codex execution.",
      inputSchema: taskControlSchema
    },
    (input) => handlers.trackingPause(input)
  );

  server.registerTool(
    "tracking_resume",
    {
      title: "Resume HUD tracking",
      description: "Resume HUD updates and active-work timing for the supplied opaque task_handle. This is idempotent and does not resume or control Codex execution.",
      inputSchema: taskControlSchema
    },
    (input) => handlers.trackingResume(input)
  );

  server.registerTool(
    "tracking_stop",
    {
      title: "Stop HUD tracking",
      description:
        "Stop HUD tracking for the supplied opaque task_handle and keep its final snapshot visible. This is idempotent and does not stop Codex execution.",
      inputSchema: taskControlSchema
    },
    (input) => handlers.trackingStop(input)
  );

  server.registerTool(
    "tracking_status",
    {
      title: "Read HUD tracking status",
      description: "Read the current Progress HUD tracking snapshot observationally without launching the companion or changing task state."
    },
    () => handlers.trackingStatus()
  );

  server.registerTool(
    "hud_open",
    {
      title: "Open Progress HUD (Deprecated)",
      description: "Deprecated compatibility alias for one release: request the HUD window to open. Prefer the plugin page enable switch."
    },
    () => handlers.hudOpen()
  );

  server.registerTool(
    "hud_hide",
    { title: "Hide Progress HUD" },
    () => handlers.hudHide()
  );

  server.registerTool(
    "hud_close",
    {
      title: "Close Progress HUD (Deprecated)",
      description: "Deprecated compatibility alias for one release: request the HUD window/companion to close. Prefer the plugin page enable switch."
    },
    () => handlers.hudClose()
  );

  server.registerTool(
    "hud_status",
    { title: "Read Progress HUD lifecycle" },
    () => handlers.hudStatus()
  );

  server.registerTool(
    "hud_diagnose",
    { title: "Diagnose Progress HUD" },
    () => handlers.hudDiagnose()
  );

  await server.connect(new StdioServerTransport());
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void runMcpServer().catch((error: unknown) => {
    console.error("Codex Progress HUD MCP server failed to start", error);
    process.exitCode = 1;
  });
}
