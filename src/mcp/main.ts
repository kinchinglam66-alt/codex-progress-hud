import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpProgressClient } from "./report-client.js";
import {
  createToolHandlers,
  progressReportSchema,
  taskOutcomeSchema,
  trackingStartSchema
} from "./tools.js";

const server = new McpServer({ name: "codex-progress-hud", version: "0.1.0" });
const handlers = createToolHandlers(new HttpProgressClient());

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

await server.connect(new StdioServerTransport());
