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
  trackingStartSchema
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
        "Report a concise task phase, optional measured progress, ETA range, or waiting state to the local Progress HUD. Never include secrets, prompts, source code, reasoning, or command output.",
      inputSchema: progressReportSchema
    },
    (input) => handlers.progressReport(input)
  );

  server.registerTool(
    "task_outcome",
    {
      title: "Report task outcome",
      description:
        "Report a terminal semantic outcome. Set verified only when validation evidence actually ran and passed.",
      inputSchema: taskOutcomeSchema
    },
    (input) => handlers.taskOutcome(input)
  );

  server.registerTool(
    "task_status",
    {
      title: "Read HUD task status",
      description: "Read the current local Progress HUD snapshot."
    },
    () => handlers.taskStatus()
  );

  server.registerTool(
    "tracking_start",
    {
      title: "Start HUD tracking",
      description:
        "Start or restart Progress HUD tracking for the current task. Use when the user explicitly asks to start tracking. Optional task_id and title identify a new current task.",
      inputSchema: trackingStartSchema
    },
    (input) => handlers.trackingStart(input)
  );

  server.registerTool(
    "tracking_pause",
    {
      title: "Pause HUD tracking",
      description:
        "Pause Progress HUD updates and active-work timing for the current tracked task. This does not stop the Codex task itself."
    },
    () => handlers.trackingPause()
  );

  server.registerTool(
    "tracking_resume",
    {
      title: "Resume HUD tracking",
      description: "Resume Progress HUD updates and active-work timing for the current tracked task."
    },
    () => handlers.trackingResume()
  );

  server.registerTool(
    "tracking_stop",
    {
      title: "Stop HUD tracking",
      description:
        "Stop Progress HUD tracking for the current task and keep its final snapshot visible. This does not stop the Codex task itself."
    },
    () => handlers.trackingStop()
  );

  server.registerTool(
    "tracking_status",
    {
      title: "Read HUD tracking status",
      description: "Read the current Progress HUD snapshot without changing it."
    },
    () => handlers.trackingStatus()
  );

  server.registerTool(
    "hud_open",
    { title: "Open Progress HUD" },
    () => handlers.hudOpen()
  );

  server.registerTool(
    "hud_hide",
    { title: "Hide Progress HUD" },
    () => handlers.hudHide()
  );

  server.registerTool(
    "hud_close",
    { title: "Close Progress HUD" },
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
